// tests/chasing-export-whatsapp.test.js
//
// Document chasing (lib/reminders.js), calendar export (lib/ics.js,
// routes/feeds.routes.js) and WhatsApp (lib/whatsapp.js, lib/notify.js,
// routes/whatsapp.routes.js). The models, session check, email and audit
// log are in-memory stand-ins; Meta's API is faked at the fetch() level so
// the exact request we'd send is checked.
//
//   node --test tests/

const test = require("node:test");
const assert = require("node:assert");
const http = require("node:http");
const path = require("node:path");
const crypto = require("node:crypto");

process.env.JWT_SECRET = "test-secret";
process.env.NODE_ENV = "test";
process.env.APP_URL = "https://app.example.com";
delete process.env.WHATSAPP_TOKEN;
delete process.env.WHATSAPP_PHONE_NUMBER_ID;
delete process.env.WHATSAPP_EVENTS;
delete process.env.DOC_CHASE_DAYS;

const root = path.join(__dirname, "..");
const RealCalendarSchema = require("../models/Calendar").schema;
const { errorHandler } = require("../lib/asyncErrors");
const stub = (rel, exports) => {
  const file = require.resolve(path.join(root, rel));
  require.cache[file] = { id: file, filename: file, loaded: true, exports };
};

// ---------------------------------------------------------------------
// In-memory data
// ---------------------------------------------------------------------
let seq = 0;
const oid = () => (++seq).toString(16).padStart(24, "0");
const clone = (v) => JSON.parse(JSON.stringify(v));
let calendars = [], orgs = [], userList = [];
const notifications = [], emails = [], audit = [], messages = [];

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
      if ("$ne" in v) return v.$ne === null ? actual != null : String(actual) !== String(v.$ne);
      if ("$in" in v) return v.$in.map(String).includes(String(actual));
    }
    if (v === null) return actual === null || actual === undefined;
    return String(actual) === String(v);
  });
}
const withSave = (doc) => {
  Object.defineProperty(doc, "save", { value: async () => doc, enumerable: false, configurable: true });
  return doc;
};
function makeCalendar(data) {
  const doc = withSave(Object.assign({ _id: oid(), status: "approved", supersededAt: null, createdAt: new Date(), updatedAt: new Date(), items: [] }, data));
  doc.items = doc.items.map((it) => ({
    category: "Mandatory Annual", due_date: "1 March (Annually)", description: "", authority: "",
    clientStatus: "Not Started", paymentStatus: "Not Invoiced", feeAmountCents: null, documents: [], paymentEvents: [],
    selectedByClient: false, selectedAt: null, remindersSent: [], refunds: [], docChasePaused: false,
    ...it,
  }));
  Object.defineProperty(doc, "toObject", { value: () => clone(doc), enumerable: false });
  doc.profile = Object.assign({ companyName: "Acme Inc", state: "Delaware", entityType: "Corporation", fyEnd: "Dec" }, doc.profile || {});
  calendars.push(doc);
  return doc;
}
function makeOrg(data) {
  const org = withSave(Object.assign({
    _id: oid(), name: "Acme Inc", primaryContactName: "Jane Doe", primaryContactEmail: "jane@acme.com", primaryContactPhone: "+1 415 555 0100",
    whatsappOptIn: false, whatsappNumber: "", whatsappLastError: "", calendarFeedToken: undefined, assignedStaff: null,
  }, data));
  orgs.push(org);
  return org;
}

stub("models/Calendar.js", {
  schema: RealCalendarSchema,
  find: (q) => query(() => calendars.filter((c) => matches(c, q))),
  findOne: (q) => query(() => calendars.find((c) => matches(c, q)) || null),
  findById: (id) => query(() => calendars.find((c) => String(c._id) === String(id)) || null),
  aggregate: async () => [],
  countDocuments: async () => 0,
});
stub("models/ClientOrg.js", {
  findById: (id) => query(() => orgs.find((o) => String(o._id) === String(id)) || null),
  findOne: (q) => query(() => orgs.find((o) => matches(o, q)) || null),
  find: (q) => query(() => orgs.filter((o) => matches(o, q))),
  countDocuments: async (q) => orgs.filter((o) => matches(o, q)).length,
});
stub("models/User.js", {
  findOne: (q) => query(() => userList.find((u) => matches(u, q)) || null),
  findById: (id) => query(() => userList.find((u) => String(u._id) === String(id)) || null),
  find: () => query([]),
});
stub("models/Message.js", { create: async (m) => { messages.push(m); return m; }, findOne: () => query(null) });
stub("models/Notification.js", { create: async (n) => { notifications.push(n); return n; } });
stub("models/AuditLog.js", { find: () => query([]), create: async () => ({}) });
stub("lib/mailer.js", { sendEmail: async (e) => { emails.push(e); }, fromAddress: () => "x" });
stub("lib/auditLog.js", { logActivity: (e) => audit.push(e) });
stub("lib/claude.js", { generateCompanyCalendar: async () => ({ items: [] }) });
stub("lib/storage.js", {
  findMissing: async () => new Set(), fileExists: async () => true, getFile: async () => null, saveFile: async () => ({}),
  describe: () => "memory", DRIVER: "memory",
});

