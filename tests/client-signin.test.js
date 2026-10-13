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

// ---------------------------------------------------------------------
// Generating a calendar: it is emailed, with a portal account to use or
// ignore (lib/leadDelivery.js)
// ---------------------------------------------------------------------
const { deliverCalendar, phonePassword, MAX_EMAILS_PER_DAY } = require("../lib/leadDelivery");
const { _resetMemory } = require("../lib/rateLimitStore");
const settle = () => new Promise((r) => setTimeout(r, 20));

function generated(email, phone = "+1 415 555 0100", companyName = "Northwind Ltd") {
  const c = publicCalendar(email, companyName, {
    profile: { companyName, country: "United Kingdom", state: "United Kingdom", entityType: "Private Limited Company (Ltd)", fyEnd: "Dec", incorpDate: "2021-07-15" },
    items: [
      { compliance_name: "Company Tax Return (CT600)", category: "Mandatory Annual", authority: "HMRC", due_date: "12 months after the end of the accounting period", schedule: { type: "fy_relative", monthsAfter: 12, day: "last" } },
      { compliance_name: "VAT <Registration>", category: "Event-Based", authority: "HMRC", due_date: "Within 30 days of passing the threshold", schedule: { type: "event" } },
    ],
  });
  c.leadContact.phone = phone;
  return c;
}

test("a new visitor gets the whole calendar by email, with an account: email as username, phone as password", async () => {
  _resetMemory();
  const cal = generated("nina@northwind.example");
  const out = await deliverCalendar(cal, { name: "Nina", email: "nina@northwind.example", phone: "+1 415 555 0100" });
  await settle();
  assert.deepStrictEqual(out, { emailed: true, accountCreated: true });

  const user = users.find((u) => u.email === "nina@northwind.example");
  assert.ok(user && user.role === "client" && user.clientOrgId && user.initialPassword === true);
  assert.strictEqual(cal.clientOrgId, user.clientOrgId, "the calendar is already in their portal");
  assert.strictEqual(orgs.find((o) => o._id === user.clientOrgId).name, "Northwind Ltd");

  const mail = sentEmails.find((m) => m.to === "nina@northwind.example");
  assert.match(mail.subject, /compliance calendar for Northwind Ltd/);
  for (const body of [mail.text, mail.html]) {
    assert.match(body, /Company Tax Return \(CT600\)/);
    assert.match(body, /31 Dec 20\d\d/, "the due date is in the email");
    assert.match(body, /nina@northwind\.example/);
    assert.ok(body.includes("+14155550100"), "the password is the phone number");
    assert.match(body, /login\?as=client&(amp;)?mode=password/);
    assert.match(body, /email code/i, "says how to get in if the password is forgotten");
  }
  assert.ok(mail.html.includes("VAT &lt;Registration&gt;") && !mail.html.includes("<Registration>"), "names are escaped");
  assert.strictEqual(staffNotes.length, 1);
  assert.match(staffNotes[0].body, /emailed to them/);

  // Signing in is optional, and forgiving about how the number is typed.
  assert.match(mail.text, /take every one of these deadlines off your plate/);
  assert.match(mail.html, /Message our compliance team directly/);
  for (const typed of ["+14155550100", "+1 415 555 0100", "+1 (415) 555-0100", "14155550100", "4155550100", "(415) 555-0100"]) { // with or without the country code
    const r = await makeClient().post("/api/auth/login", { email: "nina@northwind.example", password: typed });
    assert.strictEqual(r.status, 200, typed);
    assert.strictEqual(r.data.user.initialPassword, true);
  }
  assert.strictEqual((await makeClient().post("/api/auth/login", { email: "nina@northwind.example", password: "+1 415 555 0199" })).status, 401);
  assert.strictEqual((await makeClient().post("/api/auth/login", { email: "nina@northwind.example", password: "password" })).status, 401);
});

