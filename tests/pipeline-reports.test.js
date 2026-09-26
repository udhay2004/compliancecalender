// tests/pipeline-reports.test.js
//
// Staff pipeline (lib/pipeline.js, routes/pipeline.routes.js) and reports
// (lib/reports.js, routes/reports.routes.js). Models, session, email and
// audit log are in-memory stand-ins; everything that decides a stage, an
// owner or a number is the production code.
//
//   node --test tests/

const test = require("node:test");
const assert = require("node:assert");
const http = require("node:http");
const path = require("node:path");

process.env.JWT_SECRET = "test-secret";
process.env.NODE_ENV = "test";
process.env.APP_URL = "https://app.example.com";

const root = path.join(__dirname, "..");
const RealCalendarSchema = require("../models/Calendar").schema;
const { errorHandler } = require("../lib/asyncErrors");
const stub = (rel, exports) => {
  const file = require.resolve(path.join(root, rel));
  require.cache[file] = { id: file, filename: file, loaded: true, exports };
};

let seq = 0;
const oid = () => (++seq).toString(16).padStart(24, "0");
const clone = (v) => JSON.parse(JSON.stringify(v));
let calendars = [], orgs = [], team = [], invoices = [];
const notifications = [], emails = [], audit = [];

function query(result) {
  const q = {
    sort: () => q, select: () => q, lean: () => q, limit: () => q, populate: () => q,
    then: (res, rej) => Promise.resolve(typeof result === "function" ? result() : result).then(res, rej),
    catch: (rej) => Promise.resolve(typeof result === "function" ? result() : result).catch(rej),
  };
  return q;
}
function matches(doc, q) {
  return Object.entries(q || {}).every(([k, v]) => {
    const actual = doc[k];
    if (v && typeof v === "object" && !Array.isArray(v) && !(v instanceof Date)) {
      return Object.entries(v).every(([op, x]) => {
        if (op === "$ne") return x === null ? actual != null : String(actual) !== String(x);
        if (op === "$in") return x.map(String).includes(String(actual));
        if (op === "$gte") return actual != null && new Date(actual) >= x;
        if (op === "$lt") return actual != null && new Date(actual) < x;
        return true;
      });
    }
    if (v === null) return actual === null || actual === undefined;
    return String(actual) === String(v);
  });
}
const withSave = (doc) => { Object.defineProperty(doc, "save", { value: async () => doc, enumerable: false, configurable: true }); return doc; };

const NOW = new Date();
const ago = (n) => new Date(NOW.getTime() - n * 86400000);
const ahead = (n) => new Date(NOW.getTime() + n * 86400000);

function makeCalendar(org, items) {
  const doc = withSave({ _id: oid(), status: "approved", supersededAt: null, clientOrgId: org._id, createdAt: ago(100), updatedAt: NOW, profile: { companyName: org.name, state: "Delaware", entityType: "Corporation", fyEnd: "Dec" }, items: [] });
  doc.items = items.map((it) => ({
    category: "Mandatory Annual", due_date: "1 March (Annually)", clientStatus: "Awaiting Documents", paymentStatus: "Not Invoiced",
    feeAmountCents: null, documents: [], paymentEvents: [], selectedByClient: true, selectedAt: ago(10), remindersSent: [], refunds: [],
    assignedTo: null, assignedToName: "", completedAt: null, dueDateActual: ahead(20), ...it,
  }));
  Object.defineProperty(doc, "toObject", { value: () => clone(doc), enumerable: false });
  calendars.push(doc);
  return doc;
}

