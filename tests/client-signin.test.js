// tests/client-signin.test.js
//
// Client sign-in / sign-up by email code and by Google, and collecting the
// calendars someone generated before they had an account. Real routes,
// middleware and OTP library over real HTTP; only the models, mail and
// Google are replaced with in-memory stand-ins (same approach as
// tests/auth-flow.test.js).

const test = require("node:test");
const assert = require("node:assert");
const http = require("node:http");
const path = require("node:path");

process.env.JWT_SECRET = "test-secret-not-used-anywhere-real";
process.env.NODE_ENV = "test";
process.env.TWO_FACTOR_REQUIRED = "false";

const sentEmails = [];
let users = [];
let otps = [];
let orgs = [];
let calendars = [];
let staffNotes = [];
let googleProfile = null;
let idCounter = 0;
const hexId = () => (++idCounter).toString(16).padStart(24, "0");

// The real account rules (models/User.js validation), password hashing and
// safe JSON, on top of the in-memory store: a stand-in that skipped them
// once hid a bug where accounts made by email code failed to save.
const mongoose = require("mongoose");
const RealUser = require("../models/User");
async function validateLikeTheDatabase(u) {
  const { _id, ...fields } = u;
  const doc = new RealUser({ ...fields, clientOrgId: u.clientOrgId ? new mongoose.Types.ObjectId() : null });
  await doc.validate();
}

class FakeUser {
  constructor(attrs) {
    Object.assign(this, {
      _id: hexId(), email: "", name: "", role: "client", clientOrgId: null, googleId: undefined,
      active: true, mustSetPassword: false, tokenVersion: 0, failedOtpAttempts: 0, lockedUntil: null,
      passwordHash: null, lastLoginAt: null,
    }, attrs);
  }
  isLocked() { return Boolean(this.lockedUntil && this.lockedUntil > new Date()); }
  checkPassword(pw) { return RealUser.schema.methods.checkPassword.call(this, pw); }
  setPassword(pw) { return RealUser.schema.methods.setPassword.call(this, pw); }
  toSafeJSON() { return RealUser.schema.methods.toSafeJSON.call(this); }
  async save() { await validateLikeTheDatabase(this); return this; }
}
FakeUser.findOne = async (q) => users.find((u) => (q.email !== undefined ? u.email === q.email : u.googleId === q.googleId)) || null;
FakeUser.findById = async (id) => users.find((u) => String(u._id) === String(id)) || null;
FakeUser.create = async (attrs) => {
  if (users.some((u) => u.email === attrs.email)) { const e = new Error("dup"); e.code = 11000; throw e; }
  const u = new FakeUser(attrs);
  await validateLikeTheDatabase(u);
  users.push(u);
  return u;
};
FakeUser.ROLE_RANK = { client: 0, staff: 1, admin: 2, super_admin: 3 };
FakeUser.hasAtLeast = (role, min) => (FakeUser.ROLE_RANK[role] ?? -1) >= (FakeUser.ROLE_RANK[min] ?? Infinity);

const FakeLoginOtp = {
  async create(doc) {
    const record = Object.assign({ attempts: 0, consumedAt: null, createdAt: new Date() }, doc);
    record.save = async () => record;
    otps.push(record);
    return record;
  },
  findOne(query) {
    const matches = otps.filter((o) => o.email === query.email && o.consumedAt === null);
    return { sort: async () => matches.sort((a, b) => b.createdAt - a.createdAt)[0] || null };
  },
  async updateMany(query, update) {
    otps.filter((o) => o.email === query.email && o.consumedAt === null).forEach((o) => { o.consumedAt = update.$set.consumedAt; });
  },
};

const FakeClientOrg = {
  async create(attrs) { const o = { _id: hexId(), ...attrs, save: async () => o }; orgs.push(o); return o; },
  async deleteOne(q) { orgs = orgs.filter((o) => o._id !== q._id); },
  async findById(id) { return orgs.find((o) => String(o._id) === String(id)) || null; },
};

