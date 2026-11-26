// tests/leads.test.js
//
// GET /api/leads (routes/leads.routes.js): every team account — tech,
// finance, operations, admin, super_admin — sees everyone who generated a
// calendar on the public page; clients and logged-out visitors don't.
// Models and the session check are in-memory stand-ins.
//
//   node --test tests/

const test = require("node:test");
const assert = require("node:assert");
const http = require("node:http");
const path = require("node:path");
const express = require("express");

process.env.NODE_ENV = "test";
const root = path.join(__dirname, "..");
const stub = (rel, exports) => {
  const file = require.resolve(path.join(root, rel));
  require.cache[file] = { id: file, filename: file, loaded: true, exports };
};
const query = (fn) => {
  const q = { sort: () => q, select: () => q, limit: () => q, lean: () => q, then: (a, b) => Promise.resolve(fn()).then(a, b) };
  return q;
};

const DAY = 86400000;
const calendars = [
  { _id: "c1", source: "public", createdAt: new Date(Date.now() - 2 * DAY), clientOrgId: "org1",
    profile: { companyName: "Acme Inc", state: "Delaware", entityType: "Corporation" },
    leadContact: { name: "Lee Lead", email: "lee@example.com", phone: "+1 415 555 0100", unlockedAt: new Date(Date.now() - 2 * DAY) },
    items: [{ selectedByClient: true, paymentStatus: "Paid" }, { selectedByClient: false }] },
  { _id: "c2", source: "public", createdAt: new Date(Date.now() - 20 * DAY), clientOrgId: null,
    profile: { companyName: "Beta Ltd", country: "United Kingdom", state: "", entityType: "Private limited company" },
    leadContact: { name: "", email: "bee@example.co.uk", phone: "+44 20 7946 0000", unlockedAt: new Date(Date.now() - 20 * DAY) },
    items: [{}, {}, {}] },
];
let lastQuery = null;
stub("models/Calendar.js", { find: (q) => { lastQuery = q; return query(() => calendars); } });
stub("models/User.js", { find: () => query(() => [{ email: "lee@example.com", lastLoginAt: new Date(Date.now() - DAY) }]) });

const ROLE_RANK = { client: 0, staff: 1, admin: 2, super_admin: 3 };
stub("middleware/auth.js", {
  requireAuth: (req, res, next) => {
    const role = req.headers["x-role"];
    if (!role) return res.status(401).json({ error: "Not logged in." });
    req.user = { role, department: req.headers["x-dept"] || "" };
    next();
  },
  requireRole: (min) => (req, res, next) => (ROLE_RANK[req.user.role] >= ROLE_RANK[min] ? next() : res.status(403).json({ error: "no" })),
});

const app = express();
app.use("/api/leads", require("../routes/leads.routes"));
const server = http.createServer(app);
let base;
test.before(() => new Promise((r) => server.listen(0, () => { base = `http://127.0.0.1:${server.address().port}`; r(); })));
test.after(() => server.close());
const get = async (url, headers = {}) => {
  const res = await fetch(base + url, { headers });
  return { status: res.status, body: await res.json() };
};

test("leads: every team account can see them; clients and visitors can't", async () => {
  for (const [role, dept] of [["staff", "tech"], ["staff", "finance"], ["staff", "operations"], ["admin", ""], ["super_admin", ""]]) {
    const r = await get("/api/leads", { "x-role": role, "x-dept": dept });
    assert.strictEqual(r.status, 200, `${role}/${dept}`);
    assert.strictEqual(r.body.leads.length, 2);
  }
  assert.strictEqual((await get("/api/leads", { "x-role": "client" })).status, 403);
  assert.strictEqual((await get("/api/leads")).status, 401);
});

test("leads: each row has the contact, company, and how far they got", async () => {
  const r = await get("/api/leads", { "x-role": "staff", "x-dept": "operations" });
  const [lee, bee] = r.body.leads;
  assert.deepStrictEqual(
    { name: lee.name, email: lee.email, phone: lee.phone, company: lee.company, filings: lee.filings, servicesChosen: lee.servicesChosen, paid: lee.paid, hasAccount: lee.hasAccount, signedIn: Boolean(lee.signedInAt), calendarId: lee.calendarId },
    { name: "Lee Lead", email: "lee@example.com", phone: "+1 415 555 0100", company: "Acme Inc", filings: 2, servicesChosen: 1, paid: 1, hasAccount: true, signedIn: true, calendarId: "c1" }
  );
  assert.strictEqual(bee.country, "United Kingdom");
  assert.strictEqual(bee.hasAccount, false);
  assert.strictEqual(bee.signedInAt, null);
  assert.deepStrictEqual(r.body.counts, { total: 2, lastWeek: 1, signedIn: 1, choseServices: 1 });
});

test("leads: only public-page calendars with contact details; search is literal text", async () => {
  await get("/api/leads?q=" + encodeURIComponent("a.c+(me"), { "x-role": "staff" });
  assert.strictEqual(lastQuery.source, "public");
  assert.deepStrictEqual(lastQuery.leadContact, { $ne: null });
  const re = lastQuery.$or[0]["leadContact.name"];
  assert.ok(re.test("xa.c+(mex"));
  assert.ok(!re.test("abc+(me"), "regex characters in the search are not treated as patterns");
});
