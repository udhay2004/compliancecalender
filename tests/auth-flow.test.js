// tests/auth-flow.test.js
//
// Drives the real routes, the real middleware, the real OTP library and
// the real password policy over real HTTP. The only things replaced are
// the two Mongoose models (with in-memory stand-ins) and the mail
// transport (with a capture buffer that lets the test read the code that
// was "sent") — so what's under test here is the login logic itself, not
// a mock of it.
//
//   node --test tests/
//
// The negative cases matter more than the happy path: most login bugs
// are not "the right code was rejected", they're "some wrong thing was
// accepted".

const test = require("node:test");
const assert = require("node:assert");
const http = require("node:http");
const path = require("node:path");

process.env.JWT_SECRET = "test-secret-not-used-anywhere-real";
process.env.NODE_ENV = "test";
// These tests cover passwords and sessions; two-factor enforcement has
// its own tests in tests/security.test.js.
process.env.TWO_FACTOR_REQUIRED = "false";

// ---------------------------------------------------------------------
// In-memory stand-ins, injected through the require cache before the
// routes are loaded so they pick these up instead of the real models.
// ---------------------------------------------------------------------
const bcrypt = require("bcryptjs");

const sentEmails = [];
let users = [];
let otps = [];
let idCounter = 0;

class FakeUser {
  constructor(attrs) {
    Object.assign(this, {
      _id: `user_${++idCounter}`,
      email: "",
      name: "",
      role: "staff",
      department: "",
      passwordHash: null,
      googleId: null,
      clientOrgId: null,
      active: true,
      mustSetPassword: false,
      tokenVersion: 0,
      passwordUpdatedAt: null,
      lastLoginAt: null,
      failedOtpAttempts: 0,
      lockedUntil: null,
    }, attrs);
  }
  async setPassword(plain) {
    this.passwordHash = await bcrypt.hash(plain, 4); // low cost: tests, not production
    this.mustSetPassword = false;
    this.passwordUpdatedAt = new Date();
    this.tokenVersion = (this.tokenVersion || 0) + 1;
    this.failedOtpAttempts = 0;
    this.lockedUntil = null;
  }
  checkPassword(plain) {
    if (!this.passwordHash) return Promise.resolve(false);
    return bcrypt.compare(plain, this.passwordHash);
  }
  isLocked() { return Boolean(this.lockedUntil && this.lockedUntil > new Date()); }
  toSafeJSON() {
    return {
      id: this._id, email: this.email, name: this.name, role: this.role,
      department: this.department, clientOrgId: this.clientOrgId, active: this.active,
      mustSetPassword: this.mustSetPassword, lastLoginAt: this.lastLoginAt,
    };
  }
  async save() { return this; }
}
FakeUser.findOne = async (q) => users.find((u) => u.email === q.email) || null;
FakeUser.findById = async (id) => users.find((u) => String(u._id) === String(id)) || null;
FakeUser.ROLE_RANK = { client: 0, staff: 1, admin: 2, super_admin: 3 };
FakeUser.hasAtLeast = (role, min) =>
  (FakeUser.ROLE_RANK[role] ?? -1) >= (FakeUser.ROLE_RANK[min] ?? Infinity);

const FakeLoginOtp = {
  async create(doc) {
    const record = Object.assign({ attempts: 0, consumedAt: null, createdAt: new Date() }, doc);
    record.save = async () => record;
    otps.push(record);
    return record;
  },
  findOne(query) {
    // Only the one query shape the code actually uses.
    const matches = otps.filter(
      (o) => o.email === query.email && (query.consumedAt !== null || o.consumedAt === null)
    );
    return {
      sort: async () => matches.sort((a, b) => b.createdAt - a.createdAt)[0] || null,
      then: (resolve) => resolve(matches[0] || null),
    };
  },
  async updateMany(query, update) {
    otps
      .filter((o) => o.email === query.email && o.consumedAt === null)
      .forEach((o) => { o.consumedAt = update.$set.consumedAt; });
  },
};

function inject(relativePath, exports) {
  require.cache[require.resolve(relativePath)] = {
    id: relativePath, filename: relativePath, loaded: true, exports,
  };
}

