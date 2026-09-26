// tests/security.test.js — two-factor login, security headers, backups.
const test = require("node:test");
const assert = require("node:assert");
const http = require("node:http");
const path = require("node:path");

process.env.JWT_SECRET = "security-test-secret";
process.env.NODE_ENV = "test";
delete process.env.TWO_FACTOR_REQUIRED; // default: required for staff

const bcrypt = require("bcryptjs");
const totp = require("../lib/totp");

// ---------------------------------------------------------------------
// TOTP
// ---------------------------------------------------------------------
test("codes match the RFC 6238 published test values", () => {
  const secret = Buffer.from("12345678901234567890");
  for (const [t, code] of [[59, "94287082"], [1111111109, "07081804"], [1111111111, "14050471"], [1234567890, "89005924"], [2000000000, "69279037"], [20000000000, "65353130"]]) {
    assert.strictEqual(totp.hotp(secret, Math.floor(t / 30), 8), code, `t=${t}`);
  }
});

test("codes: clock drift allowed, reuse blocked, secrets encrypted, recovery codes normalised", () => {
  const s = totp.generateSecret();
  const now = Date.UTC(2026, 8, 24, 10, 0, 0);
  const prev = totp.totp(s, now - 30000);
  assert.notStrictEqual(totp.verifyTotp(s, prev, { now }), null, "previous 30s window accepted");
  assert.strictEqual(totp.verifyTotp(s, totp.totp(s, now - 90000), { now }), null, "90s old rejected");
  const step = totp.verifyTotp(s, totp.totp(s, now), { now });
  assert.strictEqual(totp.verifyTotp(s, totp.totp(s, now), { now, lastUsedStep: step }), null, "same code can't be used twice");
  assert.strictEqual(totp.base32Encode(totp.base32Decode(s)), s);
  const enc = totp.encryptSecret(s);
  assert.ok(!enc.includes(s));
  assert.strictEqual(totp.decryptSecret(enc), s);
  assert.throws(() => totp.decryptSecret(enc.replace(/.$/, (c) => (c === "A" ? "B" : "A"))), "tampering detected");
  assert.strictEqual(totp.hashRecoveryCode("ABCDE-fghjk"), totp.hashRecoveryCode("abcde fghjk"));
  assert.ok(/^otpauth:\/\/totp\/ComplyGlobally%3Aa%40b\.com\?secret=/.test(totp.otpauthUrl({ secret: s, account: "a@b.com", issuer: "ComplyGlobally" })));
});

// ---------------------------------------------------------------------
// Two-factor login, end to end (real routes + middleware, fake models)
// ---------------------------------------------------------------------
let users = [];
let id = 0;
const audit = [];
class FakeUser {
  constructor(a) {
    Object.assign(this, { _id: `u${++id}`, email: "", name: "", role: "staff", department: "", passwordHash: null, googleId: null,
      clientOrgId: null, active: true, mustSetPassword: false, tokenVersion: 0, lastLoginAt: null, failedOtpAttempts: 0, lockedUntil: null,
      totpEnabled: false, totpSecret: null, totpPendingSecret: null, totpLastUsedStep: -1, totpRecoveryCodes: [], totpFailedAttempts: 0, totpLockedUntil: null }, a);
  }
  checkPassword(p) { return bcrypt.compare(p, this.passwordHash); }
  isLocked() { return false; }
  toSafeJSON() { return { id: this._id, email: this.email, role: this.role, twoFactorEnabled: this.totpEnabled }; }
  async save() { return this; }
}
FakeUser.findOne = async (q) => users.find((u) => u.email === q.email) || null;
FakeUser.findById = async (i) => users.find((u) => String(u._id) === String(i)) || null;
FakeUser.ROLE_RANK = { client: 0, staff: 1, admin: 2, super_admin: 3 };
FakeUser.hasAtLeast = (r, m) => (FakeUser.ROLE_RANK[r] ?? -1) >= (FakeUser.ROLE_RANK[m] ?? Infinity);