test("the phone password can be replaced, and an email code still gets them in if it's forgotten", async () => {
  _resetMemory();
  await deliverCalendar(generated("omar@example.com", "+91 99999 81613"), { name: "Omar", email: "omar@example.com", phone: "+91 99999 81613" });
  const c = makeClient();
  assert.strictEqual((await c.post("/api/auth/login", { email: "omar@example.com", password: "+919999981613" })).status, 200);
  // Choosing their own needs the current one, and follows the normal rules.
  assert.strictEqual((await c.post("/api/auth/password/set", { password: "919999981613", confirmPassword: "919999981613", currentPassword: "+919999981613" })).status, 400, "a phone number isn't accepted as a chosen password");
  const wrong = await c.post("/api/auth/password/set", { password: "Quiet-river-2026", confirmPassword: "Quiet-river-2026", currentPassword: "+91 99999 81614" });
  assert.strictEqual(wrong.status, 401);
  const ok = await c.post("/api/auth/password/set", { password: "Quiet-river-2026", confirmPassword: "Quiet-river-2026", currentPassword: "+91 99999 81613" });
  assert.strictEqual(ok.status, 200, JSON.stringify(ok.data));
  assert.strictEqual(ok.data.user.initialPassword, false);
  assert.strictEqual((await makeClient().post("/api/auth/login", { email: "omar@example.com", password: "+919999981613" })).status, 401, "the phone number no longer works");
  assert.strictEqual((await makeClient().post("/api/auth/login", { email: "omar@example.com", password: "Quiet-river-2026" })).status, 200);

  // Forgotten: an email code signs them in without the password.
  const code = makeClient();
  await code.post("/api/auth/client/code/request", { email: "omar@example.com", mode: "signin" });
  assert.strictEqual((await code.post("/api/auth/client/code/verify", { email: "omar@example.com", code: lastCodeFor("omar@example.com"), mode: "signin" })).status, 200);
});

test("an existing account is never changed by someone generating a calendar with its email", async () => {
  _resetMemory();
  const owner = users.find((u) => u.email === "owner@acme.com");
  await owner.setPassword("Blue-harbour-2026");
  const before = { hash: owner.passwordHash, version: owner.tokenVersion };

  const cal = generated("owner@acme.com", "+1 999 000 1234", "Somebody Else Inc");
  const out = await deliverCalendar(cal, { name: "Mallory", email: "owner@acme.com", phone: "+1 999 000 1234" });
  await settle();
  assert.deepStrictEqual(out, { emailed: true, accountCreated: false });
  assert.deepStrictEqual({ hash: owner.passwordHash, version: owner.tokenVersion }, before, "password and sessions untouched");
  assert.ok(!owner.initialPassword);
  assert.strictEqual(cal.clientOrgId, null, "not put in their portal until they sign in themselves");
  assert.strictEqual((await makeClient().post("/api/auth/login", { email: "owner@acme.com", password: "+19990001234" })).status, 401);

  const mail = sentEmails.find((m) => m.to === "owner@acme.com");
  assert.match(mail.text, /already have a portal/);
  assert.match(mail.text, /Password: the password you chose/);
  assert.ok(!mail.text.includes("9990001234") && !mail.html.includes("9990001234"), "the phone typed into the form is not in the email");

  // Their own sign-in brings the calendar in.
  const login = await makeClient().post("/api/auth/login", { email: "owner@acme.com", password: "Blue-harbour-2026" });
  assert.strictEqual(login.status, 200);
  assert.strictEqual(login.data.redirect, `/portal?calendar=${cal._id}`);
  assert.strictEqual(cal.clientOrgId, "org_acme");

  // A team address gets the calendar and nothing about signing in.
  sentEmails.length = 0;
  const staffCal = generated("tech@theconnectventures.com");
  await deliverCalendar(staffCal, { name: "T", email: "tech@theconnectventures.com", phone: "+1 415 555 0100" });
  await settle();
  const staffMail = sentEmails.find((m) => m.to === "tech@theconnectventures.com");
  assert.ok(staffMail && !/portal/i.test(staffMail.text));
  assert.strictEqual(users.find((u) => u.email === "tech@theconnectventures.com").role, "staff");
});

test("one inbox gets a limited number of calendar emails a day; a failing mail server doesn't lose the calendar", async () => {
  _resetMemory();
  for (let i = 0; i < MAX_EMAILS_PER_DAY; i++) {
    assert.strictEqual((await deliverCalendar(generated("flood@example.com"), { name: "F", email: "flood@example.com", phone: "+1 415 555 0100" })).emailed, true);
  }
  assert.strictEqual((await deliverCalendar(generated("flood@example.com"), { name: "F", email: "flood@example.com", phone: "+1 415 555 0100" })).emailed, false);
  await settle();
  assert.strictEqual(sentEmails.filter((m) => m.to === "flood@example.com").length, MAX_EMAILS_PER_DAY);
  assert.strictEqual(users.filter((u) => u.email === "flood@example.com").length, 1, "one account, not one per calendar");
  assert.strictEqual(phonePassword(" +44 (0)20 7946-0958 "), "+4402079460958");
});