inject(path.join(__dirname, "../models/User.js"), FakeUser);
inject(path.join(__dirname, "../models/LoginOtp.js"), FakeLoginOtp);
inject(path.join(__dirname, "../models/ClientOrg.js"), { create: async () => ({ _id: "org_1" }) });
inject(path.join(__dirname, "../models/Calendar.js"), { findOneAndUpdate: async () => null });
inject(path.join(__dirname, "../lib/google.js"), {
  getAuthUrl: () => "https://accounts.google.com/",
  verifyCodeAndGetProfile: async () => ({}),
});
inject(path.join(__dirname, "../lib/auditLog.js"), { logActivity: () => {} });
inject(path.join(__dirname, "../lib/mailer.js"), {
  fromAddress: () => "test@example.com",
  sendEmail: async (message) => { sentEmails.push(message); return { sent: "test" }; },
});

// Real from here down.
const express = require("express");
const cookieParser = require("cookie-parser");
const authRoutes = require("../routes/auth.routes");
const { requireAuth, requireRole } = require("../middleware/auth");

const app = express();
app.use(express.json());
app.use(cookieParser());
app.use("/api/auth", authRoutes);
// A stand-in for any protected page, to prove what a session can reach.
app.get("/protected", requireAuth, requireRole("staff"), (req, res) =>
  res.json({ email: req.user.email })
);

let server;
let baseUrl;

// ---------------------------------------------------------------------
// Tiny HTTP client with a cookie jar, so sessions behave like a browser.
// ---------------------------------------------------------------------
function makeClient() {
  const jar = new Map();
  return {
    jar,
    async request(method, urlPath, body) {
      const headers = { "Content-Type": "application/json" };
      if (jar.size) {
        headers.Cookie = [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
      }
      const res = await fetch(baseUrl + urlPath, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
      });
      for (const raw of res.headers.getSetCookie?.() || []) {
        const [pair] = raw.split(";");
        const idx = pair.indexOf("=");
        const name = pair.slice(0, idx);
        const value = pair.slice(idx + 1);
        if (!value || raw.includes("Expires=Thu, 01 Jan 1970")) jar.delete(name);
        else jar.set(name, value);
      }
      const data = await res.json().catch(() => ({}));
      return { status: res.status, data };
    },
    post(urlPath, body) { return this.request("POST", urlPath, body); },
    get(urlPath) { return this.request("GET", urlPath); },
  };
}

function lastCodeFor(email) {
  const mail = [...sentEmails].reverse().find((m) => m.to === email);
  if (!mail) return null;
  const match = mail.text.match(/\b(\d{6})\b/);
  return match ? match[1] : null;
}

function resetWorld() {
  // Rate limits are per-IP, and every test here comes from the same
  // loopback address — without this, test 6 onwards would be measuring
  // the limiter rather than the logic it guards. The limiter itself is
  // covered by its own test below.
  Object.values(authRoutes.rateLimitStores).forEach((store) => store.resetAll());
  users = [
    new FakeUser({ email: "tech@theconnectventures.com", name: "Tech Team", role: "staff", department: "tech", mustSetPassword: true }),
    new FakeUser({ email: "finance@theconnectventures.com", name: "Finance Team", role: "staff", department: "finance", mustSetPassword: true }),
    new FakeUser({ email: "anil.gupta@theconnectventures.com", name: "Anil Gupta", role: "super_admin", mustSetPassword: true }),
    new FakeUser({ email: "client@acme.com", name: "A Client", role: "client", clientOrgId: "org_1", passwordHash: "x" }),
  ];
  otps = [];
  sentEmails.length = 0;
}