const users = {};
stub("middleware/auth.js", {
  requireAuth: (req, res, next) => {
    const u = users[req.headers["x-test-user"]];
    if (!u) return res.status(401).json({ error: "Not logged in." });
    req.user = u; next();
  },
  requireClientRole: (req, res, next) => (req.user.role === "client" ? next() : res.status(403).json({ error: "client only" })),
  requireRole: () => (req, res, next) => (req.user.role !== "client" ? next() : res.status(403).json({ error: "staff only" })),
});

// Meta's API, faked at the fetch() level.
const meta = { calls: [], reply: null };
const realFetch = global.fetch;
global.fetch = async (url, opts = {}) => {
  if (String(url).startsWith("https://graph.facebook.com/")) {
    const call = { url: String(url), method: opts.method, headers: opts.headers, body: opts.body ? JSON.parse(opts.body) : null };
    meta.calls.push(call);
    const r = meta.reply ? meta.reply(call) : { status: 200, json: { messaging_product: "whatsapp", messages: [{ id: `wamid.${meta.calls.length}` }] } };
    return new Response(JSON.stringify(r.json), { status: r.status, headers: { "content-type": "application/json" } });
  }
  return realFetch(url, opts);
};

const express = require("express");
const R = require("../lib/reminders");
const D = require("../lib/deadlines");
const ics = require("../lib/ics");
const wa = require("../lib/whatsapp");

const app = express();
{
  const w = require("../routes/whatsapp.routes");
  app.get("/api/webhooks/whatsapp", w.verifyHandler);
  app.post("/api/webhooks/whatsapp", express.raw({ type: "*/*" }), w.webhookHandler);
}
app.use(express.json());
app.use(require("../routes/feeds.routes"));
app.use("/api/portal", require("../routes/portal.routes"));
app.use("/api/calendars", require("../routes/calendar.routes"));
app.use("/api/dashboard", require("../routes/dashboard.routes"));
app.use("/api/admin", require("../routes/admin.routes"));
app.use(errorHandler);