stub("models/Calendar.js", {
  schema: RealCalendarSchema,
  find: (q) => query(() => calendars.filter((c) => matches(c, q))),
  findById: (id) => query(() => calendars.find((c) => String(c._id) === String(id)) || null),
});
stub("models/ClientOrg.js", {
  find: (q) => query(() => orgs.filter((o) => matches(o, q))),
  findById: (id) => query(() => orgs.find((o) => String(o._id) === String(id)) || null),
  countDocuments: async (q) => orgs.filter((o) => matches(o, q)).length,
});
stub("models/User.js", {
  find: (q) => query(() => team.filter((u) => matches(u, q))),
  findById: (id) => query(() => team.find((u) => String(u._id) === String(id)) || null),
});
stub("models/Invoice.js", { find: (q) => query(() => invoices.filter((d) => matches(d, q))) });
stub("models/Notification.js", { create: async (n) => { notifications.push(n); return n; } });
stub("lib/mailer.js", { sendEmail: async (e) => { emails.push(e); }, fromAddress: () => "x" });
stub("lib/auditLog.js", { logActivity: (e) => audit.push(e) });

const users = {};
stub("middleware/auth.js", {
  requireAuth: (req, res, next) => {
    const u = users[req.headers["x-test-user"]];
    if (!u) return res.status(401).json({ error: "Not logged in." });
    req.user = u; next();
  },
  requireRole: () => (req, res, next) => (req.user.role !== "client" ? next() : res.status(403).json({ error: "staff only" })),
});

const express = require("express");
const P = require("../lib/pipeline");
const R = require("../lib/reports");
const { toView } = require("../lib/calendarView");

const app = express();
app.use(express.json());
app.use("/api/pipeline", require("../routes/pipeline.routes"));
app.use("/api/reports", require("../routes/reports.routes"));
app.use(errorHandler);

