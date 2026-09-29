// tests/calendar-tiers.test.js
//
// The levels of calendar:
//   1. signed out: the basic calendar (the nearest few filings in full);
//   2. signed in, form not finished: the calendar so far, growing with
//      each answer (POST /api/public/preview);
//   3. every question answered: the comprehensive calendar;
// and the staff list of everything due, customers and leads alike
// (GET /api/dashboard/due).
//
//   node --test tests/

const test = require("node:test");
const assert = require("node:assert");
const http = require("node:http");
const path = require("node:path");

process.env.JWT_SECRET = "test-secret";
process.env.NODE_ENV = "test";

const root = path.join(__dirname, "..");
const stub = (rel, exports) => {
  const file = require.resolve(path.join(root, rel));
  require.cache[file] = { id: file, filename: file, loaded: true, exports };
};

const { checkProfile } = require("../lib/countries");
const db = require("../lib/complianceDb");
const D = require("../lib/deadlines");

// ---------------------------------------------------------------------
// The calendar that grows as the form is filled in
// ---------------------------------------------------------------------
const FINISHED = [
  { country: "United States", state: "California", entityType: "LLC", taxStatus: "Partnership", hasEmployees: "Yes", employeeStates: ["Texas", "New York"] },
  { country: "United States", state: "Delaware", entityType: "Corporation", taxStatus: "S-Corp", hasEmployees: "No" },
  { country: "Canada", entityType: "Corporation", incorporation: "Federal", state: "Ontario", operatingRegions: ["Quebec", "Nunavut"], salesTax: "Quarterly", hasEmployees: "Yes" },
  { country: "Canada", entityType: "Sole Proprietorship", state: "British Columbia", salesTax: "Not registered", hasEmployees: "No" },
  { country: "United Kingdom", entityType: "Private Limited Company (Ltd)", vat: "Quarterly", hasEmployees: "Yes" },
  { country: "Singapore", entityType: "Private Limited Company (Pte Ltd)", gst: "Monthly", hasEmployees: "Yes" },
  { country: "United Arab Emirates", state: "Dubai", zoneType: "Free Zone", freeZone: "DMCC", entityType: "Free Zone Company (FZE/FZCO)", vat: "Quarterly", hasEmployees: "Yes" },
  { country: "United Arab Emirates", state: "Abu Dhabi", zoneType: "Mainland", entityType: "Mainland LLC", vat: "Monthly", hasEmployees: "Yes", employeeBand: "50 or more" },
  { country: "Germany", entityType: "GmbH", vat: "Monthly", hasEmployees: "Yes" },
];
// The order the questions are asked in (lib/countries.js).
const ORDER = ["state", "zoneType", "freeZone", "entityType", "incorporation", "taxStatus", "operatingRegions", "salesTax", "vat", "gst", "hasEmployees", "employeeStates", "employeeBand"];

function partial(profile) {
  const c = checkProfile(profile, { requireAll: false });
  assert.ok(c.ok, c.error);
  return { ids: db.buildPartial(c.profile, c.unanswered.map((u) => u.key)).map((i) => i.compliance_name + "|" + i.due_date), unanswered: c.unanswered };
}

test("the calendar so far only grows, and ends as the full calendar", () => {
  for (const finished of FINISHED) {
    const full = db.buildFromDatabase(checkProfile(finished).profile);
    assert.ok(full.covered, finished.country);
    const fullIds = new Set(full.items.map((i) => i.compliance_name + "|" + i.due_date));
    let answers = { country: finished.country };
    let previous = partial(answers).ids;
    for (const key of ORDER.filter((k) => k in finished)) {
      answers = { ...answers, [key]: finished[key] };
      const now = partial(answers);
      for (const id of now.ids) assert.ok(fullIds.has(id), `${finished.country}: "${id}" shown early but not in the full calendar`);
      for (const id of previous) assert.ok(now.ids.includes(id), `${finished.country}: "${id}" dropped after answering ${key}`);
      previous = now.ids;
    }
    const last = partial(answers);
    assert.deepStrictEqual(last.unanswered, [], finished.country);
    assert.strictEqual(last.ids.length, fullIds.size, `${finished.country}: finished form gives the full calendar`);
  }
});