const FakeCalendar = {
  find(q) {
    let rows = calendars.filter((c) => c.leadContact?.email === q["leadContact.email"] && c.source === q.source && c.clientOrgId === q.clientOrgId);
    const chain = {
      select() { return chain; },
      sort() { rows = [...rows].sort((a, b) => b.createdAt - a.createdAt); return chain; },
      limit(n) { return Promise.resolve(rows.slice(0, n)); },
    };
    return chain;
  },
  async findOneAndUpdate(q, update) {
    const c = calendars.find((x) => String(x._id) === String(q._id) && x.source === q.source && x.clientOrgId === q.clientOrgId);
    if (!c) return null;
    Object.assign(c, update.$set);
    return c;
  },
};

function inject(relativePath, exports) {
  require.cache[require.resolve(relativePath)] = { id: relativePath, filename: relativePath, loaded: true, exports };
}
inject(path.join(__dirname, "../models/User.js"), FakeUser);
inject(path.join(__dirname, "../models/LoginOtp.js"), FakeLoginOtp);
inject(path.join(__dirname, "../models/ClientOrg.js"), FakeClientOrg);
inject(path.join(__dirname, "../models/Calendar.js"), FakeCalendar);
inject(path.join(__dirname, "../lib/notify.js"), { notifyStaff: (n) => staffNotes.push(n), notifyClient: () => {} });
inject(path.join(__dirname, "../lib/google.js"), {
  getAuthUrl: (state) => `https://accounts.google.com/?state=${state}`,
  verifyCodeAndGetProfile: async () => googleProfile,
});
inject(path.join(__dirname, "../lib/auditLog.js"), { logActivity: () => {} });
inject(path.join(__dirname, "../lib/mailer.js"), {
  fromAddress: () => "test@example.com",
  sendEmail: async (message) => { sentEmails.push(message); return { sent: "test" }; },
});

const express = require("express");
const cookieParser = require("cookie-parser");
const authRoutes = require("../routes/auth.routes");
const otp = require("../lib/otp");

const app = express();
app.use(express.json());
app.use(cookieParser());
app.use("/api/auth", authRoutes);

let server;
let baseUrl;