const inject = (rel, exports) => { const f = require.resolve(path.join(__dirname, rel)); require.cache[f] = { id: f, filename: f, loaded: true, exports }; };
inject("../models/User.js", FakeUser);
inject("../models/LoginOtp.js", { findOne: () => ({ sort: async () => null }), create: async () => ({}), updateMany: async () => {} });
inject("../models/ClientOrg.js", { create: async () => ({ _id: "org" }), findById: async () => null });
inject("../models/Calendar.js", { findOneAndUpdate: async () => null });
inject("../lib/google.js", { getAuthUrl: () => "https://accounts.google.com/", verifyCodeAndGetProfile: async () => ({}) });
inject("../lib/auditLog.js", { logActivity: (e) => audit.push(e) });
inject("../lib/mailer.js", { fromAddress: () => "t@e.com", sendEmail: async () => ({}) });
inject("../lib/notify.js", { notifyStaff: async () => {}, notifyClient: async () => {} });

const express = require("express");
const cookieParser = require("cookie-parser");
const { securityHeaders } = require("../lib/securityHeaders");
const { requireAuth, requireRole, requirePageAuth, requirePageRole } = require("../middleware/auth");
const app = express();
app.use(securityHeaders);
app.use(express.json());
app.use(cookieParser());
const authRoutes = require("../routes/auth.routes");
app.use("/api/auth", authRoutes);
app.use("/api/admin", requireAuth, requireRole("admin"), require("../routes/admin.routes"));
app.get("/api/staff-thing", requireAuth, requireRole("staff"), (req, res) => res.json({ ok: true }));
app.get("/dashboard.html", requirePageAuth, requirePageRole("staff"), (req, res) => res.send("dashboard"));
app.get("/public", (req, res) => res.send("hello"));

let server, base;
test.before(async () => { server = http.createServer(app); await new Promise((r) => server.listen(0, r)); base = `http://127.0.0.1:${server.address().port}`; });
test.after(() => server.close());