test.before(async () => {
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server.close());
test.beforeEach(() => resetWorld());

// ---------------------------------------------------------------------
// The happy path, exactly as a new staff member experiences it
// ---------------------------------------------------------------------
test("first-time staff login: code → verify → set password → dashboard", async () => {
  const client = makeClient();
  const email = "tech@theconnectventures.com";

  const requested = await client.post("/api/auth/otp/request", { email, portal: "staff" });
  assert.strictEqual(requested.status, 200);

  const code = lastCodeFor(email);
  assert.match(code, /^\d{6}$/, "a 6-digit code should have been emailed");

  const verified = await client.post("/api/auth/otp/verify", { email, code });
  assert.strictEqual(verified.status, 200);
  assert.strictEqual(verified.data.setupRequired, true, "a brand new account must be sent to password setup");

  // The setup cookie is NOT a session: protected routes stay shut.
  const tooEarly = await client.get("/protected");
  assert.strictEqual(tooEarly.status, 401, "the setup token must not work as a session");

  const set = await client.post("/api/auth/password/set", {
    password: "Harbour-Lantern-42",
    confirmPassword: "Harbour-Lantern-42",
  });
  assert.strictEqual(set.status, 200);
  assert.strictEqual(set.data.redirect, "/dashboard.html");

  const now = await client.get("/protected");
  assert.strictEqual(now.status, 200);
  assert.strictEqual(now.data.email, email);

  const user = await FakeUser.findOne({ email });
  assert.strictEqual(user.mustSetPassword, false);
  assert.ok(user.passwordHash && user.passwordHash !== "Harbour-Lantern-42", "password must be stored hashed");
});

test("returning staff member signs in with the password they chose", async () => {
  const email = "finance@theconnectventures.com";
  const setup = makeClient();
  await setup.post("/api/auth/otp/request", { email, portal: "staff" });
  await setup.post("/api/auth/otp/verify", { email, code: lastCodeFor(email) });
  await setup.post("/api/auth/password/set", { password: "Quiet-Ledger-98", confirmPassword: "Quiet-Ledger-98" });

  const returning = makeClient();
  const ok = await returning.post("/api/auth/login", { email, password: "Quiet-Ledger-98" });
  assert.strictEqual(ok.status, 200);
  assert.strictEqual(ok.data.user.department, "finance");

  const wrong = await makeClient().post("/api/auth/login", { email, password: "Quiet-Ledger-99" });
  assert.strictEqual(wrong.status, 401);
});

test("super admin uses the same flow through its own door", async () => {
  const client = makeClient();
  const email = "anil.gupta@theconnectventures.com";
  await client.post("/api/auth/otp/request", { email, portal: "super_admin" });
  const verified = await client.post("/api/auth/otp/verify", { email, code: lastCodeFor(email) });
  assert.strictEqual(verified.data.setupRequired, true);
  const set = await client.post("/api/auth/password/set", {
    password: "Meridian-Tollgate-7",
    confirmPassword: "Meridian-Tollgate-7",
  });
  assert.strictEqual(set.data.user.role, "super_admin");
});

// ---------------------------------------------------------------------
// The cases that decide whether this is actually secure
// ---------------------------------------------------------------------
test("a staff address gets no code at the super admin door", async () => {
  const client = makeClient();
  const email = "tech@theconnectventures.com";
  const res = await client.post("/api/auth/otp/request", { email, portal: "super_admin" });
  assert.strictEqual(res.status, 200, "the reply must look identical either way");
  assert.strictEqual(lastCodeFor(email), null, "but no code may actually be sent");
});

test("an unknown address gets the same reply as a real one, and no email", async () => {
  const client = makeClient();
  const real = await client.post("/api/auth/otp/request", { email: "tech@theconnectventures.com", portal: "staff" });
  const fake = await client.post("/api/auth/otp/request", { email: "nobody@example.com", portal: "staff" });
  assert.strictEqual(real.status, fake.status);
  assert.deepStrictEqual(Object.keys(real.data).sort(), Object.keys(fake.data).sort());
  assert.strictEqual(real.data.message, fake.data.message);
  assert.strictEqual(lastCodeFor("nobody@example.com"), null);
});

test("a wrong code is rejected, and a correct one can't be replayed", async () => {
  const email = "tech@theconnectventures.com";
  const client = makeClient();
  await client.post("/api/auth/otp/request", { email, portal: "staff" });
  const code = lastCodeFor(email);

  const wrong = await client.post("/api/auth/otp/verify", { email, code: code === "000000" ? "111111" : "000000" });
  assert.strictEqual(wrong.status, 401);

  const first = await client.post("/api/auth/otp/verify", { email, code });
  assert.strictEqual(first.status, 200);

  const replay = await makeClient().post("/api/auth/otp/verify", { email, code });
  assert.strictEqual(replay.status, 401, "a consumed code must never work twice");
});

test("requesting a second code invalidates the first", async () => {
  const email = "tech@theconnectventures.com";
  const client = makeClient();
  await client.post("/api/auth/otp/request", { email, portal: "staff" });
  const firstCode = lastCodeFor(email);

  // The route refuses inside the 60s cooldown, so age the record the way
  // a real minute would.
  otps.forEach((o) => { o.createdAt = new Date(Date.now() - 120000); });
  await client.post("/api/auth/otp/request", { email, portal: "staff" });
  const secondCode = lastCodeFor(email);
  assert.notStrictEqual(firstCode, secondCode);

  const stale = await client.post("/api/auth/otp/verify", { email, code: firstCode });
  assert.strictEqual(stale.status, 401, "only the newest code may work");
});

test("an expired code is rejected", async () => {
  const email = "tech@theconnectventures.com";
  const client = makeClient();
  await client.post("/api/auth/otp/request", { email, portal: "staff" });
  const code = lastCodeFor(email);
  otps.forEach((o) => { o.expiresAt = new Date(Date.now() - 1000); });
  const res = await client.post("/api/auth/otp/verify", { email, code });
  assert.strictEqual(res.status, 401);
});

test("a client account cannot use the internal code login", async () => {
  const client = makeClient();
  await client.post("/api/auth/otp/request", { email: "client@acme.com", portal: "staff" });
  assert.strictEqual(lastCodeFor("client@acme.com"), null);
});

test("weak passwords are refused by the server, not just the browser", async () => {
  const email = "tech@theconnectventures.com";
  const client = makeClient();
  await client.post("/api/auth/otp/request", { email, portal: "staff" });
  await client.post("/api/auth/otp/verify", { email, code: lastCodeFor(email) });

  for (const bad of ["short1", "passwordpassword1", "aaaaaaaaaaaa1", "tech12345678"]) {
    const res = await client.post("/api/auth/password/set", { password: bad, confirmPassword: bad });
    assert.strictEqual(res.status, 400, `"${bad}" should have been rejected`);
  }
  const good = await client.post("/api/auth/password/set", {
    password: "Copper-Wharf-31",
    confirmPassword: "Copper-Wharf-31",
  });
  assert.strictEqual(good.status, 200);
});

test("changing a password signs every other device out", async () => {
  const email = "tech@theconnectventures.com";
  const laptop = makeClient();
  await laptop.post("/api/auth/otp/request", { email, portal: "staff" });
  await laptop.post("/api/auth/otp/verify", { email, code: lastCodeFor(email) });
  await laptop.post("/api/auth/password/set", { password: "Copper-Wharf-31", confirmPassword: "Copper-Wharf-31" });

  const phone = makeClient();
  await phone.post("/api/auth/login", { email, password: "Copper-Wharf-31" });
  assert.strictEqual((await phone.get("/protected")).status, 200);

  await laptop.post("/api/auth/password/set", {
    currentPassword: "Copper-Wharf-31",
    password: "Slate-Junction-55",
    confirmPassword: "Slate-Junction-55",
  });

  assert.strictEqual((await phone.get("/protected")).status, 401, "the other device must be signed out");
  assert.strictEqual((await laptop.get("/protected")).status, 200, "the device that made the change stays in");
});

test("changing a password requires the current one", async () => {
  const email = "tech@theconnectventures.com";
  const client = makeClient();
  await client.post("/api/auth/otp/request", { email, portal: "staff" });
  await client.post("/api/auth/otp/verify", { email, code: lastCodeFor(email) });
  await client.post("/api/auth/password/set", { password: "Copper-Wharf-31", confirmPassword: "Copper-Wharf-31" });

  const noCurrent = await client.post("/api/auth/password/set", {
    password: "Slate-Junction-55", confirmPassword: "Slate-Junction-55",
  });
  assert.strictEqual(noCurrent.status, 400);

  const wrongCurrent = await client.post("/api/auth/password/set", {
    currentPassword: "not-it-at-all-1", password: "Slate-Junction-55", confirmPassword: "Slate-Junction-55",
  });
  assert.strictEqual(wrongCurrent.status, 401);
});

test("an account with no password set cannot be password-guessed into", async () => {
  const res = await makeClient().post("/api/auth/login", {
    email: "tech@theconnectventures.com",
    password: "anything-at-all-1",
  });
  assert.strictEqual(res.status, 409);
  assert.strictEqual(res.data.needsOtp, true);
});

test("log out everywhere kills the session", async () => {
  const email = "tech@theconnectventures.com";
  const client = makeClient();
  await client.post("/api/auth/otp/request", { email, portal: "staff" });
  await client.post("/api/auth/otp/verify", { email, code: lastCodeFor(email) });
  await client.post("/api/auth/password/set", { password: "Copper-Wharf-31", confirmPassword: "Copper-Wharf-31" });
  assert.strictEqual((await client.get("/protected")).status, 200);

  await client.post("/api/auth/logout-everywhere", {});
  assert.strictEqual((await client.get("/protected")).status, 401);
});

test("the code endpoint stops handing out emails under a flood", async () => {
  const client = makeClient();
  const email = "tech@theconnectventures.com";
  let sawLimit = false;
  for (let i = 0; i < 8; i++) {
    const res = await client.post("/api/auth/otp/request", { email, portal: "staff" });
    if (res.status === 429) { sawLimit = true; break; }
  }
  assert.ok(sawLimit, "repeated code requests from one IP must start being refused");
});