test("unanswered questions are listed and hold back the filings they decide", () => {
  const start = partial({ country: "United States", state: "California", entityType: "LLC" });
  assert.deepStrictEqual(start.unanswered.map((u) => u.key), ["taxStatus", "hasEmployees"]);
  assert.ok(start.ids.length > 0, "some filings are already certain");
  assert.ok(!start.ids.some((id) => /withholding|payroll|unemployment/i.test(id)), "no payroll filings before the employee question");
  const withStaff = partial({ country: "United States", state: "California", entityType: "LLC", taxStatus: "Partnership", hasEmployees: "Yes" });
  assert.ok(withStaff.ids.some((id) => /withholding|payroll|unemployment|DE 9/i.test(id)), "payroll filings once employees are confirmed");
});

// ---------------------------------------------------------------------
// Routes: /api/public/generate (signed out), /api/public/preview,
// /api/dashboard/due
// ---------------------------------------------------------------------
const calendars = [];
let seq = 0;
const oid = () => (++seq).toString(16).padStart(24, "0");
const matchQuery = (doc, q) => Object.entries(q).every(([k, v]) => {
  if (k === "$or") return v.some((sub) => matchQuery(doc, sub));
  const actual = k.split(".").reduce((o, p) => (o == null ? undefined : o[p]), doc);
  if (v && typeof v === "object" && !(v instanceof Date)) {
    if ("$ne" in v) return (actual ?? null) !== v.$ne;
    if ("$nin" in v) return !v.$nin.includes(actual ?? null);
    if ("$in" in v) return v.$in.map(String).includes(String(actual));
  }
  return (actual ?? null) === v;
});
const chain = (rows) => ({ select() { return this; }, lean: async () => rows, then: (r, j) => Promise.resolve(rows).then(r, j) });
const FakeCalendar = {
  create: async (doc) => { const d = { _id: oid(), ...doc }; calendars.push(d); return d; },
  find: (q) => chain(calendars.filter((c) => matchQuery(c, q))),
};
const orgs = [{ _id: "org1", name: "Acme Customer Inc." }];
stub("models/Calendar.js", FakeCalendar);
stub("models/ClientOrg.js", { find: (q) => chain(orgs.filter((o) => matchQuery(o, q))) });

let viewer = null;
stub("middleware/auth.js", {
  loadUserFromRequest: async () => { if (!viewer) throw new Error("no session"); return viewer; },
  requireAuth: (req, res, next) => (viewer ? ((req.user = viewer), next()) : res.status(401).json({ error: "Sign in" })),
  requireRole: (role) => (req, res, next) => (["staff", "admin", "super_admin"].includes(req.user.role) ? next() : res.status(403).json({ error: "No" })),
});
stub("lib/mailer.js", { sendEmail: async () => ({}) });
stub("lib/notify.js", { notifyStaff: () => {}, notifyClient: () => {} });