function makeClient() {
  const jar = new Map();
  return {
    async request(method, urlPath, body) {
      const headers = { "Content-Type": "application/json" };
      if (jar.size) headers.Cookie = [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
      const res = await fetch(baseUrl + urlPath, { method, headers, body: body ? JSON.stringify(body) : undefined, redirect: "manual" });
      for (const raw of res.headers.getSetCookie?.() || []) {
        const [pair] = raw.split(";");
        const idx = pair.indexOf("=");
        const name = pair.slice(0, idx);
        const value = pair.slice(idx + 1);
        if (!value || raw.includes("Expires=Thu, 01 Jan 1970")) jar.delete(name);
        else jar.set(name, value);
      }
      const data = await res.json().catch(() => ({}));
      return { status: res.status, data, location: res.headers.get("location") };
    },
    post(p, b) { return this.request("POST", p, b); },
    get(p) { return this.request("GET", p); },
  };
}

function lastCodeFor(email) {
  const mail = [...sentEmails].reverse().find((m) => m.to === email);
  const match = mail && mail.text.match(/\b(\d{6})\b/);
  return match ? match[1] : null;
}

function publicCalendar(email, companyName, extra = {}) {
  const c = { _id: hexId(), source: "public", clientOrgId: null, status: "pending_review", createdAt: new Date(Date.now() - calendars.length * 1000), profile: { companyName }, items: [{}, {}], leadContact: { email, name: "Lead", phone: "+14155550100" }, ...extra };
  calendars.push(c);
  return c;
}

test.before(async () => {
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server.close());
test.beforeEach(() => {
  Object.values(authRoutes.rateLimitStores).forEach((store) => store.resetAll());
  users = [
    new FakeUser({ email: "owner@acme.com", name: "Acme Owner", role: "client", clientOrgId: "org_acme" }),
    new FakeUser({ email: "tech@theconnectventures.com", name: "Tech", role: "staff" }),
  ];
  orgs = [{ _id: "org_acme", name: "Acme", save: async () => {} }];
  otps = [];
  calendars = [];
  staffNotes = [];
  sentEmails.length = 0;
  googleProfile = null;
});

test("signing in with an email that has no account says so and sends nothing", async () => {
  const r = await makeClient().post("/api/auth/client/code/request", { email: "nobody@example.com", mode: "signin" });
  assert.strictEqual(r.status, 404);
  assert.strictEqual(r.data.code, "NO_ACCOUNT");
  assert.match(r.data.error, /no account/i);
  assert.match(r.data.error, /create your account/i);
  assert.strictEqual(sentEmails.length, 0);
});

test("creating an account with an email that's already registered points to sign in", async () => {
  const r = await makeClient().post("/api/auth/client/code/request", { email: "OWNER@acme.com ", mode: "signup" });
  assert.strictEqual(r.status, 409);
  assert.strictEqual(r.data.code, "ACCOUNT_EXISTS");
  assert.strictEqual(sentEmails.length, 0);
});

test("a team email at the client door is sent to staff login, with no code", async () => {
  const r = await makeClient().post("/api/auth/client/code/request", { email: "tech@theconnectventures.com", mode: "signin" });
  assert.strictEqual(r.status, 403);
  assert.strictEqual(r.data.code, "TEAM_ACCOUNT");
  assert.strictEqual(sentEmails.length, 0);
});

test("an invalid email address is rejected", async () => {
  const r = await makeClient().post("/api/auth/client/code/request", { email: "not-an-email", mode: "signin" });
  assert.strictEqual(r.status, 400);
});

test("a new client creates an account by email code and lands in their portal", async () => {
  const c = makeClient();
  const req = await c.post("/api/auth/client/code/request", { email: "new@beta.io", mode: "signup" });
  assert.strictEqual(req.status, 200);
  const code = lastCodeFor("new@beta.io");
  assert.ok(code, "a code was emailed");

  const noName = await c.post("/api/auth/client/code/verify", { email: "new@beta.io", code, mode: "signup", name: "  " });
  assert.strictEqual(noName.status, 400, "a name is required");

  const ok = await c.post("/api/auth/client/code/verify", { email: "new@beta.io", code, mode: "signup", name: "Bea Ta", companyName: "Beta Labs" });
  assert.strictEqual(ok.status, 200);
  assert.strictEqual(ok.data.created, true);
  assert.strictEqual(ok.data.redirect, "/portal");
  const user = users.find((u) => u.email === "new@beta.io");
  assert.strictEqual(user.role, "client");
  assert.strictEqual(user.name, "Bea Ta");
  assert.strictEqual(orgs.find((o) => o._id === user.clientOrgId).name, "Beta Labs");

  const me = await c.get("/api/auth/me");
  assert.strictEqual(me.status, 200);
  assert.strictEqual(me.data.user.email, "new@beta.io");
});

test("an existing client signs in by email code", async () => {
  const c = makeClient();
  assert.strictEqual((await c.post("/api/auth/client/code/request", { email: "owner@acme.com", mode: "signin" })).status, 200);
  const bad = await c.post("/api/auth/client/code/verify", { email: "owner@acme.com", code: "000000", mode: "signin" });
  if (lastCodeFor("owner@acme.com") !== "000000") assert.strictEqual(bad.status, 401);
  const ok = await c.post("/api/auth/client/code/verify", { email: "owner@acme.com", code: lastCodeFor("owner@acme.com"), mode: "signin" });
  assert.strictEqual(ok.status, 200);
  assert.strictEqual(ok.data.created, false);
  assert.strictEqual(ok.data.redirect, "/portal");
  assert.strictEqual((await c.get("/api/auth/me")).data.user.email, "owner@acme.com");
});

test("a sign-up code can't be used to sign in, and a sign-in code can't create an account", async () => {
  const signupCode = await otp.issueCode({ email: "x@y.io", user: null, purpose: "client_signup" });
  assert.strictEqual((await otp.verifyCode({ email: "x@y.io", code: signupCode, purpose: "login" })).ok, false);
  const loginCode = await otp.issueCode({ email: "z@y.io", user: null, purpose: "login" });
  assert.strictEqual((await otp.verifyCode({ email: "z@y.io", code: loginCode, purpose: "client_signup" })).ok, false);
  assert.strictEqual((await otp.verifyCode({ email: "z@y.io", code: loginCode, purpose: "login" })).ok, true);
});

test("the code email never repeats the name typed into the sign-up form", async () => {
  await makeClient().post("/api/auth/client/code/request", { email: "victim@example.com", mode: "signup", name: "<a href=//evil>Click</a>" });
  const mail = sentEmails.find((m) => m.to === "victim@example.com");
  assert.ok(mail);
  assert.ok(!/evil|Click/.test(mail.html + mail.text));
});

test("every calendar generated with the email before sign-up is saved to the new account", async () => {
  const fromButton = publicCalendar("someone-else@x.com", "Clicked Co");
  const a = publicCalendar("multi@owner.com", "Alpha LLC");
  const b = publicCalendar("multi@owner.com", "Bravo Inc");
  const taken = publicCalendar("multi@owner.com", "Taken", { clientOrgId: "org_other" });

  const c = makeClient();
  await c.post("/api/auth/client/code/request", { email: "multi@owner.com", mode: "signup" });
  const ok = await c.post("/api/auth/client/code/verify", {
    email: "multi@owner.com", code: lastCodeFor("multi@owner.com"), mode: "signup", name: "Multi Owner", calendarId: fromButton._id,
  });
  assert.strictEqual(ok.status, 200);
  const user = users.find((u) => u.email === "multi@owner.com");
  for (const cal of [fromButton, a, b]) {
    assert.strictEqual(cal.clientOrgId, user.clientOrgId, `${cal.profile.companyName} belongs to the new account`);
    assert.strictEqual(cal.status, "approved");
  }
  assert.strictEqual(taken.clientOrgId, "org_other", "a calendar someone already owns is never moved");
  assert.strictEqual(ok.data.calendarsSaved, 3);
  assert.strictEqual(ok.data.redirect, `/portal?calendar=${fromButton._id}`, "opens the calendar they came from");
  assert.strictEqual(staffNotes.length, 3);
});

test("an existing client signing in also collects calendars generated with their email", async () => {
  const later = publicCalendar("owner@acme.com", "Acme Europe");
  const c = makeClient();
  await c.post("/api/auth/client/code/request", { email: "owner@acme.com", mode: "signin" });
  const ok = await c.post("/api/auth/client/code/verify", { email: "owner@acme.com", code: lastCodeFor("owner@acme.com"), mode: "signin" });
  assert.strictEqual(ok.status, 200);
  assert.strictEqual(later.clientOrgId, "org_acme");
  assert.strictEqual(ok.data.redirect, `/portal?calendar=${later._id}`);
});

test("Google on the Sign in tab with an unknown account goes to Create account, and creates nothing", async () => {
  googleProfile = { googleId: "g-123", email: "fresh@gmail.com", name: "Fresh" };
  const c = makeClient();
  const start = await c.get("/api/auth/google?intent=signin");
  assert.strictEqual(start.status, 302);
  const state = new URL(start.location).searchParams.get("state");
  const back = await c.get(`/api/auth/google/callback?code=abc&state=${state}`);
  assert.strictEqual(back.status, 302);
  assert.strictEqual(back.location, "/login?as=client&mode=signup&reason=no_account_google");
  assert.ok(!users.some((u) => u.email === "fresh@gmail.com"));
});

test("Google from Create account (or after generating a calendar) creates the account", async () => {
  googleProfile = { googleId: "g-456", email: "gnew@gmail.com", name: "G New" };
  const cal = publicCalendar("gnew@gmail.com", "G Co");
  const c = makeClient();
  const start = await c.get(`/api/auth/google?calendarId=${cal._id}`);
  const state = new URL(start.location).searchParams.get("state");
  const back = await c.get(`/api/auth/google/callback?code=abc&state=${state}`);
  assert.strictEqual(back.status, 302);
  assert.strictEqual(back.location, `/portal?calendar=${cal._id}`);
  const user = users.find((u) => u.email === "gnew@gmail.com");
  assert.ok(user && user.role === "client" && user.googleId === "g-456");
  assert.strictEqual(cal.clientOrgId, user.clientOrgId);
});

test("Google sign-in for an existing client still works from the Sign in tab", async () => {
  googleProfile = { googleId: "g-acme", email: "owner@acme.com", name: "Acme Owner" };
  const c = makeClient();
  const start = await c.get("/api/auth/google?intent=signin");
  const state = new URL(start.location).searchParams.get("state");
  const back = await c.get(`/api/auth/google/callback?code=abc&state=${state}`);
  assert.strictEqual(back.location, "/portal");
  assert.strictEqual(users.find((u) => u.email === "owner@acme.com").googleId, "g-acme");
});

test("a client adds a password in the portal, and the next sign-in can use it", async () => {
  const c = makeClient();
  const noPassword = await c.post("/api/auth/login", { email: "owner@acme.com", password: "anything-at-all-1" });
  assert.strictEqual(noPassword.status, 409, "told to use a code first");
  assert.strictEqual(noPassword.data.needsOtp, true);

  await c.post("/api/auth/client/code/request", { email: "owner@acme.com", mode: "signin" });
  const signedIn = await c.post("/api/auth/client/code/verify", { email: "owner@acme.com", code: lastCodeFor("owner@acme.com"), mode: "signin" });
  assert.strictEqual(signedIn.data.user.hasPassword, false);

  // The first password needs no "current password": there isn't one.
  const set = await c.post("/api/auth/password/set", { password: "Blue-harbour-2026", confirmPassword: "Blue-harbour-2026" });
  assert.strictEqual(set.status, 200, JSON.stringify(set.data));
  assert.strictEqual(set.data.user.hasPassword, true);
  assert.strictEqual(set.data.redirect, "/portal");
  assert.strictEqual((await c.get("/api/auth/me")).status, 200, "still signed in on this device");

  // A new browser: the password works, a wrong one doesn't.
  const other = makeClient();
  assert.strictEqual((await other.post("/api/auth/login", { email: "owner@acme.com", password: "wrong-password-99" })).status, 401);
  const login = await other.post("/api/auth/login", { email: "owner@acme.com", password: "Blue-harbour-2026" });
  assert.strictEqual(login.status, 200);
  assert.strictEqual(login.data.redirect, "/portal");
  assert.strictEqual(login.data.user.hasPassword, true);

  // Changing it now needs the current one; email codes keep working.
  assert.strictEqual((await other.post("/api/auth/password/set", { password: "Green-harbour-2027", confirmPassword: "Green-harbour-2027" })).status, 400);
  assert.strictEqual((await other.post("/api/auth/password/set", { password: "Green-harbour-2027", confirmPassword: "Green-harbour-2027", currentPassword: "Blue-harbour-2026" })).status, 200);
  const code = makeClient();
  await code.post("/api/auth/client/code/request", { email: "owner@acme.com", mode: "signin" });
  assert.strictEqual((await code.post("/api/auth/client/code/verify", { email: "owner@acme.com", code: lastCodeFor("owner@acme.com"), mode: "signin" })).status, 200);
  assert.strictEqual((await code.post("/api/auth/login", { email: "owner@acme.com", password: "Green-harbour-2027" })).status, 200, "the password is kept after a code sign-in");
});

test("clients may have no password; team accounts always need a way in", async () => {
  const client = new RealUser({ email: "a@b.io", role: "client", clientOrgId: new mongoose.Types.ObjectId() });
  await client.validate();
  const staff = new RealUser({ email: "s@b.io", role: "staff" });
  await assert.rejects(staff.validate(), /passwordHash, a googleId, or mustSetPassword/);
});