function client() {
  const jar = new Map();
  return {
    jar,
    async req(method, p, body, { redirect = "follow" } = {}) {
      const headers = { "Content-Type": "application/json" };
      if (jar.size) headers.Cookie = [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
      const res = await fetch(base + p, { method, headers, body: body ? JSON.stringify(body) : undefined, redirect });
      for (const raw of res.headers.getSetCookie?.() || []) {
        const [pair] = raw.split(";"); const [k, ...v] = pair.split("="); const val = v.join("=");
        if (!val || /Expires=Thu, 01 Jan 1970/i.test(raw)) jar.delete(k); else jar.set(k, val);
      }
      const text = await res.text();
      let json = {}; try { json = JSON.parse(text); } catch {}
      return { status: res.status, body: json, text, location: res.headers.get("location"), headers: res.headers };
    },
  };
}

// Each test starts with a fresh login rate limit (10 per 15 min in production).
test.beforeEach(() => Object.values(authRoutes.rateLimitStores).forEach((st) => st.resetAll()));

async function staff(email, role = "staff") {
  const u = new FakeUser({ email, role, passwordHash: await bcrypt.hash("correct horse 1", 4) });
  users.push(u);
  return u;
}

async function enroll(c) {
  const setup = await c.req("POST", "/api/auth/2fa/setup");
  assert.strictEqual(setup.status, 200, JSON.stringify(setup.body));
  const secret = setup.body.secret.replace(/\s+/g, "");
  const en = await c.req("POST", "/api/auth/2fa/enable", { code: totp.totp(secret) });
  assert.strictEqual(en.status, 200, JSON.stringify(en.body));
  return { secret, recovery: en.body.recoveryCodes };
}

test("staff without two-factor must set it up before reaching anything", async () => {
  users = [];
  await staff("new@firm.com");
  const c = client();
  const login = await c.req("POST", "/api/auth/login", { email: "new@firm.com", password: "correct horse 1" });
  assert.strictEqual(login.status, 200);
  const api = await c.req("GET", "/api/staff-thing");
  assert.strictEqual(api.status, 403);
  assert.strictEqual(api.body.code, "MFA_SETUP_REQUIRED");
  const page = await c.req("GET", "/dashboard.html", null, { redirect: "manual" });
  assert.strictEqual(page.location, "/two-factor.html?setup=1");
  const { recovery } = await enroll(c);
  assert.strictEqual(recovery.length, 10);
  assert.strictEqual((await c.req("GET", "/api/staff-thing")).status, 200, "full access after setup");
});

test("with two-factor on, a password alone never gives a session", async () => {
  users = [];
  await staff("pat@firm.com");
  const c1 = client();
  await c1.req("POST", "/api/auth/login", { email: "pat@firm.com", password: "correct horse 1" });
  const { secret, recovery } = await enroll(c1);

  const c = client();
  const login = await c.req("POST", "/api/auth/login", { email: "pat@firm.com", password: "correct horse 1" });
  assert.strictEqual(login.body.redirect, "/two-factor.html");
  assert.strictEqual(login.body.mfaRequired, true);
  assert.ok(c.jar.has("cc_mfa") && !c.jar.has("cc_session"));
  const blocked = await c.req("GET", "/api/staff-thing");
  assert.strictEqual(blocked.status, 401);
  assert.strictEqual(blocked.body.code, "MFA_REQUIRED");
  const page = await c.req("GET", "/dashboard.html", null, { redirect: "manual" });
  assert.match(page.location, /^\/two-factor\.html\?next=/);

  const wrong = await c.req("POST", "/api/auth/2fa/verify", { code: "000000" });
  assert.strictEqual(wrong.status, 400);
  const ok = await c.req("POST", "/api/auth/2fa/verify", { code: totp.totp(secret, Date.now() + 30000), next: "/calendar.html?id=1" });
  assert.strictEqual(ok.status, 200, JSON.stringify(ok.body));
  assert.strictEqual(ok.body.redirect, "/calendar.html?id=1");
  assert.strictEqual((await c.req("GET", "/api/staff-thing")).status, 200);

  // A recovery code works once.
  const c2 = client();
  await c2.req("POST", "/api/auth/login", { email: "pat@firm.com", password: "correct horse 1" });
  const rec = await c2.req("POST", "/api/auth/2fa/verify", { code: recovery[0].toUpperCase() });
  assert.strictEqual(rec.status, 200);
  assert.strictEqual(rec.body.recoveryCodesLeft, 9);
  const c3 = client();
  await c3.req("POST", "/api/auth/login", { email: "pat@firm.com", password: "correct horse 1" });
  assert.strictEqual((await c3.req("POST", "/api/auth/2fa/verify", { code: recovery[0] })).status, 400, "used recovery code rejected");
});

test("five wrong codes lock the code step for 15 minutes", async () => {
  users = [];
  await staff("lock@firm.com");
  const c1 = client();
  await c1.req("POST", "/api/auth/login", { email: "lock@firm.com", password: "correct horse 1" });
  const { secret } = await enroll(c1);
  const c = client();
  await c.req("POST", "/api/auth/login", { email: "lock@firm.com", password: "correct horse 1" });
  for (let i = 0; i < 5; i++) await c.req("POST", "/api/auth/2fa/verify", { code: "111111" });
  const r = await c.req("POST", "/api/auth/2fa/verify", { code: totp.totp(secret, Date.now() + 30000) });
  assert.strictEqual(r.status, 429, "even the right code is refused while locked");
  assert.ok(audit.some((a) => a.action === "two_factor_locked"));
});

test("turning two-factor on signs out other devices; old sessions can't be reused", async () => {
  users = [];
  await staff("old@firm.com");
  const laptop = client();
  const phone = client();
  await laptop.req("POST", "/api/auth/login", { email: "old@firm.com", password: "correct horse 1" });
  await phone.req("POST", "/api/auth/login", { email: "old@firm.com", password: "correct horse 1" });
  await enroll(laptop);
  assert.strictEqual((await phone.req("GET", "/api/staff-thing")).status, 401, "other device's pre-2FA session is dead");
  assert.strictEqual((await laptop.req("GET", "/api/staff-thing")).status, 200);
});

test("an admin can reset a colleague's two-factor (lost phone); not their own", async () => {
  users = [];
  const admin = await staff("boss@firm.com", "admin");
  const worker = await staff("w@firm.com");
  const a = client();
  await a.req("POST", "/api/auth/login", { email: "boss@firm.com", password: "correct horse 1" });
  await enroll(a);
  const w = client();
  await w.req("POST", "/api/auth/login", { email: "w@firm.com", password: "correct horse 1" });
  await enroll(w);
  assert.strictEqual((await a.req("POST", `/api/admin/users/${admin._id}/reset-2fa`)).status, 400);
  const r = await a.req("POST", `/api/admin/users/${worker._id}/reset-2fa`);
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  assert.strictEqual(worker.totpEnabled, false);
  assert.strictEqual((await w.req("GET", "/api/staff-thing")).status, 401, "signed out everywhere");
});

test("clients are never asked for two-factor", async () => {
  users = [];
  users.push(new FakeUser({ email: "c@client.com", role: "client", clientOrgId: "org", passwordHash: await bcrypt.hash("correct horse 1", 4) }));
  const c = client();
  const login = await c.req("POST", "/api/auth/login", { email: "c@client.com", password: "correct horse 1" });
  assert.notStrictEqual(login.body.redirect, "/two-factor.html");
  assert.ok(c.jar.has("cc_session"));
});

// ---------------------------------------------------------------------
// Security headers
// ---------------------------------------------------------------------
test("security headers are on every response", async () => {
  const r = await client().req("GET", "/public");
  const h = r.headers;
  const csp = h.get("content-security-policy");
  assert.match(csp, /default-src 'self'/);
  assert.match(csp, /script-src [^;]*https:\/\/checkout\.razorpay\.com/);
  assert.match(csp, /frame-src https:\/\/\*\.razorpay\.com/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.match(csp, /object-src 'none'/);
  assert.strictEqual(h.get("x-frame-options"), "DENY");
  assert.strictEqual(h.get("x-content-type-options"), "nosniff");
  assert.strictEqual(h.get("referrer-policy"), "strict-origin-when-cross-origin");
  assert.match(h.get("permissions-policy"), /camera=\(\)/);
  const api = await client().req("GET", "/api/auth/2fa/status");
  assert.strictEqual(api.headers.get("cache-control"), "no-store");
  process.env.CSP_REPORT_ONLY = "true";
  try {
    const ro = await client().req("GET", "/public");
    assert.ok(ro.headers.get("content-security-policy-report-only"));
    assert.strictEqual(ro.headers.get("content-security-policy"), null);
  } finally { delete process.env.CSP_REPORT_ONLY; }
});

// ---------------------------------------------------------------------
// Backups
// ---------------------------------------------------------------------
const mongoose = require("mongoose");
const backup = require("../lib/backup");

function fakeDb(data) {
  const cols = JSON.parse(JSON.stringify(Object.keys(data))) && data;
  return {
    databaseName: "test_db",
    listCollections: () => ({ toArray: async () => Object.keys(cols).map((name) => ({ name })) }),
    collection: (name) => {
      cols[name] = cols[name] || [];
      return {
        find: () => ({ async *[Symbol.asyncIterator]() { for (const d of cols[name]) yield d; } }),
        countDocuments: async () => cols[name].length,
        deleteMany: async () => { cols[name] = []; },
        insertMany: async (docs) => { cols[name].push(...docs); },
      };
    },
    _cols: cols,
  };
}

test("a backup restores exactly: ids, dates, nested data, every collection", async () => {
  const oid = new mongoose.Types.ObjectId();
  const src = fakeDb({
    calendars: [{ _id: oid, profile: { companyName: "Acme" }, items: [{ due: new Date("2027-03-01T00:00:00Z"), fee: 12500 }] }],
    users: [{ _id: new mongoose.Types.ObjectId(), email: "a@b.com", totpSecret: "v1:enc" }],
    "system.views": [{ x: 1 }],
  });
  const { buffer, manifest } = await backup.dumpDatabase(src);
  assert.deepStrictEqual(manifest.collections, { calendars: 1, users: 1 }, "system collections skipped");
  const parsed = backup.parseBackup(buffer);
  const dst = fakeDb({});
  await backup.restoreInto(dst, parsed);
  const cal = dst._cols.calendars[0];
  assert.ok(cal._id instanceof mongoose.mongo.ObjectId);
  assert.strictEqual(String(cal._id), String(oid));
  assert.ok(cal.items[0].due instanceof Date);
  assert.strictEqual(cal.items[0].due.toISOString(), "2027-03-01T00:00:00.000Z");
  assert.strictEqual(cal.items[0].fee, 12500);
  await assert.rejects(backup.restoreInto(dst, parsed), /already has 1 documents/, "won't overwrite without --drop");
  await backup.restoreInto(dst, parsed, { drop: true });
  assert.strictEqual(dst._cols.calendars.length, 1);
});

test("the nightly backup is written to disk bit by bit and restores the same", async () => {
  const fs = require("fs");
  const many = Array.from({ length: 1200 }, (_, i) => ({ _id: new mongoose.Types.ObjectId(), n: i, at: new Date(Date.UTC(2026, 0, 1 + (i % 28))) }));
  const src = fakeDb({ notifications: many, users: [{ _id: new mongoose.Types.ObjectId(), email: "a@b.com" }] });
  const dump = await backup.dumpDatabaseToFile(src);
  try {
    assert.deepStrictEqual(dump.manifest.collections, { notifications: 1200, users: 1 });
    assert.ok(dump.bytes > 0 && dump.bytes < dump.rawBytes, "compressed");
    // Same file format as before: old restore code reads it unchanged.
    const parsed = backup.parseBackup(fs.readFileSync(dump.filePath));
    assert.strictEqual(parsed.collections.notifications.length, 1200);
    assert.strictEqual(parsed.collections.notifications[1199].n, 1199);
    assert.ok(parsed.collections.notifications[5].at instanceof Date);
  } finally {
    dump.cleanup();
  }
  assert.strictEqual(fs.existsSync(dump.filePath), false, "temporary files removed");
});

test("a damaged or foreign file is refused", () => {
  const zlib = require("zlib");
  assert.throws(() => backup.parseBackup(zlib.gzipSync('{"hello":1}\n')), /isn't a ComplyGlobally backup/);
  const truncated = zlib.gzipSync(JSON.stringify({ manifest: { format: "complyglobally-backup-v1", collections: { users: 2 } } }) + "\n" + JSON.stringify({ c: "users", d: { a: 1 } }) + "\n");
  assert.throws(() => backup.parseBackup(truncated), /incomplete/);
});

test("retention keeps 7 days, one a day for 30, one a month for a year", () => {
  const now = new Date("2026-09-24T12:00:00Z");
  const keys = [];
  for (let d = 0; d < 400; d++) {
    for (const h of [2, 14]) {
      const t = new Date(now.getTime() - d * 86400000); t.setUTCHours(h, 30, 0, 0);
      if (t <= now) keys.push(backup.stampKey(t));
    }
  }
  const doomed = new Set(backup.keysToPrune(keys, now));
  const kept = keys.filter((k) => !doomed.has(k)).map(backup.dateFromKey);
  const age = (d) => (now - d) / 86400000;
  assert.strictEqual(kept.filter((d) => age(d) <= 7).length, keys.map(backup.dateFromKey).filter((d) => age(d) <= 7).length, "everything in the last week");
  const days = new Set(kept.filter((d) => age(d) <= 30).map((d) => d.toISOString().slice(0, 10)));
  assert.ok(days.size >= 30, "a backup for each of the last 30 days");
  const months = new Set(kept.filter((d) => age(d) > 30).map((d) => d.toISOString().slice(0, 7)));
  assert.ok(months.size >= 11 && months.size <= 13, `about one per month for a year (got ${months.size})`);
  assert.ok(kept.every((d) => age(d) <= 367), "nothing older than a year");
  assert.ok(kept.length < 70, `bounded storage (${kept.length} kept of ${keys.length})`);
});