const express = require("express");
const app = express();
app.use(express.json());
app.use("/api/public", require("../routes/public.routes"));
app.use("/api/dashboard", require("../routes/dashboard.routes"));
const server = http.createServer(app);
let base;
test.before(async () => { await new Promise((r) => server.listen(0, r)); base = `http://127.0.0.1:${server.address().port}`; });
test.after(() => server.close());
const call = async (method, url, body) => {
  const res = await fetch(base + url, { method, headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json().catch(() => ({})) };
};

const FULL_US = { country: "United States", state: "California", entityType: "LLC", taxStatus: "Partnership", hasEmployees: "Yes", fyEnd: "Dec", incorpDate: "2020-03-10" };

test("signed out: the basic calendar shows the nearest 5 filings in full, the rest only as a category", async () => {
  viewer = null;
  const r = await call("POST", "/api/public/generate", { profile: FULL_US, contact: { email: "lead@example.com", phone: "+1 415 555 0100", name: "Lee" } });
  assert.strictEqual(r.status, 201, JSON.stringify(r.body));
  const shown = r.body.items.filter((i) => !i.locked);
  const locked = r.body.items.filter((i) => i.locked);
  assert.strictEqual(shown.length, 5);
  assert.ok(locked.length > 0);
  assert.ok(locked.every((i) => !i.compliance_name && !i.description && i.category));
});

test("preview needs a sign-in, then grows with the answers and ends complete", async () => {
  viewer = null;
  assert.strictEqual((await call("POST", "/api/public/preview", { profile: { country: "United States" } })).status, 401);

  viewer = { role: "client", email: "c@example.com", clientOrgId: "org1" };
  const early = await call("POST", "/api/public/preview", { profile: { country: "United States", state: "California", entityType: "LLC" } });
  assert.strictEqual(early.status, 200);
  assert.strictEqual(early.body.complete, false);
  assert.deepStrictEqual(early.body.unanswered.map((u) => u.key), ["taxStatus", "hasEmployees"]);

  const done = await call("POST", "/api/public/preview", { profile: FULL_US });
  assert.strictEqual(done.body.complete, true);
  assert.ok(done.body.itemCount > early.body.itemCount);
  const full = db.buildFromDatabase(checkProfile(FULL_US).profile).items.length;
  assert.strictEqual(done.body.itemCount, full, "complete preview = comprehensive calendar");

  const bad = await call("POST", "/api/public/preview", { profile: { country: "United States", state: "Atlantis" } });
  assert.strictEqual(bad.status, 400);
});

test("staff see everything due for customers and leads", async () => {
  const today = D.startOfDay(new Date());
  calendars.length = 0;
  calendars.push(
    { _id: oid(), clientOrgId: "org1", source: "client", status: "approved", supersededAt: null, profile: { country: "United States", state: "Delaware", companyName: "Acme" },
      items: [
        { compliance_name: "Customer filing", category: "Mandatory Annual", dueDateActual: D.addDays(today, 10), selectedByClient: true },
        { compliance_name: "Missed filing", category: "Mandatory Annual", dueDateActual: D.addDays(today, -5) },
        { compliance_name: "Done filing", category: "Mandatory Annual", dueDateActual: D.addDays(today, 3), completedAt: new Date() },
        { compliance_name: "Far filing", category: "Mandatory Annual", dueDateActual: D.addDays(today, 200) },
      ] },
    { _id: oid(), clientOrgId: null, source: "public", status: "pending_review", supersededAt: null, profile: { country: "United States", state: "Texas", companyName: "Lead Co" },
      leadContact: { name: "Lee", email: "lead@example.com", phone: "+14155550100" },
      items: [{ compliance_name: "Lead filing", category: "Mandatory Annual", due_date: "Monthly", schedule: { type: "monthly", day: 15 } }] },
    { _id: oid(), clientOrgId: null, source: "public", status: "rejected", supersededAt: null, profile: {}, leadContact: { email: "x@example.com" },
      items: [{ compliance_name: "Rejected", schedule: { type: "monthly", day: 15 } }] },
  );

  viewer = { role: "client" };
  assert.strictEqual((await call("GET", "/api/dashboard/due")).status, 403);

  viewer = { role: "staff", department: "tech" };
  const all = await call("GET", "/api/dashboard/due?days=60");
  assert.strictEqual(all.status, 200);
  const names = all.body.rows.map((r) => r.filing);
  assert.deepStrictEqual(names.sort(), ["Customer filing", "Lead filing", "Missed filing"].sort());
  assert.strictEqual(all.body.rows[0].filing, "Missed filing", "overdue first");
  assert.deepStrictEqual({ customers: all.body.counts.customers, leads: all.body.counts.leads, overdue: all.body.counts.overdue }, { customers: 2, leads: 1, overdue: 1 });
  const lead = all.body.rows.find((r) => r.filing === "Lead filing");
  assert.strictEqual(lead.customer, false);
  assert.match(lead.contact, /lead@example\.com/);

  const leads = await call("GET", "/api/dashboard/due?days=60&who=leads");
  assert.deepStrictEqual(leads.body.rows.map((r) => r.filing), ["Lead filing"]);
  const year = await call("GET", "/api/dashboard/due?days=365&who=customers");
  assert.ok(year.body.rows.some((r) => r.filing === "Far filing"));
});