test("an account that never set a password signs in with the phone number on its record", async () => {
  _resetMemory();
  const owner = users.find((u) => u.email === "owner@acme.com"); // only ever used email codes
  const acme = orgs.find((o) => o._id === "org_acme");
  assert.strictEqual(owner.passwordHash, null);

  // No phone on file: there is nothing to sign in with but an email code.
  const none = await makeClient().post("/api/auth/login", { email: "owner@acme.com", password: "+1 415 555 0100" });
  assert.strictEqual(none.status, 409);
  assert.strictEqual(none.data.needsOtp, true);

  // With a phone on the company record, that number is the password.
  acme.primaryContactPhone = "+91 98765 43210";
  owner.tokenVersion = 4;
  const wrong = await makeClient().post("/api/auth/login", { email: "owner@acme.com", password: "+91 98765 43211" });
  assert.strictEqual(wrong.status, 401);
  assert.strictEqual(wrong.data.needsOtp, true, "the page can offer an email code");
  assert.strictEqual(owner.passwordHash, null, "a wrong guess changes nothing");
  assert.strictEqual((await makeClient().post("/api/auth/login", { email: "owner@acme.com", password: "Blue-harbour-2026" })).status, 401);

  const c = makeClient();
  const ok = await c.post("/api/auth/login", { email: "owner@acme.com", password: "98765 43210" });
  assert.strictEqual(ok.status, 200, JSON.stringify(ok.data));
  assert.strictEqual(ok.data.redirect, "/portal");
  assert.strictEqual(ok.data.user.initialPassword, true);
  assert.strictEqual(owner.tokenVersion, 4, "other devices stay signed in");
  assert.strictEqual((await c.get("/api/auth/me")).status, 200);
  assert.strictEqual((await makeClient().post("/api/auth/login", { email: "owner@acme.com", password: "+919876543210" })).status, 200, "and again");

  // The email for a new calendar tells them so.
  sentEmails.length = 0;
  await deliverCalendar(generated("owner@acme.com", "+1 999 000 1234"), { name: "O", email: "owner@acme.com", phone: "+1 999 000 1234" });
  await settle();
  assert.match(sentEmails.find((m) => m.to === "owner@acme.com").text, /Password: the phone number on your account/);

  // Team accounts are never signed in by phone number.
  assert.notStrictEqual((await makeClient().post("/api/auth/login", { email: "tech@theconnectventures.com", password: "+91 98765 43210" })).status, 200);
});

test("a phone number typed by a stranger never becomes the way into someone's account", async () => {
  _resetMemory();
  const owner = users.find((u) => u.email === "owner@acme.com");
  const acme = orgs.find((o) => o._id === "org_acme");
  // A stranger generates a calendar with the owner's email and their own phone.
  const cal = generated("owner@acme.com", "+1 202 555 0147", "Stranger Co");
  await deliverCalendar(cal, { name: "Mallory", email: "owner@acme.com", phone: "+1 202 555 0147" });
  await settle();
  assert.match(sentEmails.find((m) => m.to === "owner@acme.com").text, /Sign in with an email code/);
  assert.strictEqual((await makeClient().post("/api/auth/login", { email: "owner@acme.com", password: "+12025550147" })).status, 409);

  // The owner signs in with a code; the calendar joins their portal, but
  // the stranger's phone number does not go onto the company record.
  const c = makeClient();
  await c.post("/api/auth/client/code/request", { email: "owner@acme.com", mode: "signin" });
  assert.strictEqual((await c.post("/api/auth/client/code/verify", { email: "owner@acme.com", code: lastCodeFor("owner@acme.com"), mode: "signin" })).status, 200);
  assert.strictEqual(cal.clientOrgId, "org_acme");
  assert.ok(!acme.primaryContactPhone, "phone not taken from a calendar matched by email alone");
  assert.strictEqual((await makeClient().post("/api/auth/login", { email: "owner@acme.com", password: "+12025550147" })).status, 409);
  assert.strictEqual(owner.passwordHash, null);
});