let server, base;
test.before(async () => {
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server.close());

async function call(method, url, { user = "sam", body } = {}) {
  const opts = { method, headers: { "x-test-user": user } };
  if (body !== undefined) { opts.body = JSON.stringify(body); opts.headers["content-type"] = "application/json"; }
  const res = await fetch(base + url, opts);
  const text = await res.text();
  let json = {}; try { json = JSON.parse(text); } catch {}
  return { status: res.status, body: json, text, headers: res.headers };
}

const upload = (label, reviewStatus, uploadedAt = ago(3)) => ({ type: "client_upload", requirementLabel: label, fileName: `${label}.pdf`, fileKey: `k/${label}`, reviewStatus, uploadedAt });
function allDocs(item, reviewStatus = "accepted") {
  const labels = toView({ items: [item], profile: {} }).items[0].checklist.map((c) => c.label);
  return labels.map((l) => upload(l, reviewStatus));
}

function setup() {
  calendars = []; orgs = []; team = []; invoices = [];
  notifications.length = 0; emails.length = 0; audit.length = 0;
  const sam = withSave({ _id: oid(), name: "Sam", email: "sam@cg.com", role: "staff", department: "tech", active: true });
  const fin = withSave({ _id: oid(), name: "Fiona", email: "fiona@cg.com", role: "staff", department: "finance", active: true });
  const ada = withSave({ _id: oid(), name: "Ada", email: "ada@cg.com", role: "admin", department: "", active: true });
  const old = withSave({ _id: oid(), name: "Olly", email: "olly@cg.com", role: "staff", department: "", active: false });
  team.push(sam, fin, ada, old);
  users.sam = sam; users.fin = fin; users.ada = ada;
  users.client = { _id: oid(), role: "client" };

  const acme = withSave({ _id: oid(), name: "Acme Inc", assignedStaff: sam._id, createdAt: ago(5) });
  const blue = withSave({ _id: oid(), name: "Blue Harbor", assignedStaff: null, createdAt: ago(200) });
  orgs.push(acme, blue);

  const ra = { compliance_name: "Registered Agent Renewal" };
  const c1 = makeCalendar(acme, [
    { compliance_name: "Form 1120 Federal Corporate Income Tax Return", dueDateActual: ago(2) }, // 0 docs, overdue
    { ...ra, documents: [upload("Registered Agent Consent Letter", "pending")] },            // 1 verify
    { ...ra, documents: allDocs(ra) },                                                        // 2 price
    { ...ra, documents: allDocs(ra), paymentStatus: "Invoiced", feeAmountCents: 12500, quotedAt: ago(4) }, // 3 payment
    { ...ra, documents: allDocs(ra), paymentStatus: "Paid", feeAmountCents: 12500, paidAt: ago(1), assignedTo: ada._id, assignedToName: "Ada" }, // 4 work
    { ...ra, documents: allDocs(ra), clientStatus: "Filed", paymentStatus: "Paid", completedAt: ago(3), completedBy: "ada@cg.com", selectedAt: ago(13), dueDateActual: ago(5) }, // 5 done, late
    { ...ra, selectedByClient: false },                                                        // 6 not ours
  ]);
  const c2 = makeCalendar(blue, [
    { ...ra, documents: allDocs(ra), clientStatus: "Filed", paymentStatus: "Paid", completedAt: ago(6), completedBy: "sam@cg.com", selectedAt: ago(16), dueDateActual: ahead(30), isHistory: true, nextOccurrenceSpawned: true }, // done on time
    { compliance_name: "California Statement of Information", dueDateActual: ahead(400), selectedAt: ago(1) }, // docs
  ]);
  return { sam, fin, ada, acme, blue, c1, c2 };
}

// =====================================================================
// Stages and owners (pure)
// =====================================================================
test("each chosen service lands in the one stage that says what's next", () => {
  const { c1, c2 } = setup();
  const v = toView(c1, { staff: true }).items;
  assert.deepStrictEqual(v.map((x) => P.stageOf(x)), ["docs", "verify", "price", "payment", "work", "done", null]);
  const v2 = toView(c2, { staff: true }).items;
  assert.deepStrictEqual(v2.map((x) => P.stageOf(x)), ["done", "docs"]);
  // A filing done long ago drops out of the Done column.
  assert.strictEqual(P.stageOf({ ...v[5], completedAt: ago(45) }), null);
  // Refunded work isn't pipeline work.
  assert.strictEqual(P.stageOf({ ...v[3], paymentStatus: "Refunded" }), null);
});

test("owner: the filing's assignee, else the client's staff contact, else nobody", () => {
  const { c1, c2, acme, blue, sam, ada } = setup();
  const usersMap = new Map(team.map((u) => [String(u._id), { id: String(u._id), name: u.name, email: u.email }]));
  assert.deepStrictEqual(P.ownerOf(c1.items[4], acme, usersMap), { id: String(ada._id), name: "Ada", via: "filing" });
  assert.deepStrictEqual(P.ownerOf(c1.items[0], acme, usersMap), { id: String(sam._id), name: "Sam", via: "client" });
  assert.deepStrictEqual(P.ownerOf(c2.items[1], blue, usersMap), { id: null, name: "", via: null });
});

// =====================================================================
// Pipeline API
// =====================================================================
test("GET /api/pipeline: my work, everyone, unassigned, overdue, search", async () => {
  const { ada } = setup();
  let r = await call("GET", "/api/pipeline?owner=all");
  assert.strictEqual(r.status, 200, r.text);
  assert.deepStrictEqual(r.body.counts, { docs: 2, verify: 1, price: 1, payment: 1, work: 1, done: 2 });
  assert.strictEqual(r.body.totalOpen, 6);
  assert.strictEqual(r.body.cards.docs[0].daysUntilDue, -2, "overdue first");
  assert.strictEqual(r.body.cards.payment[0].daysInStage, 4, "waiting since it was priced");
  assert.ok(r.body.team.every((u) => u.active), "inactive people can't be picked");
  assert.strictEqual(r.body.team.length, 3);

  r = await call("GET", "/api/pipeline?owner=me");
  assert.strictEqual(r.body.totalOpen, 4, "Sam owns Acme's unassigned filings as the client's contact");
  r = await call("GET", "/api/pipeline?owner=me", { user: "ada" });
  assert.strictEqual(r.body.counts.work, 1);
  assert.strictEqual(r.body.totalOpen, 1);
  r = await call("GET", "/api/pipeline?owner=unassigned");
  assert.strictEqual(r.body.totalOpen, 1, "Blue Harbor has no contact");
  r = await call("GET", `/api/pipeline?owner=${ada._id}`);
  assert.strictEqual(r.body.totalOpen, 1);
  r = await call("GET", "/api/pipeline?owner=all&due=overdue");
  assert.strictEqual(r.body.totalOpen, 1);
  r = await call("GET", "/api/pipeline?owner=all&q=blue");
  assert.strictEqual(r.body.totalOpen, 1);
  assert.strictEqual((await call("GET", "/api/pipeline", { user: "client" })).status, 403);
});

test("assigning a filing tells the new owner and is logged; unassigning works", async () => {
  const { c1, fin } = setup();
  let r = await call("PATCH", `/api/pipeline/${c1._id}/items/0/assign`, { body: { userId: String(fin._id) } });
  assert.strictEqual(r.status, 200, r.text);
  assert.strictEqual(String(c1.items[0].assignedTo), String(fin._id));
  assert.strictEqual(c1.items[0].assignedToName, "Fiona");
  await new Promise((res) => setTimeout(res, 20));
  assert.ok(emails.some((e) => e.to === "fiona@cg.com" && e.subject.startsWith("Assigned to you: Form 1120")));
  assert.ok(notifications.some((n) => n.type === "filing_assigned" && n.title.startsWith("Sam assigned you")));
  assert.ok(audit.some((a) => a.action === "filing_assigned" && a.summary.includes("to Fiona")));

  emails.length = 0;
  r = await call("PATCH", `/api/pipeline/${c1._id}/items/0/assign`, { body: { userId: String(users.sam._id) } });
  await new Promise((res) => setTimeout(res, 20));
  assert.strictEqual(emails.length, 0, "no email when you take it yourself");

  r = await call("PATCH", `/api/pipeline/${c1._id}/items/0/assign`, { body: { userId: null } });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(c1.items[0].assignedTo, null);
  assert.ok(audit.some((a) => a.summary.startsWith("Unassigned")));
});

test("assigning refuses inactive people, clients, and bad requests", async () => {
  const { c1 } = setup();
  const olly = team.find((u) => u.name === "Olly");
  assert.strictEqual((await call("PATCH", `/api/pipeline/${c1._id}/items/0/assign`, { body: { userId: String(olly._id) } })).status, 400);
  assert.strictEqual((await call("PATCH", `/api/pipeline/${c1._id}/items/0/assign`, { body: {} })).status, 400);
  assert.strictEqual((await call("PATCH", `/api/pipeline/${c1._id}/items/99/assign`, { body: { userId: null } })).status, 404);
  assert.strictEqual((await call("PATCH", `/api/pipeline/nope/items/0/assign`, { body: { userId: null } })).status, 404);
});

// =====================================================================
// Reports (pure)
// =====================================================================
test("periods: last 30/90 days, 12 months, Indian financial year, custom", () => {
  const now = new Date("2026-09-26T10:00:00Z");
  let p = R.periodFrom({ range: "30d" }, now);
  assert.strictEqual(p.fromDate, "2026-08-28");
  assert.strictEqual(p.toDate, "2026-09-26");
  p = R.periodFrom({ range: "fy" }, now);
  assert.strictEqual(p.fromDate, "2026-04-01");
  assert.match(p.label, /Apr 2026 – Mar 2027/);
  p = R.periodFrom({ range: "fy" }, new Date("2027-02-10T00:00:00Z"));
  assert.strictEqual(p.fromDate, "2026-04-01");
  p = R.periodFrom({ range: "custom", from: "2026-01-01", to: "2026-03-31" }, now);
  assert.strictEqual(p.fromDate, "2026-01-01");
  assert.strictEqual(p.toDate, "2026-03-31");
  assert.ok(R.periodFrom({ range: "custom", from: "2026-03-01", to: "2026-01-01" }, now).error);
  assert.ok(R.periodFrom({ range: "custom", from: "nope" }, now).error);
});

test("on time, turnaround and late list", () => {
  const rows = [
    { item: { compliance_name: "A", clientStatus: "Filed", selectedAt: ago(10), completedAt: ago(2), dueDateActual: ago(1) } },   // on time, 8 days
    { item: { compliance_name: "B", clientStatus: "Filed", selectedAt: ago(20), completedAt: ago(1), dueDateActual: ago(4) } },   // 3 days late, 19 days
    { item: { compliance_name: "C", clientStatus: "Filed", selectedAt: ago(5), completedAt: ago(1), dueDateActual: null } },      // no date, 4 days
    { item: { compliance_name: "D", clientStatus: "Awaiting Documents", selectedAt: ago(3), dueDateActual: ago(1) } },            // open, overdue
  ].map((r) => ({ ...r, company: "Acme", calendarId: "c", itemIndex: 0 }));
  const s = R.filingStats(rows, { from: ago(30), to: ahead(1), now: NOW });
  assert.strictEqual(s.completed, 3);
  assert.strictEqual(s.onTime, 1);
  assert.strictEqual(s.late, 1);
  assert.strictEqual(s.noDueDate, 1);
  assert.strictEqual(s.onTimeRate, 50);
  assert.strictEqual(s.turnaroundMedianDays, 8);
  assert.strictEqual(s.chosen, 4);
  assert.strictEqual(s.openNow, 1);
  assert.strictEqual(s.overdueNow, 1);
  assert.strictEqual(s.lateList[0].daysLate, 3);
  // Filed on the due date itself counts as on time.
  assert.strictEqual(R.onTime({ completedAt: new Date("2027-03-01T23:00:00Z"), dueDateActual: new Date("2027-03-01T00:00:00Z") }), true);
});

test("revenue: payments minus refunds, by month, service and client; void refunds ignored", () => {
  const to = new Date(Date.UTC(2026, 8, 27));
  const from = new Date(Date.UTC(2026, 6, 1));
  const docs = [
    { kind: "invoice", issuedAt: new Date("2026-07-10"), amountMinor: 50000, currency: "USD", description: "Form 1120", customer: { name: "Acme" } },
    { kind: "invoice", issuedAt: new Date("2026-09-02"), amountMinor: 12500, currency: "USD", description: "Registered Agent", customer: { name: "Blue" } },
    { kind: "credit_note", issuedAt: new Date("2026-09-05"), amountMinor: 10000, currency: "USD", status: "issued", description: "Form 1120", customer: { name: "Acme" } },
    { kind: "credit_note", issuedAt: new Date("2026-09-06"), amountMinor: 99999, currency: "USD", status: "void", description: "Form 1120", customer: { name: "Acme" } },
    { kind: "invoice", issuedAt: new Date("2026-05-01"), amountMinor: 70000, currency: "USD", description: "Old", customer: { name: "Old Co" } },
    { kind: "invoice", issuedAt: new Date("2026-08-01"), amountMinor: 1000000, currency: "INR", description: "X", customer: { name: "Rupee Co" } },
  ];
  const r = R.revenue(docs, { from, to });
  assert.strictEqual(r.currency, "USD");
  assert.deepStrictEqual(r.totals, { collected: 62500, refunded: 10000, net: 52500, invoices: 2, refunds: 1, averageInvoice: 31250 });
  assert.deepStrictEqual(r.otherCurrencies.map((o) => [o.currency, o.net]), [["INR", 1000000]]);
  assert.strictEqual(r.byMonth.length, 12);
  assert.strictEqual(r.byMonth[11].key, "2026-09");
  assert.strictEqual(r.byMonth[11].net, 2500);
  assert.strictEqual(r.byMonth[9].net, 50000);
  assert.strictEqual(r.byMonth[7].net, 70000, "May is outside the period but still on the 12-month chart");
  assert.deepStrictEqual(r.byService.map((s) => [s.name, s.net]), [["Form 1120", 40000], ["Registered Agent", 12500]]);
  assert.deepStrictEqual(r.byClient.map((s) => s.name), ["Acme", "Blue"]);
});

test("CSV cells are escaped and can't run as spreadsheet formulas", () => {
  assert.strictEqual(R.csvCell('Acme, "Inc"'), '"Acme, ""Inc"""');
  assert.strictEqual(R.csvCell("=HYPERLINK(1)"), "'=HYPERLINK(1)");
  assert.strictEqual(R.csvCell(-5), "-5");
  assert.strictEqual(R.csvCell(null), "");
  const csv = R.toCsv(["A", "B"], [[1, "x\ny"]]);
  assert.ok(csv.startsWith("﻿A,B\r\n1,\"x\ny\"\r\n"));
});

// =====================================================================
// Reports API
// =====================================================================
test("GET /api/reports/summary: delivery numbers for everyone, money only for finance/admin", async () => {
  const { acme } = setup();
  invoices = [
    { kind: "invoice", issuedAt: ago(1), amountMinor: 12500, currency: "USD", description: "Registered Agent Renewal", customer: { name: "Acme Inc" }, clientOrgId: acme._id },
  ];
  let r = await call("GET", "/api/reports/summary?range=30d");
  assert.strictEqual(r.status, 200, r.text);
  assert.strictEqual(r.body.canSeeFinance, false);
  assert.strictEqual(r.body.revenue, undefined, "tech staff never receive money figures");
  const f = r.body.filings;
  assert.strictEqual(f.completed, 2);
  assert.strictEqual(f.onTime, 1);
  assert.strictEqual(f.late, 1);
  assert.strictEqual(f.onTimeRate, 50);
  assert.strictEqual(f.turnaroundMedianDays, 10);
  assert.strictEqual(f.overdueNow, 1);
  assert.strictEqual(r.body.clients.new, 1);
  assert.strictEqual(r.body.clients.total, 2);
  const byName = Object.fromEntries(r.body.workload.map((w) => [w.name, w]));
  assert.strictEqual(byName.Sam.open, 4);
  assert.strictEqual(byName.Sam.completed, 1);
  assert.strictEqual(byName.Ada.open, 1);
  assert.strictEqual(byName.Ada.waitingOnUs, 1);
  assert.strictEqual(byName.Ada.completed, 1);
  assert.strictEqual(byName.Unassigned.open, 1);
  assert.ok(!byName.Olly, "inactive people with no work are left out");
  assert.strictEqual(r.body.services[0].name, "Registered Agent Renewal", "most chosen first");

  r = await call("GET", "/api/reports/summary?range=30d", { user: "fin" });
  assert.strictEqual(r.body.revenue.totals.net, 12500);
  r = await call("GET", "/api/reports/summary?range=custom&from=2026-02-01&to=2026-01-01", { user: "ada" });
  assert.strictEqual(r.status, 400);
});

test("CSV exports: filings for the team, revenue for finance only", async () => {
  setup();
  invoices = [{ kind: "invoice", number: "INV/2026-27/0001", issuedAt: ago(1), amountMinor: 12500, currency: "USD", status: "paid", description: "Registered Agent Renewal", customer: { name: "=Acme" } }];
  let r = await call("GET", "/api/reports/filings.csv?range=90d");
  assert.strictEqual(r.status, 200);
  assert.match(r.headers.get("content-type"), /text\/csv/);
  assert.match(r.headers.get("content-disposition"), /attachment; filename="filings_\d{4}-\d{2}-\d{2}_to_\d{4}-\d{2}-\d{2}\.csv"/);
  const lines = r.text.replace(/^﻿/, "").trim().split("\r\n");
  assert.strictEqual(lines[0], "Company,Filing,Period,Stage,Status,Payment,Price (USD),Chosen on,Due,Filed on,On time,Turnaround (days),Owner,Filed by,Link");
  assert.strictEqual(lines.length, 1 + 8, "every chosen filing active in the period");
  assert.ok(lines.some((l) => l.includes("Needs a price")));

  assert.strictEqual((await call("GET", "/api/reports/revenue.csv?range=90d")).status, 403);
  r = await call("GET", "/api/reports/revenue.csv?range=90d", { user: "fin" });
  assert.strictEqual(r.status, 200);
  assert.ok(r.text.includes("INV/2026-27/0001"));
  assert.ok(r.text.includes("'=Acme"), "formula-looking names are made safe");
});