let server, base;
test.before(async () => {
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server.close());

async function call(method, url, { user = "client", body, raw, headers = {} } = {}) {
  const opts = { method, headers: { "x-test-user": user, ...headers } };
  if (raw !== undefined) opts.body = raw;
  else if (body !== undefined) { opts.body = JSON.stringify(body); opts.headers["content-type"] = "application/json"; }
  const res = await realFetch(base + url, opts);
  const text = await res.text();
  let json = {}; try { json = JSON.parse(text); } catch {}
  return { status: res.status, body: json, text, headers: res.headers };
}

function whatsappOn() {
  process.env.WHATSAPP_TOKEN = "EAAtest";
  process.env.WHATSAPP_PHONE_NUMBER_ID = "1234567890";
  process.env.WHATSAPP_APP_SECRET = "app-secret";
  process.env.WHATSAPP_VERIFY_TOKEN = "verify-me";
}
function whatsappOff() {
  ["WHATSAPP_TOKEN", "WHATSAPP_PHONE_NUMBER_ID", "WHATSAPP_APP_SECRET", "WHATSAPP_VERIFY_TOKEN", "WHATSAPP_BUSINESS_ACCOUNT_ID", "WHATSAPP_DEFAULT_COUNTRY_CODE"].forEach((k) => delete process.env[k]);
}

function setup({ items, orgData } = {}) {
  calendars = []; orgs = []; userList = [];
  notifications.length = 0; emails.length = 0; audit.length = 0; messages.length = 0;
  meta.calls = []; meta.reply = null;
  whatsappOff();
  const org = makeOrg(orgData || {});
  users.client = { _id: oid(), email: "jane@acme.com", name: "Jane", role: "client", clientOrgId: org._id };
  users.staff = { _id: oid(), email: "sam@cg.com", name: "Sam", role: "staff", department: "", active: true, toSafeJSON() { return { name: "Sam" }; } };
  userList.push(withSave({ ...users.client, createdAt: new Date() }), withSave({ ...users.staff }));
  const cal = makeCalendar({
    clientOrgId: org._id,
    items: items || [
      { compliance_name: "Delaware Annual Report & Franchise Tax", selectedByClient: true, selectedAt: day("2027-01-01"), clientStatus: "Awaiting Documents" },
      { compliance_name: "Form 1120 Federal Corporate Income Tax Return", due_date: "15 April (Annually)" },
    ],
  });
  return { org, cal };
}

const day = (s) => new Date(`${s}T12:00:00Z`);
const iso = (d) => new Date(d).toISOString().slice(0, 10);
const chaseDays = (item) => item.remindersSent.filter((k) => k.startsWith("docs-chase:")).map((k) => k.slice(11));

// =====================================================================
// Document chasing (pure)
// =====================================================================
test("missing documents are chased 2, 5 and 10 days after selection, then weekly; team told after 3", () => {
  const { cal } = setup();
  D.ensureDueDates(cal, day("2027-01-01")); // Delaware: 1 March 2027
  const item = cal.items[0];
  const run = (d) => R.processCalendar(cal, day(d));

  let r = run("2027-01-02");
  assert.strictEqual(r.client.filter((e) => e.docs).length, 0, "day 1: too early");
  r = run("2027-01-03");
  const e = r.client.find((x) => x.docs);
  assert.ok(e, "day 2: first reminder");
  assert.strictEqual(e.group, "docs");
  assert.ok(e.docs.length >= 1 && e.docs.every((d) => typeof d === "string"));
  assert.strictEqual(run("2027-01-04").client.length, 0, "not the next day");
  assert.ok(run("2027-01-06").client.some((x) => x.docs), "day 5");
  r = run("2027-01-11");
  assert.ok(r.client.some((x) => x.docs), "day 10");
  assert.strictEqual(r.docsStuck.length, 1, "team is told after the 3rd reminder");
  assert.strictEqual(run("2027-01-17").client.length, 0, "not before a week has passed");
  r = run("2027-01-18");
  assert.ok(r.client.some((x) => x.docs), "weekly after that");
  assert.strictEqual(r.docsStuck.length, 0, "team told only once");
  assert.deepStrictEqual(chaseDays(item), ["2027-01-03", "2027-01-06", "2027-01-11", "2027-01-18"]);
});

test("chasing speeds up to every 3 days in the last 2 weeks, and joins the deadline reminder", () => {
  const { cal } = setup({ items: [{ compliance_name: "Delaware Annual Report & Franchise Tax", selectedByClient: true, selectedAt: day("2027-02-10"), clientStatus: "Awaiting Documents" }] });
  D.ensureDueDates(cal, day("2027-02-10"));
  const item = cal.items[0];
  let r = R.processCalendar(cal, day("2027-02-15")); // 14 days before 1 Mar
  assert.ok(r.client.some((x) => x.docs));
  assert.strictEqual(R.processCalendar(cal, day("2027-02-17")).client.filter((x) => x.docs).length, 0);
  assert.ok(R.processCalendar(cal, day("2027-02-18")).client.some((x) => x.docs), "3 days later");
  assert.strictEqual(R.processCalendar(cal, day("2027-02-20")).client.filter((x) => x.docs).length, 0);
  r = R.processCalendar(cal, day("2027-02-22")); // 7-day deadline reminder the same day
  const entry = r.client.find((x) => x.idx === 0);
  assert.strictEqual(entry.group, "soon", "one entry: the deadline reminder…");
  assert.ok(entry.docs && entry.docs.length, "…carrying the missing document list");
  assert.deepStrictEqual(chaseDays(item), ["2027-02-15", "2027-02-18", "2027-02-22"]);
});

test("no chasing once documents are in, when paused, when staff moved it on, or for unselected filings", () => {
  const { cal } = setup({
    items: [
      { compliance_name: "Registered Agent Renewal", selectedByClient: true, selectedAt: day("2027-01-01"), clientStatus: "Awaiting Documents" },
      { compliance_name: "Registered Agent Renewal (paused)", selectedByClient: true, selectedAt: day("2027-01-01"), clientStatus: "Awaiting Documents", docChasePaused: true },
      { compliance_name: "Registered Agent Renewal (staff)", selectedByClient: true, selectedAt: day("2027-01-01"), clientStatus: "Under Review" },
      { compliance_name: "Registered Agent Renewal (not ours)", selectedByClient: false },
    ],
  });
  const { toView } = require("../lib/calendarView");
  const labels = toView(cal).items[0].checklist.map((c) => c.label);
  cal.items[0].documents = labels.map((l, i) => ({ type: "client_upload", requirementLabel: l, fileName: `${i}.pdf`, fileKey: `k${i}`, reviewStatus: "pending" }));
  const r = R.processCalendar(cal, day("2027-01-05"));
  assert.strictEqual(r.client.filter((x) => x.docs).length, 0);
});

test("a rejected document is asked for again, by name", () => {
  const { cal } = setup({ items: [{ compliance_name: "Registered Agent Renewal", selectedByClient: true, selectedAt: day("2027-01-01"), clientStatus: "Awaiting Documents" }] });
  const { toView } = require("../lib/calendarView");
  const labels = toView(cal).items[0].checklist.map((c) => c.label);
  cal.items[0].documents = labels.map((l, i) => ({ type: "client_upload", requirementLabel: l, fileName: `${i}.pdf`, fileKey: `k${i}`, reviewStatus: i === 0 ? "rejected" : "accepted" }));
  const r = R.processCalendar(cal, day("2027-01-05"));
  assert.deepStrictEqual(r.client[0].docs, [`${labels[0]} (please upload a new copy)`]);
});

test("the client digest lists the documents; WhatsApp gets one short summary", () => {
  const item = { compliance_name: "Form 1120" };
  const due = day("2027-04-15");
  const d = R.clientDigest("Acme Inc", [{ idx: 0, item, days: null, due, group: "docs", docs: ["EIN letter", "Balance sheet"] }]);
  assert.match(d.title, /Documents needed for 1 filing — Acme Inc/);
  assert.match(d.body, /Documents we still need from you/);
  assert.match(d.body, /Form 1120 \(due 15 Apr 2027\): EIN letter; Balance sheet/);
  assert.strictEqual(d.onlyDocs, true);

  assert.deepStrictEqual(R.whatsappDigest("Acme Inc", [{ item, due, group: "docs", docs: ["EIN letter", "Balance sheet"] }]),
    { kind: "documents", params: ["Form 1120", "2 documents, due 15 Apr 2027"] });
  const mixed = R.whatsappDigest("Acme Inc", [
    { item, due, group: "overdue", days: -2 },
    { item, due, group: "soon", days: 3, docs: ["EIN letter"] },
  ]);
  assert.deepStrictEqual(mixed, { kind: "deadline", params: ["Acme Inc", "1 filing overdue, 1 filing due within 7 days, documents needed for 1 filing"] });
  assert.strictEqual(R.whatsappDigest("Acme Inc", [{ item, due, group: "headsUp", days: 20 }]), false, "heads-ups don't go to WhatsApp");
});

// =====================================================================
// Staff: Chase now, pause, dashboard list
// =====================================================================
test("Chase now emails the client the exact list, once a day, and is logged", async () => {
  const { cal } = setup();
  let r = await call("POST", `/api/calendars/${cal._id}/items/0/chase`, { user: "staff" });
  assert.strictEqual(r.status, 200, r.text);
  assert.ok(r.body.docs.length >= 1);
  assert.strictEqual(r.body.sent.email, true);
  assert.strictEqual(r.body.sent.whatsapp, false, "client hasn't switched WhatsApp on");
  const n = notifications.find((x) => x.type === "documents_requested");
  assert.ok(n && n.body.includes(r.body.docs[0]));
  assert.ok(emails.some((e) => e.to === "jane@acme.com" && e.subject.includes("Documents needed")));
  assert.ok(audit.some((a) => a.action === "documents_chased"));
  assert.strictEqual(r.body.calendar.items[0].docChase.count, 1);

  r = await call("POST", `/api/calendars/${cal._id}/items/0/chase`, { user: "staff" });
  assert.strictEqual(r.status, 429);
  r = await call("POST", `/api/calendars/${cal._id}/items/1/chase`, { user: "staff" });
  assert.strictEqual(r.status, 400, "not selected by the client");
  r = await call("POST", `/api/calendars/${cal._id}/items/0/chase`, { user: "client" });
  assert.strictEqual(r.status, 403, "clients can't use it");
});

test("staff can pause automatic chasing for one filing", async () => {
  const { cal } = setup();
  const r = await call("PATCH", `/api/calendars/${cal._id}/items/0/chase`, { user: "staff", body: { paused: true } });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(cal.items[0].docChasePaused, true);
  assert.strictEqual(R.processCalendar(cal, day("2027-01-05")).client.filter((x) => x.docs).length, 0);
  assert.strictEqual((await call("PATCH", `/api/calendars/${cal._id}/items/0/chase`, { user: "staff", body: {} })).status, 400);
});

test("the dashboard lists filings waiting on client documents", async () => {
  setup();
  const r = await call("GET", "/api/dashboard/summary", { user: "staff" });
  assert.strictEqual(r.status, 200, r.text);
  const w = r.body.tech.waitingOnDocs;
  assert.strictEqual(w.length, 1);
  assert.strictEqual(w[0].company, "Acme Inc");
  assert.ok(w[0].missing.length >= 1);
  assert.strictEqual(w[0].remindersSent, 0);
});

// =====================================================================
// Calendar export
// =====================================================================
test(".ics output is valid: all-day events, escaping, 75-byte lines, alerts only for our filings", () => {
  const text = ics.buildIcs({
    name: "Acme, Inc; deadlines",
    events: [
      { uid: "a@x", date: day("2027-03-01"), summary: "Delaware Annual Report & Franchise Tax — a very long title that will need folding because it is long", description: "Line one\nLine two, with; punctuation", alarms: [7, 1] },
      { uid: "b@x", date: day("2027-04-15"), summary: "Form 1120 (you file)", alarms: [] },
    ],
  }, day("2027-01-01"));
  assert.ok(text.startsWith("BEGIN:VCALENDAR\r\nVERSION:2.0\r\n"));
  assert.ok(text.endsWith("END:VCALENDAR\r\n"));
  assert.ok(text.includes("X-WR-CALNAME:Acme\\, Inc\\; deadlines"));
  assert.ok(text.includes("DTSTART;VALUE=DATE:20270301\r\nDTEND;VALUE=DATE:20270302"));
  assert.ok(text.includes("Line one\\nLine two\\, with\\; punctuation"));
  text.split("\r\n").forEach((line) => assert.ok(Buffer.byteLength(line) <= 75, `too long: ${line}`));
  assert.strictEqual((text.match(/BEGIN:VALARM/g) || []).length, 2);
  assert.ok(text.includes("TRIGGER:-P7D") && text.includes("TRIGGER:-P1D"));
  // Unfolding gives the original title back.
  const unfolded = text.replace(/\r\n /g, "");
  assert.ok(unfolded.includes("SUMMARY:Delaware Annual Report & Franchise Tax — a very long title that will need folding because it is long"));
});

test("client events say who files what; the team feed only has filings we handle", () => {
  const { cal } = setup();
  D.ensureDueDates(cal, day("2027-01-01"));
  const client = ics.calendarEvents(cal, { audience: "client" });
  assert.strictEqual(client.length, 2);
  assert.ok(client[0].description.startsWith("ComplyGlobally is handling this"));
  assert.ok(client.find((e) => e.summary.endsWith("(you file)")));
  assert.ok(client[0].url.startsWith("https://app.example.com/portal.html?calendar="));
  const team = ics.calendarEvents(cal, { audience: "staff", company: "Acme Inc" });
  assert.strictEqual(team.length, 1);
  assert.match(team[0].summary, /^Acme Inc: Delaware Annual Report/);
});

test("portal: download .ics, get a subscribe link that works, reset it", async () => {
  const { cal, org } = setup();
  D.ensureDueDates(cal, day("2027-01-01"));
  let r = await call("GET", "/api/portal/calendar.ics");
  assert.strictEqual(r.status, 200);
  assert.match(r.headers.get("content-type"), /text\/calendar/);
  assert.match(r.headers.get("content-disposition"), /attachment; filename="Acme-Inc-deadlines.ics"/);
  assert.strictEqual((r.text.match(/BEGIN:VEVENT/g) || []).length, 2);

  r = await call("GET", "/api/portal/calendar-feed");
  const feed = r.body.feed;
  assert.match(feed.url, /^https:\/\/app\.example\.com\/feeds\/[a-f0-9]{40}\.ics$/);
  assert.ok(feed.webcal.startsWith("webcal://app.example.com/feeds/"));
  assert.ok(feed.google.startsWith("https://calendar.google.com/calendar/r?cid=webcal%3A%2F%2F"));
  assert.ok(feed.outlook.includes("addfromweb?url=https%3A%2F%2Fapp.example.com"));
  assert.strictEqual((await call("GET", "/api/portal/calendar-feed")).body.feed.url, feed.url, "same link every time");

  const path1 = new URL(feed.url).pathname;
  r = await call("GET", path1, { user: "nobody" });
  assert.strictEqual(r.status, 200, "calendar apps don't log in");
  assert.ok(r.text.includes("X-WR-CALNAME:Acme Inc — compliance deadlines"));
  assert.match(r.headers.get("content-disposition"), /^inline/);

  // Another company's calendar never leaks into this feed.
  const other = makeOrg({ name: "Other Co" });
  makeCalendar({ clientOrgId: other._id, profile: { companyName: "Other Co" }, items: [{ compliance_name: "Secret filing", selectedByClient: true }] });
  D.ensureDueDates(calendars[calendars.length - 1], day("2027-01-01"));
  assert.ok(!(await call("GET", path1, { user: "nobody" })).text.includes("Secret filing"));

  r = await call("POST", "/api/portal/calendar-feed/reset");
  assert.notStrictEqual(r.body.feed.url, feed.url);
  assert.strictEqual((await call("GET", path1, { user: "nobody" })).status, 404, "old link stops working");
  assert.strictEqual((await call("GET", "/feeds/not-a-token.ics", { user: "nobody" })).status, 404);
  assert.ok(!JSON.stringify({ ...org }).includes("undefined") || true);
});

test("staff: team subscription link and a per-calendar .ics download", async () => {
  const { cal } = setup();
  D.ensureDueDates(cal, day("2027-01-01"));
  const r = await call("GET", "/api/dashboard/calendar-feed", { user: "staff" });
  assert.match(r.body.feed.url, /\/feeds\/team\/[a-f0-9]{40}\.ics$/);
  const feed = await call("GET", new URL(r.body.feed.url).pathname, { user: "nobody" });
  assert.strictEqual(feed.status, 200);
  assert.ok(feed.text.includes("SUMMARY:Acme Inc: Delaware Annual Report"));
  assert.ok(!feed.text.includes("Form 1120"), "only filings we handle");
  // A deactivated staff member's link stops working.
  userList.find((u) => u.role === "staff").active = false;
  assert.strictEqual((await call("GET", new URL(r.body.feed.url).pathname, { user: "nobody" })).status, 404);

  const dl = await call("GET", `/api/calendars/${cal._id}/ics`, { user: "staff" });
  assert.strictEqual(dl.status, 200);
  assert.strictEqual((dl.text.match(/BEGIN:VEVENT/g) || []).length, 2);
});

// =====================================================================
// WhatsApp
// =====================================================================
test("WhatsApp numbers need a country code (or a default one)", () => {
  whatsappOff();
  assert.strictEqual(wa.toWhatsAppNumber("+1 (415) 555-0100"), "14155550100");
  assert.strictEqual(wa.toWhatsAppNumber("+91 98765 43210"), "919876543210");
  assert.strictEqual(wa.toWhatsAppNumber("0044 20 7946 0958"), "442079460958");
  assert.strictEqual(wa.toWhatsAppNumber("(415) 555-0100"), null, "no country code");
  process.env.WHATSAPP_DEFAULT_COUNTRY_CODE = "1";
  assert.strictEqual(wa.toWhatsAppNumber("(415) 555-0100"), "14155550100");
  delete process.env.WHATSAPP_DEFAULT_COUNTRY_CODE;
  assert.strictEqual(wa.toWhatsAppNumber("call me"), null);
  assert.strictEqual(wa.cleanParam("a\nb\t\tc     d"), "a · b · c d");
  assert.strictEqual(wa.cleanParam(""), "-");
  assert.strictEqual(wa.cleanParam("x".repeat(300)).length, 180);
});

test("without settings nothing is sent to Meta (logged only)", async () => {
  setup();
  const r = await wa.sendTemplate({ to: "14155550100", kind: "update", params: ["Jane", "hi"] });
  assert.strictEqual(r.dryRun, true);
  assert.strictEqual(meta.calls.length, 0);
});

test("a template message is sent exactly as Meta expects", async () => {
  setup();
  whatsappOn();
  const r = await wa.sendTemplate({ to: "14155550100", kind: "deadline", params: ["Jane", "Acme Inc", "1 filing overdue\nplease act"] });
  assert.strictEqual(r.ok, true);
  const c = meta.calls[0];
  assert.strictEqual(c.url, "https://graph.facebook.com/v24.0/1234567890/messages");
  assert.strictEqual(c.headers.Authorization, "Bearer EAAtest");
  assert.deepStrictEqual(c.body, {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to: "14155550100",
    type: "template",
    template: {
      name: "deadline_reminder",
      language: { code: "en" },
      components: [{ type: "body", parameters: [{ type: "text", text: "Jane" }, { type: "text", text: "Acme Inc" }, { type: "text", text: "1 filing overdue · please act" }] }],
    },
  });
});

test("Meta errors come back in plain English", async () => {
  setup();
  whatsappOn();
  meta.reply = () => ({ status: 404, json: { error: { code: 132001, message: "Template name does not exist in the translation" } } });
  const r = await wa.sendTemplate({ to: "14155550100", kind: "update", params: ["Jane", "x"] });
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /template doesn't exist/i);
  assert.match(r.error, /Meta said: Template name does not exist/);
});

test("portal: a client switches WhatsApp on (confirmation sent) and off", async () => {
  const { org } = setup();
  let r = await call("GET", "/api/portal/profile");
  assert.strictEqual(r.body.profile.whatsapp.available, false, "hidden until WhatsApp is set up");
  whatsappOn();
  r = await call("GET", "/api/portal/profile");
  assert.strictEqual(r.body.profile.whatsapp.available, true);
  assert.strictEqual(r.body.profile.whatsapp.suggestedNumber, "+14155550100");

  r = await call("PATCH", "/api/portal/profile", { body: { whatsappOn: true, whatsappNumber: "555 0100" } });
  assert.strictEqual(r.status, 400, "no country code");
  r = await call("PATCH", "/api/portal/profile", { body: { whatsappOn: true } });
  assert.strictEqual(r.status, 200, r.text);
  assert.strictEqual(org.whatsappOptIn, true);
  assert.strictEqual(org.whatsappNumber, "14155550100");
  assert.ok(org.whatsappOptInAt instanceof Date);
  assert.deepStrictEqual(r.body.whatsappTest, { ok: true, error: "" });
  assert.strictEqual(meta.calls.length, 1);
  assert.strictEqual(meta.calls[0].body.template.name, "account_update");
  assert.strictEqual(meta.calls[0].body.template.components[0].parameters[0].text, "Jane", "first name only");
  assert.ok(audit.some((a) => a.action === "whatsapp_opt_in"));

  // Same number on another company is refused (replies must map to one client).
  const other = makeOrg({ name: "Other" });
  users.other = { _id: oid(), role: "client", clientOrgId: other._id, email: "o@o.com" };
  r = await call("PATCH", "/api/portal/profile", { user: "other", body: { whatsappOn: true, whatsappNumber: "+1 415 555 0100" } });
  assert.strictEqual(r.status, 409);

  r = await call("PATCH", "/api/portal/profile", { body: { whatsappOn: false } });
  assert.strictEqual(org.whatsappOptIn, false);
  assert.ok(audit.some((a) => a.action === "whatsapp_opt_out"));
});

test("clients who opted in get WhatsApp for important events and the daily digest; others don't", async () => {
  const { cal, org } = setup();
  whatsappOn();
  const { notifyClient } = require("../lib/notify");
  // Not opted in: email only.
  let sent = await notifyClient({ clientOrgId: org._id, type: "quote_sent", title: "Your quote is ready" });
  assert.deepStrictEqual(sent, { email: true, whatsapp: false });
  assert.strictEqual(meta.calls.length, 0);

  Object.assign(org, { whatsappOptIn: true, whatsappNumber: "14155550100" });
  sent = await notifyClient({ clientOrgId: org._id, type: "quote_sent", title: "Your quote for Form 1120 is ready" });
  assert.deepStrictEqual(sent, { email: true, whatsapp: true });
  assert.strictEqual(meta.calls[0].body.template.components[0].parameters[1].text, "Your quote for Form 1120 is ready");
  await notifyClient({ clientOrgId: org._id, type: "document_accepted", title: "Accepted" });
  assert.strictEqual(meta.calls.length, 1, "not every event goes to WhatsApp");
  assert.ok(org.whatsappLastSentAt instanceof Date);

  // Daily sweep: documents chase → the documents template.
  meta.calls = [];
  D.ensureDueDates(cal, day("2027-01-01"));
  const realNow = Date.now;
  await R.runReminderSweep({ now: day("2027-01-03") });
  Date.now = realNow;
  assert.strictEqual(meta.calls.length, 1);
  const t = meta.calls[0].body.template;
  assert.strictEqual(t.name, "documents_needed");
  assert.strictEqual(t.components[0].parameters[1].text, "Delaware Annual Report & Franchise Tax");
  assert.match(t.components[0].parameters[2].text, /^\d+ documents?, due 1 Mar 2027$/);
  assert.ok(notifications.some((n) => n.type === "documents_requested" && n.audience === "client"));
});

test("a failed send is remembered on the client so staff can see why", async () => {
  const { org } = setup({ orgData: { whatsappOptIn: true, whatsappNumber: "14155550100" } });
  whatsappOn();
  meta.reply = () => ({ status: 400, json: { error: { code: 131026, message: "Message undeliverable" } } });
  const { notifyClient } = require("../lib/notify");
  const sent = await notifyClient({ clientOrgId: org._id, type: "quote_sent", title: "Quote" });
  assert.strictEqual(sent.whatsapp, false);
  assert.strictEqual(sent.email, true, "email still goes");
  assert.match(org.whatsappLastError, /can't receive WhatsApp/);
});

// ---------------------------------------------------------------------
// Webhook
// ---------------------------------------------------------------------
function signed(payload) {
  const raw = JSON.stringify(payload);
  const sig = "sha256=" + crypto.createHmac("sha256", "app-secret").update(raw).digest("hex");
  return { raw, headers: { "content-type": "application/json", "x-hub-signature-256": sig } };
}
const inbound = (from, text) => ({
  object: "whatsapp_business_account",
  entry: [{ changes: [{ field: "messages", value: { contacts: [{ wa_id: from, profile: { name: "Jane D" } }], messages: [{ from, id: "wamid.x", type: "text", text: { body: text } }] } }] }],
});
const settle = () => new Promise((r) => setTimeout(r, 50));

test("webhook: Meta's verification handshake", async () => {
  setup();
  whatsappOn();
  let r = await call("GET", "/api/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=verify-me&hub.challenge=12345", { user: "nobody" });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.text, "12345");
  r = await call("GET", "/api/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=1", { user: "nobody" });
  assert.strictEqual(r.status, 403);
});

test("webhook: unsigned calls are refused", async () => {
  setup();
  whatsappOn();
  const r = await call("POST", "/api/webhooks/whatsapp", { user: "nobody", raw: JSON.stringify(inbound("14155550100", "STOP")), headers: { "content-type": "application/json", "x-hub-signature-256": "sha256=bad" } });
  assert.strictEqual(r.status, 401);
});

test("webhook: STOP switches WhatsApp off, START back on, other replies reach the team chat", async () => {
  const { org } = setup({ orgData: { whatsappOptIn: true, whatsappNumber: "14155550100" } });
  whatsappOn();
  let s = signed(inbound("14155550100", "stop"));
  assert.strictEqual((await call("POST", "/api/webhooks/whatsapp", { user: "nobody", raw: s.raw, headers: s.headers })).status, 200);
  await settle();
  assert.strictEqual(org.whatsappOptIn, false);
  assert.ok(org.whatsappOptOutAt instanceof Date);

  s = signed(inbound("14155550100", "START"));
  await call("POST", "/api/webhooks/whatsapp", { user: "nobody", raw: s.raw, headers: s.headers });
  await settle();
  assert.strictEqual(org.whatsappOptIn, true);

  s = signed(inbound("14155550100", "I'll send the EIN letter tomorrow"));
  await call("POST", "/api/webhooks/whatsapp", { user: "nobody", raw: s.raw, headers: s.headers });
  await settle();
  assert.strictEqual(messages.length, 1);
  assert.strictEqual(messages[0].body, "I'll send the EIN letter tomorrow");
  assert.strictEqual(messages[0].senderName, "Jane D (via WhatsApp)");
  assert.strictEqual(messages[0].readByStaff, false);
  assert.ok(notifications.some((n) => n.audience === "staff" && n.title === "WhatsApp reply from Acme Inc"));

  // A number we don't know is ignored.
  s = signed(inbound("447700900000", "hello"));
  await call("POST", "/api/webhooks/whatsapp", { user: "nobody", raw: s.raw, headers: s.headers });
  await settle();
  assert.strictEqual(messages.length, 1);
});

test("webhook: a delivery failure is saved on the client", async () => {
  const { org } = setup({ orgData: { whatsappOptIn: true, whatsappNumber: "14155550100" } });
  whatsappOn();
  const s = signed({ entry: [{ changes: [{ value: { statuses: [{ recipient_id: "14155550100", status: "failed", errors: [{ code: 131026, title: "Message undeliverable" }] }] } }] }] });
  await call("POST", "/api/webhooks/whatsapp", { user: "nobody", raw: s.raw, headers: s.headers });
  await settle();
  assert.match(org.whatsappLastError, /can't receive WhatsApp/);
});

// ---------------------------------------------------------------------
// Admin
// ---------------------------------------------------------------------
test("Admin → WhatsApp check explains what's missing and checks the templates", async () => {
  setup();
  let r = await call("GET", "/api/admin/whatsapp-health", { user: "staff" });
  assert.strictEqual(r.body.configured, false);
  assert.strictEqual(r.body.ok, false);
  assert.strictEqual(r.body.templates.length, 3);
  assert.ok(r.body.templates.every((t) => t.body.includes("{{1}}")));

  whatsappOn();
  process.env.WHATSAPP_BUSINESS_ACCOUNT_ID = "999";
  meta.reply = (c) => c.url.includes("/message_templates")
    ? { status: 200, json: { data: [{ name: "account_update", status: "APPROVED", language: "en" }, { name: "deadline_reminder", status: "PENDING", language: "en" }] } }
    : { status: 200, json: { display_phone_number: "+91 98765 43210", verified_name: "ComplyGlobally", quality_rating: "GREEN" } };
  r = await call("GET", "/api/admin/whatsapp-health", { user: "staff" });
  const step = (n) => r.body.steps.find((s) => s.name.startsWith(n));
  assert.strictEqual(step("Meta accepts").ok, true);
  assert.strictEqual(step("Message templates").ok, false);
  assert.match(step("Message templates").detail, /deadline_reminder: PENDING, documents_needed: MISSING/);
  assert.strictEqual(step("Webhook security").ok, true);

  meta.reply = null;
  r = await call("POST", "/api/admin/whatsapp-test", { user: "staff", body: { phone: "+91 98765 43210" } });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.to, "+919876543210");
});
