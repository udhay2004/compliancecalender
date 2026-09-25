// tests/client-flow.test.js
//
// Drives the REAL portal routes, payment routes and Razorpay webhook over
// real HTTP. Replaced with in-memory stand-ins (via the require cache,
// same technique as tests/auth-flow.test.js): the Mongoose models, file
// storage, the Claude research call, Razorpay's API, email and the
// session check. Everything that decides behaviour — contact gate,
// service selection, pricing, checklist/document reuse, carry-over on
// regenerate, payment verification, amount checks, idempotency — is the
// production code.
//
//   node --test tests/

const test = require("node:test");
const assert = require("node:assert");
const http = require("node:http");
const path = require("node:path");
const crypto = require("node:crypto");

process.env.JWT_SECRET = "test-secret";
process.env.NODE_ENV = "test";
process.env.RAZORPAY_KEY_ID = "rzp_test_key";
process.env.RAZORPAY_KEY_SECRET = "rzp_test_secret";
process.env.RAZORPAY_WEBHOOK_SECRET = "rzp_webhook_secret";

const root = path.join(__dirname, "..");
// The real Calendar schema (status lists etc.), loaded before the in-memory
// stand-in replaces the model below.
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

let calendars = [];
let orgs = [];
const notifications = [];
const audit = [];

function query(result) {
  // Chainable + thenable, like a Mongoose Query.
  const q = {
    sort: () => q, select: () => q, lean: () => q, limit: () => q, populate: () => q,
    then: (res, rej) => Promise.resolve(typeof result === "function" ? result() : result).then(res, rej),
    catch: (rej) => Promise.resolve(typeof result === "function" ? result() : result).catch(rej),
  };
  return q;
}

function makeCalendarDoc(data) {
  const doc = Object.assign(
    { _id: oid(), status: "approved", supersededAt: null, supersedes: null, createdAt: new Date(), items: [] },
    data
  );
  doc.items = doc.items.map((it) => ({
    category: "Mandatory Annual", due_date: "31 March (Annually)", description: "", authority: "",
    clientStatus: "Not Started", paymentStatus: "Not Invoiced", feeAmountCents: null,
    razorpayOrderId: null, razorpayPaymentId: null, paidAt: null, paymentEvents: [], documents: [],
    selectedByClient: false, selectedAt: null, quoteNote: "", refunds: [],
    ...it,
  }));
  Object.defineProperty(doc, "save", { value: async () => doc, enumerable: false });
  Object.defineProperty(doc, "toObject", { value: () => clone(doc), enumerable: false });
  doc.profile = Object.assign({ companyName: "Acme Inc", state: "Delaware", entityType: "Corporation" }, doc.profile || {});
  Object.defineProperty(doc.profile, "toObject", { value: () => clone(doc.profile), enumerable: false });
  return doc;
}

function matches(doc, q) {
  return Object.entries(q).every(([k, v]) => {
    if (k === "$or") return v.some((sub) => matches(doc, sub));
    // Nested lookups like MongoDB: "items.x" and "items.<array>.x".
    const parts = k.split(".");
    if (parts[0] === "items" && parts.length === 2) return doc.items.some((it) => it[parts[1]] === v);
    if (parts[0] === "items" && parts.length === 3) return doc.items.some((it) => (it[parts[1]] || []).some((e) => e[parts[2]] === v));
    const actual = doc[k];
    if (v === null) return actual === null || actual === undefined;
    return String(actual) === String(v);
  });
}

const FakeCalendar = {
  schema: RealCalendarSchema,
  findOne: (q) => query(() => calendars.find((c) => matches(c, q)) || null),
  find: (q) => query(() => calendars.filter((c) => matches(c, q))),
  findById: (id) => query(() => calendars.find((c) => String(c._id) === String(id)) || null),
  create: async (data) => { const d = makeCalendarDoc(data); calendars.push(d); return d; },
};
const messages = [];

function makeOrg(data) {
  const org = Object.assign({ _id: oid(), name: "Acme Inc", primaryContactName: "", primaryContactEmail: "", primaryContactPhone: "", createdBy: "", assignedStaff: null }, data);
  Object.defineProperty(org, "save", { value: async () => org, enumerable: false });
  orgs.push(org);
  return org;
}
const FakeClientOrg = { findById: (id) => query(() => orgs.find((o) => String(o._id) === String(id)) || null) };

// Session: "x-test-user" header names which fake user is logged in.
const users = {};
const fakeAuth = {
  requireAuth: (req, res, next) => {
    const u = users[req.headers["x-test-user"]];
    if (!u) return res.status(401).json({ error: "Not logged in." });
    req.user = u; next();
  },
  requireClientRole: (req, res, next) => (req.user.role === "client" ? next() : res.status(403).json({ error: "client only" })),
  requireRole: () => (req, res, next) => next(),
  loadUserFromRequest: async () => { throw new Error("no session"); },
};

// Razorpay fake: remembers orders/payments; tests can set payment state.
const rzp = { orders: {}, payments: {}, created: 0, captured: [], refunds: [], refundSeq: 0 };
const fakeRazorpay = {
  orders: {
    create: async ({ amount, currency }) => { if (rzp.failWith) throw rzp.failWith; rzp.created++; const id = `order_${rzp.created}`; rzp.orders[id] = { id, amount, currency, status: "created" }; return rzp.orders[id]; },
    fetch: async (id) => rzp.orders[id],
    all: async () => { if (rzp.authFail) throw { statusCode: 401, error: { code: "BAD_REQUEST_ERROR", description: "Authentication failed" } }; return { items: [] }; },
    fetchPayments: async (id) => ({ items: Object.values(rzp.payments).filter((p) => p.order_id === id) }),
  },
  payments: {
    fetch: async (id) => rzp.payments[id],
    capture: async (id) => { rzp.captured.push(id); rzp.payments[id].status = "captured"; return rzp.payments[id]; },
    refund: async (pid, { amount }) => {
      if (rzp.refundFail) throw rzp.refundFail;
      const r = { id: `rfnd_${++rzp.refundSeq}`, payment_id: pid, amount, currency: "USD", status: "pending" };
      rzp.refunds.push(r);
      return r;
    },
  },
};

let generatedItems = [];
stub("models/Calendar.js", FakeCalendar);
stub("models/ClientOrg.js", FakeClientOrg);
stub("middleware/auth.js", fakeAuth);
stub("config/razorpay.js", fakeRazorpay);
// Fake storage: files "exist" unless their key is in lostKeys.
const lostKeys = new Set();
const storedBodies = new Map();
stub("lib/storage.js", {
  saveFile: async ({ fileName, buffer }) => { const k = `k/${fileName}`; storedBodies.set(k, buffer); return { fileKey: k, fileUrl: "" }; },
  getFile: async (k) => {
    if (lostKeys.has(k)) return null;
    const { Readable } = require("node:stream");
    return { stream: Readable.from([storedBodies.get(k) || Buffer.from("%PDF-1.4 stored")]), contentType: "application/pdf", contentLength: undefined };
  },
  getFileStream: async () => null,
  fileExists: async (k) => !lostKeys.has(k),
  findMissing: async (keys) => new Set(keys.filter((k) => lostKeys.has(k))),
});
stub("lib/claude.js", { generateCompanyCalendar: async () => ({ items: clone(generatedItems), sourceMode: "live" }) });
stub("lib/notify.js", {
  notifyStaff: async (n) => { notifications.push({ audience: "staff", ...n }); },
  notifyClient: async (n) => { notifications.push({ audience: "client", ...n }); },
});
stub("lib/auditLog.js", { logActivity: (e) => audit.push(e) });
stub("models/Message.js", { create: async (m) => { messages.push(m); return m; } });

// In-memory invoices and counters (models/Invoice.js, models/Counter.js).
let invoiceDocs = [];
const counters = {};
function makeInvoiceDoc(data) {
  const doc = { _id: oid(), refundedMinor: 0, ...data };
  if (data.clientOrgId) doc.clientOrgId = data.clientOrgId;
  Object.defineProperty(doc, "save", { value: async () => doc, enumerable: false });
  return doc;
}
const matchInv = (d, q) => Object.entries(q).every(([k, v]) => {
  if (v && typeof v === "object" && "$ne" in v) return d[k] !== v.$ne;
  return String(d[k]) === String(v);
});
const FakeInvoice = {
  findOne: (q) => query(() => invoiceDocs.find((d) => matchInv(d, q)) || null),
  findById: (id) => query(() => invoiceDocs.find((d) => String(d._id) === String(id)) || null),
  find: (q) => query(() => invoiceDocs.filter((d) => matchInv(d, q)).sort((a, b) => b.issuedAt - a.issuedAt)),
  exists: async (q) => invoiceDocs.some((d) => matchInv(d, q)),
  create: async (data) => {
    if (data.kind === "invoice" && invoiceDocs.some((d) => d.kind === "invoice" && d.razorpayPaymentId === data.razorpayPaymentId)) { const e = new Error("dup"); e.code = 11000; throw e; }
    if (invoiceDocs.some((d) => d.number === data.number)) { const e = new Error("dup number"); e.code = 11000; throw e; }
    const d = makeInvoiceDoc(data); invoiceDocs.push(d); return d;
  },
};
stub("models/Invoice.js", FakeInvoice);
stub("models/Counter.js", { next: async (name) => (counters[name] = (counters[name] || 0) + 1) });

const express = require("express");
const portalRoutes = require("../routes/portal.routes");
const paymentsRoutes = require("../routes/payments.routes");
const calendarRoutes = require("../routes/calendar.routes");
const { toView, normalizePhone } = require("../lib/calendarView");
const { getPriceInfo } = require("../lib/complianceFees");

const app = express();
app.post("/api/webhooks/razorpay", express.raw({ type: "application/json" }), paymentsRoutes.razorpayWebhookHandler);
app.use(express.json());
app.use("/api/portal", portalRoutes);
app.use("/api/portal/payments", paymentsRoutes);
app.use("/api/calendars", calendarRoutes);
app.use("/api/invoices", require("../routes/invoices.routes"));
app.use("/api/admin", require("../routes/admin.routes"));
app.use(errorHandler);

let server, base;
test.before(async () => {
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server.close());

async function call(method, url, { user = "client", body, form, headers = {} } = {}) {
  const opts = { method, headers: { "x-test-user": user, ...headers } };
  if (form) opts.body = form;
  else if (body !== undefined) { opts.body = typeof body === "string" ? body : JSON.stringify(body); opts.headers["content-type"] = "application/json"; }
  const res = await fetch(base + url, opts);
  const text = await res.text();
  let json = {}; try { json = JSON.parse(text); } catch {}
  return { status: res.status, body: json };
}

// Fresh client with one approved calendar for each test.
function setup({ phone = "+1 415 555 0100", items } = {}) {
  calendars = []; orgs = []; notifications.length = 0; audit.length = 0;
  rzp.orders = {}; rzp.payments = {}; rzp.captured = []; rzp.created = 0; rzp.failWith = null; rzp.refunds = []; rzp.refundSeq = 0; rzp.refundFail = null; invoiceDocs = []; Object.keys(counters).forEach((k) => delete counters[k]); lostKeys.clear();
  const org = makeOrg({ primaryContactEmail: "jane@acme.com", primaryContactPhone: phone, primaryContactName: "Jane" });
  users.client = { _id: oid(), email: "jane@acme.com", name: "Jane", role: "client", clientOrgId: org._id };
  users.other = { _id: oid(), email: "eve@evil.com", name: "Eve", role: "client", clientOrgId: makeOrg({ name: "Evil" })._id };
  const cal = makeCalendarDoc({
    clientOrgId: org._id,
    items: items || [
      { compliance_name: "Registered Agent Renewal" },
      { compliance_name: "Delaware Annual Report & Franchise Tax" },
      { compliance_name: "Form 1120 Federal Corporate Income Tax Return" },
    ],
  });
  calendars.push(cal);
  return { org, cal };
}

function pdfForm(label, name = "doc.pdf") {
  const f = new FormData();
  f.append("requirementLabel", label);
  f.append("file", new Blob(["%PDF-1.4 test"], { type: "application/pdf" }), name);
  return f;
}

// =====================================================================
// Pricing & phone rules (pure)
// =====================================================================
test("every item gets a client-facing price label", () => {
  assert.deepStrictEqual(getPriceInfo({ compliance_name: "Registered Agent Renewal" }).label, "$125");
  assert.strictEqual(getPriceInfo({ compliance_name: "Form 1120 return" }).label, "From $650");
  assert.strictEqual(getPriceInfo({ compliance_name: "Something new" }).kind, "quote");
  const invoiced = getPriceInfo({ compliance_name: "Registered Agent", feeAmountCents: 9950 });
  assert.strictEqual(invoiced.kind, "invoiced");
  assert.strictEqual(invoiced.label, "$99.50");
});

test("phone validation accepts international numbers and rejects junk", () => {
  assert.ok(normalizePhone("+91 98765 43210"));
  assert.ok(normalizePhone("(415) 555-0100"));
  assert.strictEqual(normalizePhone("call me"), null);
  assert.strictEqual(normalizePhone("123"), null);
  assert.strictEqual(normalizePhone(""), null);
});

// =====================================================================
// Contact details gate
// =====================================================================
test("a client without a phone can't select, upload or pay until they add one", async () => {
  const { cal } = setup({ phone: "" });
  let r = await call("POST", `/api/portal/calendars/${cal._id}/items/0/select`, { body: { selected: true } });
  assert.strictEqual(r.status, 409);
  assert.strictEqual(r.body.code, "CONTACT_INCOMPLETE");
  assert.deepStrictEqual(r.body.missing, ["phone"]);

  r = await call("POST", `/api/portal/calendars/${cal._id}/items/0/upload`, { form: pdfForm("Registered Agent Consent Letter") });
  assert.strictEqual(r.status, 409);

  r = await call("PATCH", "/api/portal/profile", { body: { phone: "not a phone" } });
  assert.strictEqual(r.status, 400);
  r = await call("PATCH", "/api/portal/profile", { body: { phone: "+1 415 555 0100" } });
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(r.body.profile.missing, []);

  r = await call("POST", `/api/portal/calendars/${cal._id}/items/0/select`, { body: { selected: true } });
  assert.strictEqual(r.status, 200);
});

test("a client can't blank out their email or phone", async () => {
  setup();
  const r = await call("PATCH", "/api/portal/profile", { body: { email: "" } });
  assert.strictEqual(r.status, 400);
});

// =====================================================================
// Selection, uploads, checklist, notifications
// =====================================================================
test("selecting a service splits selected / not selected and tells staff", async () => {
  const { cal } = setup();
  const r = await call("POST", `/api/portal/calendars/${cal._id}/items/1/select`, { body: { selected: true } });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.calendar.summary.selected, 1);
  assert.strictEqual(r.body.calendar.summary.notSelected, 2);
  assert.strictEqual(r.body.calendar.items[1].clientStatus, "Awaiting Documents");
  assert.ok(r.body.calendar.items.every((it) => it.price && it.price.label), "every item carries a price");
  await new Promise((r) => setImmediate(r));
  assert.ok(notifications.some((n) => n.audience === "staff" && n.type === "service_selected"));
});

test("uploading auto-selects the service, feeds the checklist, and is reused across filings", async () => {
  const { cal } = setup();
  // "Certificate of Incorporation / Formation" is needed by the Annual Report item.
  const r = await call("POST", `/api/portal/calendars/${cal._id}/items/1/upload`, { form: pdfForm("Certificate of Incorporation / Formation") });
  assert.strictEqual(r.status, 201);
  const item = r.body.calendar.items[1];
  assert.strictEqual(item.selectedByClient, true);
  assert.strictEqual(item.clientStatus, "Under Review");
  const row = item.checklist.find((c) => c.label === "Certificate of Incorporation / Formation");
  assert.strictEqual(row.state, "pending");
  assert.strictEqual(r.body.calendar.summary.documentsPendingReview, 1);
  await new Promise((r) => setImmediate(r));
  assert.ok(notifications.some((n) => n.audience === "staff" && n.type === "document_uploaded"));
});

test("a rejected upload stops satisfying the checklist", () => {
  const { cal } = setup();
  cal.items[0].documents.push({ type: "client_upload", requirementLabel: "Registered Agent Consent Letter", reviewStatus: "rejected", fileName: "x.pdf" });
  const view = toView(cal, { staff: true });
  const row = view.items[0].checklist.find((c) => c.label === "Registered Agent Consent Letter");
  assert.strictEqual(row.state, "rejected");
  assert.strictEqual(view.items[0].checklistSummary.allProvided, false);
});

test("a client can't drop a service that's already been priced", async () => {
  const { cal } = setup();
  Object.assign(cal.items[0], { selectedByClient: true, paymentStatus: "Invoiced", feeAmountCents: 12500 });
  const r = await call("POST", `/api/portal/calendars/${cal._id}/items/0/select`, { body: { selected: false } });
  assert.strictEqual(r.status, 400);
});

test("one client can never reach another client's calendar", async () => {
  const { cal } = setup();
  const r1 = await call("GET", `/api/portal/calendars/${cal._id}`, { user: "other" });
  assert.strictEqual(r1.status, 404);
  const r2 = await call("POST", `/api/portal/payments/calendars/${cal._id}/items/0/create-order`, { user: "other" });
  assert.strictEqual(r2.status, 404);
});

// =====================================================================
// History & regeneration
// =====================================================================
test("regenerating keeps the old calendar and carries selections, documents and payments over", async () => {
  const { cal } = setup();
  Object.assign(cal.items[0], {
    selectedByClient: true, paymentStatus: "Paid", feeAmountCents: 12500, razorpayPaymentId: "pay_old",
    documents: [{ type: "client_upload", requirementLabel: "Registered Agent Consent Letter", reviewStatus: "accepted", fileName: "consent.pdf", fileKey: "k" }],
  });
  generatedItems = [
    { category: "Mandatory Annual", compliance_name: "Registered Agent Renewal", due_date: "1 March" },
    { category: "Conditional", compliance_name: "Brand New Filing", due_date: "1 June" },
  ];
  const r = await call("POST", "/api/portal/calendars/regenerate", { body: { calendarId: cal._id, profile: { entityType: "LLC", state: "Texas" } } });
  assert.strictEqual(r.status, 201, JSON.stringify(r.body));
  assert.strictEqual(r.body.carried, 1);
  const carried = r.body.calendar.items[0];
  assert.strictEqual(carried.paymentStatus, "Paid");
  assert.strictEqual(carried.selectedByClient, true);
  assert.strictEqual(carried.documents.length, 1);
  assert.strictEqual(r.body.calendar.profile.entityType, "LLC");
  assert.strictEqual(r.body.calendar.profile.state, "Delaware", "state can't be changed by a regenerate");

  assert.ok(cal.supersededAt, "old calendar is marked superseded, not deleted");
  const list = await call("GET", "/api/portal/calendars");
  assert.strictEqual(list.body.calendars.length, 2);
  assert.strictEqual(list.body.calendars[0]._id, r.body.calendar._id, "current calendar listed first");

  await new Promise((r) => setImmediate(r));
  assert.ok(notifications.some((n) => n.audience === "client" && n.type === "calendar_regenerated"));
  assert.ok(notifications.some((n) => n.audience === "staff" && n.type === "calendar_regenerated"));

  const blocked = await call("POST", `/api/portal/calendars/${cal._id}/items/1/select`, { body: { selected: true } });
  assert.strictEqual(blocked.status, 400, "old calendar is read-only");
});

// =====================================================================
// Razorpay
// =====================================================================
function readyToPay(cal) {
  // Registered Agent: two required docs, both uploaded, invoiced at $125.
  Object.assign(cal.items[0], {
    selectedByClient: true, paymentStatus: "Invoiced", feeAmountCents: 12500,
    documents: [
      { type: "client_upload", requirementLabel: "Registered Agent Consent Letter", reviewStatus: "accepted", fileName: "a.pdf", fileKey: "a" },
      { type: "client_upload", requirementLabel: "Registered Office Address Proof", reviewStatus: "pending", fileName: "b.pdf", fileKey: "b" },
    ],
  });
}
const sign = (orderId, paymentId) => crypto.createHmac("sha256", process.env.RAZORPAY_KEY_SECRET).update(`${orderId}|${paymentId}`).digest("hex");

test("payment is blocked until the price is sent and all documents are in", async () => {
  const { cal } = setup();
  let r = await call("POST", `/api/portal/payments/calendars/${cal._id}/items/0/create-order`);
  assert.strictEqual(r.status, 400);
  Object.assign(cal.items[0], { paymentStatus: "Invoiced", feeAmountCents: 12500 });
  r = await call("POST", `/api/portal/payments/calendars/${cal._id}/items/0/create-order`);
  assert.strictEqual(r.status, 400);
  assert.match(r.body.error, /documents/);
});

test("create-order charges the server-side fee and reuses the open order", async () => {
  const { cal } = setup();
  readyToPay(cal);
  const a = await call("POST", `/api/portal/payments/calendars/${cal._id}/items/0/create-order`, { body: { amount: 1 } });
  assert.strictEqual(a.status, 200);
  assert.strictEqual(a.body.amount, 12500, "browser-sent amount is ignored");
  assert.strictEqual(a.body.prefill.contact, "+1 415 555 0100");
  const b = await call("POST", `/api/portal/payments/calendars/${cal._id}/items/0/create-order`);
  assert.strictEqual(b.body.orderId, a.body.orderId);
  assert.strictEqual(rzp.created, 1);
});

test("verify rejects a forged signature", async () => {
  const { cal } = setup();
  readyToPay(cal);
  const { body: order } = await call("POST", `/api/portal/payments/calendars/${cal._id}/items/0/create-order`);
  const r = await call("POST", `/api/portal/payments/calendars/${cal._id}/items/0/verify`, {
    body: { razorpay_order_id: order.orderId, razorpay_payment_id: "pay_1", razorpay_signature: "00".repeat(32) },
  });
  assert.strictEqual(r.status, 400);
  assert.strictEqual(cal.items[0].paymentStatus, "Invoiced");
});

test("verify captures an 'authorized' payment before marking it paid", async () => {
  const { cal } = setup();
  readyToPay(cal);
  const { body: order } = await call("POST", `/api/portal/payments/calendars/${cal._id}/items/0/create-order`);
  rzp.payments.pay_1 = { id: "pay_1", order_id: order.orderId, amount: 12500, currency: "USD", status: "authorized" };
  const r = await call("POST", `/api/portal/payments/calendars/${cal._id}/items/0/verify`, {
    body: { razorpay_order_id: order.orderId, razorpay_payment_id: "pay_1", razorpay_signature: sign(order.orderId, "pay_1") },
  });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  assert.deepStrictEqual(rzp.captured, ["pay_1"]);
  assert.strictEqual(cal.items[0].paymentStatus, "Paid");
  await new Promise((r) => setImmediate(r));
  assert.ok(notifications.some((n) => n.audience === "client" && n.type === "payment_received"));
  assert.ok(notifications.some((n) => n.audience === "staff" && n.type === "payment_received"));
});

test("a payment for the wrong amount is flagged, not marked paid", async () => {
  const { cal } = setup();
  readyToPay(cal);
  const { body: order } = await call("POST", `/api/portal/payments/calendars/${cal._id}/items/0/create-order`);
  rzp.payments.pay_2 = { id: "pay_2", order_id: order.orderId, amount: 100, currency: "USD", status: "captured" };
  const r = await call("POST", `/api/portal/payments/calendars/${cal._id}/items/0/verify`, {
    body: { razorpay_order_id: order.orderId, razorpay_payment_id: "pay_2", razorpay_signature: sign(order.orderId, "pay_2") },
  });
  assert.strictEqual(r.status, 409);
  assert.strictEqual(cal.items[0].paymentStatus, "Invoiced");
  assert.ok(cal.items[0].paymentEvents.some((e) => e.event === "amount_mismatch"));
});

function webhook(payload, secret = process.env.RAZORPAY_WEBHOOK_SECRET) {
  const raw = JSON.stringify(payload);
  const sig = crypto.createHmac("sha256", secret).update(raw).digest("hex");
  return call("POST", "/api/webhooks/razorpay", { user: "nobody", body: raw, headers: { "x-razorpay-signature": sig } });
}
const captured = (orderId, paymentId, amount = 12500) => ({
  event: "payment.captured",
  payload: { payment: { entity: { id: paymentId, order_id: orderId, amount, currency: "USD", status: "captured" } } },
});

test("webhook rejects a bad signature", async () => {
  setup();
  const r = await webhook(captured("order_x", "pay_x"), "wrong-secret");
  assert.strictEqual(r.status, 400);
});

test("webhook records payment on an OLDER order (client opened checkout twice)", async () => {
  const { cal } = setup();
  readyToPay(cal);
  // First checkout → order_1. Then fee changes, forcing a fresh order_2.
  const first = (await call("POST", `/api/portal/payments/calendars/${cal._id}/items/0/create-order`)).body.orderId;
  cal.items[0].razorpayOrderId = null; // what the fee-change path does
  const second = (await call("POST", `/api/portal/payments/calendars/${cal._id}/items/0/create-order`)).body.orderId;
  assert.notStrictEqual(first, second);
  assert.strictEqual(cal.items[0].razorpayOrderId, second);

  // …but the client pays the FIRST popup.
  const r = await webhook(captured(first, "pay_old_popup"));
  assert.strictEqual(r.status, 200);
  assert.strictEqual(cal.items[0].paymentStatus, "Paid", "previously this payment was lost");
  assert.strictEqual(cal.items[0].razorpayPaymentId, "pay_old_popup");
});

test("webhook retries don't double-record or double-notify", async () => {
  const { cal } = setup();
  readyToPay(cal);
  const { body: order } = await call("POST", `/api/portal/payments/calendars/${cal._id}/items/0/create-order`);
  await webhook(captured(order.orderId, "pay_9"));
  await webhook(captured(order.orderId, "pay_9"));
  await webhook(captured(order.orderId, "pay_9"));
  const events = cal.items[0].paymentEvents.filter((e) => e.event === "webhook_captured");
  assert.strictEqual(events.length, 1);
  assert.strictEqual(notifications.filter((n) => n.type === "payment_received" && n.audience === "client").length, 1);
});

test("a second successful payment for an already-paid item is flagged for refund", async () => {
  const { cal } = setup();
  readyToPay(cal);
  const { body: order } = await call("POST", `/api/portal/payments/calendars/${cal._id}/items/0/create-order`);
  await webhook(captured(order.orderId, "pay_a"));
  await webhook(captured(order.orderId, "pay_b"));
  assert.strictEqual(cal.items[0].razorpayPaymentId, "pay_a");
  assert.ok(cal.items[0].paymentEvents.some((e) => e.event === "duplicate_payment" && e.razorpayPaymentId === "pay_b"));
});

test("a payment on a superseded calendar shows as paid on the new one", async () => {
  const { cal } = setup();
  readyToPay(cal);
  const { body: order } = await call("POST", `/api/portal/payments/calendars/${cal._id}/items/0/create-order`);
  generatedItems = [{ category: "Mandatory Annual", compliance_name: "Registered Agent Renewal", due_date: "1 March" }];
  const regen = await call("POST", "/api/portal/calendars/regenerate", { body: { calendarId: cal._id, profile: {} } });
  assert.strictEqual(regen.status, 201);
  const fresh = calendars.find((c) => c._id === regen.body.calendar._id);
  assert.strictEqual(fresh.items[0].paymentStatus, "Invoiced");

  await webhook(captured(order.orderId, "pay_late"));
  assert.strictEqual(cal.items[0].paymentStatus, "Paid");
  assert.strictEqual(fresh.items[0].paymentStatus, "Paid");
});

// =====================================================================
// Staff: sending a price while verifying documents
// =====================================================================
test("staff see the same checklist and prices, split by what the client selected", async () => {
  const { cal } = setup();
  users.staff = { _id: oid(), email: "tech@firm.com", name: "Tech", role: "staff" };
  cal.items[0].selectedByClient = true;
  const r = await call("GET", `/api/calendars/${cal._id}`, { user: "staff" });
  assert.strictEqual(r.status, 200);
  const it = r.body.calendar.items[0];
  assert.strictEqual(it.price.label, "$125");
  assert.strictEqual(it.suggestedFee.amountCents, 12500);
  assert.ok(Array.isArray(it.checklist) && it.checklist.length === 2);
  assert.strictEqual(r.body.calendar.summary.selected, 1);
});

test("send price: invoices the item, posts in chat, notifies the client", async () => {
  const { cal } = setup();
  users.staff = { _id: oid(), email: "tech@firm.com", name: "Tech", role: "staff" };
  messages.length = 0;
  let r = await call("POST", `/api/calendars/${cal._id}/items/2/quote`, { user: "staff", body: { feeAmountUSD: 0 } });
  assert.strictEqual(r.status, 400);
  r = await call("POST", `/api/calendars/${cal._id}/items/2/quote`, { user: "staff", body: { feeAmountUSD: 700, note: "Includes one extra state" } });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  const it = cal.items[2];
  assert.strictEqual(it.feeAmountCents, 70000);
  assert.strictEqual(it.paymentStatus, "Invoiced");
  assert.strictEqual(it.selectedByClient, true);
  assert.strictEqual(r.body.calendar.items[2].price.label, "$700");
  assert.match(messages[0].body, /\$700/);
  await new Promise((r) => setImmediate(r));
  assert.ok(notifications.some((n) => n.audience === "client" && n.type === "quote_sent"));
});

test("changing a price voids the open Razorpay order so the old price can't be paid", async () => {
  const { cal } = setup();
  users.staff = { _id: oid(), email: "tech@firm.com", name: "Tech", role: "staff" };
  readyToPay(cal);
  const { body: order } = await call("POST", `/api/portal/payments/calendars/${cal._id}/items/0/create-order`);
  await call("POST", `/api/calendars/${cal._id}/items/0/quote`, { user: "staff", body: { feeAmountUSD: 150 } });
  assert.strictEqual(cal.items[0].razorpayOrderId, null);
  assert.ok(cal.items[0].paymentEvents.some((e) => e.event === "order_voided" && e.razorpayOrderId === order.orderId));
  const again = await call("POST", `/api/portal/payments/calendars/${cal._id}/items/0/create-order`);
  assert.strictEqual(again.body.amount, 15000);
  assert.notStrictEqual(again.body.orderId, order.orderId);
});

test("a paid item can't be re-priced", async () => {
  const { cal } = setup();
  users.staff = { _id: oid(), email: "tech@firm.com", name: "Tech", role: "staff" };
  Object.assign(cal.items[0], { paymentStatus: "Paid", feeAmountCents: 12500 });
  const r = await call("POST", `/api/calendars/${cal._id}/items/0/quote`, { user: "staff", body: { feeAmountUSD: 10 } });
  assert.strictEqual(r.status, 400);
});

// =====================================================================
// Prices from the price list apply automatically
// =====================================================================
test("choosing a service with a fixed list price prices it straight away", async () => {
  const { cal } = setup();
  const r = await call("POST", `/api/portal/calendars/${cal._id}/items/0/select`, { body: { selected: true } });
  assert.strictEqual(r.status, 200);
  const it = r.body.calendar.items[0];
  assert.strictEqual(it.paymentStatus, "Invoiced");
  assert.strictEqual(it.feeAmountCents, 12500);
  assert.strictEqual(it.quotedBy, "price-list");
  assert.strictEqual(it.price.kind, "invoiced");
  await new Promise((r) => setImmediate(r));
  assert.ok(notifications.some((n) => n.audience === "staff" && /applied automatically/.test(n.body)));
});

test("a 'From' price or an unlisted service waits for staff, with the contact-you message", async () => {
  const { cal } = setup({ items: [{ compliance_name: "Form 1120 Federal Corporate Income Tax Return" }, { compliance_name: "Some Brand-New State Filing" }] });
  let r = await call("POST", `/api/portal/calendars/${cal._id}/items/0/select`, { body: { selected: true } });
  assert.strictEqual(r.body.calendar.items[0].paymentStatus, "Not Invoiced");
  assert.match(r.body.calendar.items[0].price.message, /as soon as you upload your documents/);
  r = await call("POST", `/api/portal/calendars/${cal._id}/items/1/select`, { body: { selected: true } });
  const it = r.body.calendar.items[1];
  assert.strictEqual(it.price.label, "Price on request");
  assert.strictEqual(it.price.message, "We'll contact you with the price as soon as you upload your documents.");
});

test("uploading a document for a fixed-price service also applies the price", async () => {
  const { cal } = setup();
  const r = await call("POST", `/api/portal/calendars/${cal._id}/items/0/upload`, { form: pdfForm("Registered Agent Consent Letter") });
  assert.strictEqual(r.status, 201);
  assert.strictEqual(r.body.calendar.items[0].feeAmountCents, 12500);
});

test("removing an automatically priced service removes its price; a hand-sent price can't be dropped", async () => {
  const { cal } = setup();
  await call("POST", `/api/portal/calendars/${cal._id}/items/0/select`, { body: { selected: true } });
  const r = await call("POST", `/api/portal/calendars/${cal._id}/items/0/select`, { body: { selected: false } });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.calendar.items[0].paymentStatus, "Not Invoiced");
  assert.strictEqual(r.body.calendar.items[0].feeAmountCents, null);

  Object.assign(cal.items[1], { selectedByClient: true, paymentStatus: "Invoiced", feeAmountCents: 9000, quotedBy: "tech@firm.com" });
  const r2 = await call("POST", `/api/portal/calendars/${cal._id}/items/1/select`, { body: { selected: false } });
  assert.strictEqual(r2.status, 400);
});

// =====================================================================
// Files lost from storage
// =====================================================================
function withUpload(cal, key = "k/lease.pdf") {
  cal.items[0].selectedByClient = true;
  cal.items[0].documents.push({ type: "client_upload", requirementLabel: "Registered Office Address Proof", reviewStatus: "accepted", fileName: "lease.pdf", fileKey: key, uploadedAt: new Date() });
}

test("a lost file shows as missing on both sides and stops counting as provided", async () => {
  const { cal } = setup();
  users.staff = { _id: oid(), email: "tech@firm.com", name: "Tech", role: "staff" };
  withUpload(cal);
  lostKeys.add("k/lease.pdf");
  const staff = await call("GET", `/api/calendars/${cal._id}`, { user: "staff" });
  assert.strictEqual(staff.body.calendar.items[0].documents[0].fileMissing, true);
  assert.strictEqual(staff.body.calendar.summary.filesMissing, 1);
  const row = staff.body.calendar.items[0].checklist.find((c) => c.label === "Registered Office Address Proof");
  assert.strictEqual(row.state, "missing");
  assert.strictEqual(row.lost, true);

  const client = await call("GET", `/api/portal/calendars/${cal._id}`);
  assert.strictEqual(client.body.calendar.items[0].documents[0].fileMissing, true);
});

test("staff can't verify a lost file", async () => {
  const { cal } = setup();
  users.staff = { _id: oid(), email: "tech@firm.com", name: "Tech", role: "staff" };
  withUpload(cal);
  cal.items[0].documents[0].reviewStatus = "pending";
  lostKeys.add("k/lease.pdf");
  const r = await call("PATCH", `/api/calendars/${cal._id}/items/0/documents/0/review`, { user: "staff", body: { reviewStatus: "accepted" } });
  assert.strictEqual(r.status, 409);
  assert.strictEqual(r.body.code, "FILE_MISSING");
});

test("downloading a lost file gives a readable page, not raw JSON", async () => {
  const { cal } = setup();
  users.staff = { _id: oid(), email: "tech@firm.com", name: "Tech", role: "staff" };
  withUpload(cal);
  lostKeys.add("k/lease.pdf");
  const res = await fetch(`${base}/api/calendars/${cal._id}/items/0/documents/0/download`, { headers: { "x-test-user": "staff", accept: "text/html" } });
  assert.strictEqual(res.status, 404);
  const html = await res.text();
  assert.match(res.headers.get("content-type"), /html/);
  assert.match(html, /isn(&#39;|')t in storage any more/);
  assert.match(html, /Ask client to re-upload/);
});

test("downloading a stored file works, and 'Open' shows PDFs inline", async () => {
  const { cal } = setup();
  users.staff = { _id: oid(), email: "tech@firm.com", name: "Tech", role: "staff" };
  withUpload(cal);
  let res = await fetch(`${base}/api/calendars/${cal._id}/items/0/documents/0/download`, { headers: { "x-test-user": "staff" } });
  assert.strictEqual(res.status, 200);
  assert.match(res.headers.get("content-disposition"), /^attachment/);
  assert.match(await res.text(), /%PDF/);
  res = await fetch(`${base}/api/calendars/${cal._id}/items/0/documents/0/download?view=1`, { headers: { "x-test-user": "staff" } });
  assert.match(res.headers.get("content-disposition"), /^inline/);
  assert.strictEqual(res.headers.get("content-type"), "application/pdf");
});

test("payment stays locked while a required document is lost", async () => {
  const { cal } = setup();
  readyToPay(cal);
  lostKeys.add("b");
  const r = await call("POST", `/api/portal/payments/calendars/${cal._id}/items/0/create-order`);
  assert.strictEqual(r.status, 400);
  assert.match(r.body.error, /documents/);
});

// =====================================================================
// When Razorpay refuses, and charging in rupees
// =====================================================================
const { explainRazorpayError } = require("../lib/paymentConfig");

test("Razorpay errors are explained in plain words", () => {
  const cur = explainRazorpayError({ statusCode: 400, error: { code: "BAD_REQUEST_ERROR", description: "Currency USD is not supported" } });
  assert.match(cur.reason, /can't accept USD/);
  assert.match(cur.fix, /International Payments|PAYMENT_CURRENCY=INR/);
  const auth = explainRazorpayError({ statusCode: 401, error: { code: "BAD_REQUEST_ERROR", description: "Authentication failed" } });
  assert.match(auth.reason, /rejected the API keys/);
  const keys = explainRazorpayError(Object.assign(new Error("x"), { code: "RAZORPAY_NOT_CONFIGURED" }));
  assert.match(keys.fix, /RAZORPAY_KEY_ID/);
});

test("if Razorpay refuses, the client gets a clear message and the team is told why", async () => {
  const { cal } = setup();
  readyToPay(cal);
  rzp.failWith = { statusCode: 400, error: { code: "BAD_REQUEST_ERROR", description: "Currency USD is not supported" } };
  const r = await call("POST", `/api/portal/payments/calendars/${cal._id}/items/0/create-order`);
  assert.strictEqual(r.status, 500);
  assert.strictEqual(r.body.code, "PAYMENT_UNAVAILABLE");
  assert.match(r.body.error, /haven't been charged/);
  await new Promise((r) => setImmediate(r));
  const alert = notifications.find((n) => n.audience === "staff" && n.type === "payment_failed");
  assert.ok(alert, "staff alerted");
  assert.match(alert.body, /International Payments/);
});

test("PAYMENT_CURRENCY=INR charges rupees at the set rate and verifies against that amount", async () => {
  process.env.PAYMENT_CURRENCY = "INR";
  process.env.USD_TO_INR_RATE = "83.5";
  try {
    const { cal } = setup();
    readyToPay(cal); // $125
    const { body: order } = await call("POST", `/api/portal/payments/calendars/${cal._id}/items/0/create-order`);
    assert.strictEqual(order.currency, "INR");
    assert.strictEqual(order.amount, 1043750); // ₹10,437.50 in paise
    assert.match(order.conversionNote, /\$125 is charged as ₹10,437\.50/);

    // Reuses the same rupee order on a second click
    const again = await call("POST", `/api/portal/payments/calendars/${cal._id}/items/0/create-order`);
    assert.strictEqual(again.body.orderId, order.orderId);

    rzp.payments.pay_inr = { id: "pay_inr", order_id: order.orderId, amount: 1043750, currency: "INR", status: "captured" };
    const v = await call("POST", `/api/portal/payments/calendars/${cal._id}/items/0/verify`, {
      body: { razorpay_order_id: order.orderId, razorpay_payment_id: "pay_inr", razorpay_signature: sign(order.orderId, "pay_inr") },
    });
    assert.strictEqual(v.status, 200, JSON.stringify(v.body));
    assert.strictEqual(cal.items[0].paymentStatus, "Paid");
  } finally {
    delete process.env.PAYMENT_CURRENCY;
    delete process.env.USD_TO_INR_RATE;
  }
});

test("INR without a rate is reported, not silently mischarged", async () => {
  process.env.PAYMENT_CURRENCY = "INR";
  try {
    const { cal } = setup();
    readyToPay(cal);
    const r = await call("POST", `/api/portal/payments/calendars/${cal._id}/items/0/create-order`);
    assert.strictEqual(r.status, 500);
    await new Promise((r) => setImmediate(r));
    assert.ok(notifications.some((n) => n.type === "payment_failed" && /USD_TO_INR_RATE/.test(n.body)));
  } finally { delete process.env.PAYMENT_CURRENCY; }
});

test("Admin → Check payments pinpoints the problem", async () => {
  setup();
  users.admin = { _id: oid(), email: "admin@firm.com", name: "Admin", role: "admin" };
  process.env.RAZORPAY_WEBHOOK_SECRET = "rzp_webhook_secret";

  rzp.failWith = { statusCode: 400, error: { code: "BAD_REQUEST_ERROR", description: "Currency USD is not supported" } };
  let r = await call("GET", "/api/admin/payments-health", { user: "admin" });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.ok, false);
  const cur = r.body.steps.find((st) => /create a USD payment/.test(st.name));
  assert.strictEqual(cur.ok, false);
  assert.match(cur.fix, /International Payments/);

  rzp.failWith = null; rzp.authFail = true;
  r = await call("GET", "/api/admin/payments-health", { user: "admin" });
  assert.match(r.body.steps.find((st) => /accepts the keys/.test(st.name)).fix, /API Keys/);

  rzp.authFail = false;
  process.env.APP_URL = "https://example.test";
  r = await call("GET", "/api/admin/payments-health", { user: "admin" });
  assert.strictEqual(r.body.ok, true, JSON.stringify(r.body.steps));
  assert.strictEqual(r.body.mode, "test");
  delete process.env.APP_URL;
});

// =====================================================================
// Proof of completion (finance / whoever did the work)
// =====================================================================
function proofForm(files, fields = {}) {
  const f = new FormData();
  files.forEach(([name, type]) => f.append("files", new Blob(["%PDF-1.4 proof"], { type }), name));
  Object.entries(fields).forEach(([k, v]) => f.append(k, v));
  return f;
}

test("finance uploads proof: files + reference + note, service marked done, client told", async () => {
  const { cal } = setup();
  users.fin = { _id: oid(), email: "fin@firm.com", name: "Rahul", role: "staff", department: "finance" };
  Object.assign(cal.items[0], { selectedByClient: true, paymentStatus: "Paid", feeAmountCents: 12500 });
  const r = await call("POST", `/api/calendars/${cal._id}/items/0/certificate`, {
    user: "fin",
    form: proofForm([["ack.pdf", "application/pdf"], ["receipt.png", "image/png"]], {
      referenceNumber: "DE-2026-99812", completedOn: "2026-09-20", note: "Filed with Delaware; next due 1 March 2027.",
    }),
  });
  assert.strictEqual(r.status, 201, JSON.stringify(r.body));
  const it = cal.items[0];
  const proofs = it.documents.filter((d) => d.type === "certificate");
  assert.strictEqual(proofs.length, 2);
  assert.strictEqual(proofs[0].referenceNumber, "DE-2026-99812");
  assert.strictEqual(proofs[0].uploadedByDepartment, "finance");
  assert.strictEqual(proofs[0].uploadedByName, "Rahul");
  assert.strictEqual(it.clientStatus, "Filed");
  assert.strictEqual(it.completedBy, "fin@firm.com");
  assert.strictEqual(new Date(it.completedAt).toISOString().slice(0, 10), "2026-09-20");
  await new Promise((r) => setImmediate(r));
  const n = notifications.find((x) => x.audience === "client" && x.type === "certificate_uploaded");
  assert.match(n.title, /is done/);
  assert.match(n.body, /DE-2026-99812/);
  assert.match(n.body, /next due 1 March 2027/);
  assert.ok(audit.some((a) => a.action === "proof_uploaded"));

  // Client sees it in the portal with the details.
  const p = await call("GET", `/api/portal/calendars/${cal._id}`);
  const cert = p.body.calendar.items[0].documents.find((d) => d.type === "certificate");
  assert.strictEqual(cert.referenceNumber, "DE-2026-99812");
  assert.strictEqual(cert.proofNote, "Filed with Delaware; next due 1 March 2027.");
});

test("proof can be attached without marking done", async () => {
  const { cal } = setup();
  users.fin = { _id: oid(), email: "fin@firm.com", name: "Rahul", role: "staff", department: "finance" };
  cal.items[0].clientStatus = "Under Review";
  const r = await call("POST", `/api/calendars/${cal._id}/items/0/certificate`, { user: "fin", form: proofForm([["draft.pdf", "application/pdf"]], { markDone: "false" }) });
  assert.strictEqual(r.status, 201);
  assert.strictEqual(cal.items[0].clientStatus, "Under Review");
  assert.ok(!cal.items[0].completedAt);
});

test("proof upload validation: no file, future date, wrong file type", async () => {
  const { cal } = setup();
  users.fin = { _id: oid(), email: "fin@firm.com", name: "Rahul", role: "staff", department: "finance" };
  let r = await call("POST", `/api/calendars/${cal._id}/items/0/certificate`, { user: "fin", form: proofForm([], { note: "x" }) });
  assert.strictEqual(r.status, 400);
  assert.match(r.body.error, /at least one file/);
  r = await call("POST", `/api/calendars/${cal._id}/items/0/certificate`, { user: "fin", form: proofForm([["a.pdf", "application/pdf"]], { completedOn: "2099-01-01" }) });
  assert.strictEqual(r.status, 400);
  assert.match(r.body.error, /future/);
  r = await call("POST", `/api/calendars/${cal._id}/items/0/certificate`, { user: "fin", form: proofForm([["evil.html", "text/html"]]) });
  assert.strictEqual(r.status, 400);
  assert.match(r.body.error, /PDF, image/);
});

test("removing the last proof un-marks the service as done, and is logged", async () => {
  const { cal } = setup();
  users.fin = { _id: oid(), email: "fin@firm.com", name: "Rahul", role: "staff", department: "finance" };
  await call("POST", `/api/calendars/${cal._id}/items/0/certificate`, { user: "fin", form: proofForm([["ack.pdf", "application/pdf"]]) });
  assert.strictEqual(cal.items[0].clientStatus, "Filed");
  const docIdx = cal.items[0].documents.findIndex((d) => d.type === "certificate");
  const r = await call("DELETE", `/api/calendars/${cal._id}/items/0/certificate/${docIdx}`, { user: "fin" });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(cal.items[0].documents.filter((d) => d.type === "certificate").length, 0);
  assert.strictEqual(cal.items[0].clientStatus, "Under Review");
  assert.ok(audit.some((a) => a.action === "proof_removed"));
  // Can't delete a client's upload through this route
  cal.items[0].documents.push({ type: "client_upload", fileKey: "k", fileName: "c.pdf" });
  const bad = await call("DELETE", `/api/calendars/${cal._id}/items/0/certificate/${cal.items[0].documents.length - 1}`, { user: "fin" });
  assert.strictEqual(bad.status, 404);
});

test("old single-file certificate upload still works", async () => {
  const { cal } = setup();
  users.staff = { _id: oid(), email: "tech@firm.com", name: "Tech", role: "staff" };
  const f = new FormData();
  f.append("file", new Blob(["%PDF"], { type: "application/pdf" }), "cert.pdf");
  const r = await call("POST", `/api/calendars/${cal._id}/items/0/certificate`, { user: "staff", form: f });
  assert.strictEqual(r.status, 201);
  assert.strictEqual(cal.items[0].clientStatus, "Filed");
});

// =====================================================================
// Real deadlines through the routes
// =====================================================================
test("uploading proof rolls the filing to next period and tells the client the date", async () => {
  const { cal } = setup();
  users.fin = { _id: oid(), email: "fin@firm.com", name: "Rahul", role: "staff", department: "finance" };
  cal.profile.fyEnd = "Dec";
  Object.assign(cal.items[1], { selectedByClient: true, paymentStatus: "Paid", feeAmountCents: 10000, due_date: "1 March (Annually)", dueDateActual: new Date("2027-03-01T00:00:00Z"), dueDateSource: "auto" });
  const before = cal.items.length;
  const r = await call("POST", `/api/calendars/${cal._id}/items/1/certificate`, { user: "fin", form: proofForm([["ack.pdf", "application/pdf"]]) });
  assert.strictEqual(r.status, 201);
  assert.strictEqual(cal.items.length, before + 1);
  assert.strictEqual(cal.items[1].isHistory, true);
  const nextItem = cal.items[before];
  assert.strictEqual(nextItem.dueDateActual.toISOString().slice(0, 10), "2028-03-01");
  assert.strictEqual(nextItem.selectedByClient, true);
  assert.strictEqual(nextItem.feeAmountCents, 10000, "list price for the annual report applied again");
  await new Promise((r) => setImmediate(r));
  const n = notifications.find((x) => x.audience === "client" && x.type === "certificate_uploaded");
  assert.match(n.body, /Next due date for this filing: 1 Mar 2028/);

  // The past period can't be selected/deselected any more.
  const sel = await call("POST", `/api/portal/calendars/${cal._id}/items/1/select`, { body: { selected: false } });
  assert.strictEqual(sel.status, 400);
  // It's excluded from the counts.
  const v = await call("GET", `/api/portal/calendars/${cal._id}`);
  assert.strictEqual(v.body.calendar.summary.historyItems, 1);
  assert.strictEqual(v.body.calendar.summary.totalItems, before);
});

test("staff can set a due date by hand and go back to the automatic one", async () => {
  const { cal } = setup();
  users.staff = { _id: oid(), email: "tech@firm.com", name: "Tech", role: "staff" };
  Object.assign(cal.items[0], { dueDateActual: new Date("2027-05-20T00:00:00Z"), dueDateSource: "auto", remindersSent: ["client-due-30:2027-05-20"] });
  let r = await call("PATCH", `/api/calendars/${cal._id}/items/0/status`, { user: "staff", body: { dueDateActual: "2027-06-10" } });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  assert.strictEqual(cal.items[0].dueDateSource, "staff");
  assert.deepStrictEqual(cal.items[0].remindersSent, [], "reminders restart for the new date");
  r = await call("PATCH", `/api/calendars/${cal._id}/items/0/status`, { user: "staff", body: { dueDateActual: "" } });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(cal.items[0].dueDateSource, null, "recomputed automatically on save");
});

test("marking a filing Filed from the status menu also creates the next period", async () => {
  const { cal } = setup();
  users.staff = { _id: oid(), email: "tech@firm.com", name: "Tech", role: "staff" };
  Object.assign(cal.items[0], { selectedByClient: true, due_date: "Annually, on the anniversary of the company's incorporation date", dueDateActual: new Date("2027-05-20T00:00:00Z") });
  cal.profile.incorpDate = "2024-05-20";
  const before = cal.items.length;
  const r = await call("PATCH", `/api/calendars/${cal._id}/items/0/status`, { user: "staff", body: { clientStatus: "Filed" } });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(cal.items.length, before + 1);
  assert.strictEqual(cal.items[before].dueDateActual.toISOString().slice(0, 10), "2028-05-22");
});

test("an unexpected error in a route gets a clear 500 instead of hanging", async () => {
  const { cal } = setup();
  users.staff = { _id: oid(), email: "tech@firm.com", name: "Tech", role: "staff" };
  const orig = FakeCalendar.findById;
  FakeCalendar.findById = () => query(() => { throw new Error("database hiccup"); });
  try {
    const r = await call("GET", `/api/calendars/${cal._id}`, { user: "staff" });
    assert.strictEqual(r.status, 500);
    assert.match(r.body.error, /Something went wrong/);
  } finally { FakeCalendar.findById = orig; }
});

// =====================================================================
// Invoices and refunds
// =====================================================================
const settle = () => new Promise((r) => setTimeout(r, 30));

async function paidService() {
  const { cal, org } = setup();
  readyToPay(cal);
  const { body: order } = await call("POST", `/api/portal/payments/calendars/${cal._id}/items/0/create-order`);
  rzp.payments.pay_1 = { id: "pay_1", order_id: order.orderId, amount: 12500, currency: "USD", status: "captured" };
  const v = await call("POST", `/api/portal/payments/calendars/${cal._id}/items/0/verify`, {
    body: { razorpay_order_id: order.orderId, razorpay_payment_id: "pay_1", razorpay_signature: sign(order.orderId, "pay_1") },
  });
  assert.strictEqual(v.status, 200);
  await settle();
  return { cal, org, order };
}

test("every confirmed payment gets exactly one numbered invoice, and the client is sent the link", async () => {
  const { cal, order } = await paidService();
  const invs = invoiceDocs.filter((d) => d.kind === "invoice");
  assert.strictEqual(invs.length, 1);
  assert.match(invs[0].number, /^INV\/\d{4}-\d{2}\/0001$/);
  assert.strictEqual(invs[0].amountMinor, 12500);
  assert.strictEqual(invs[0].customer.name, "Acme Inc");
  // The webhook for the same payment doesn't create a second one.
  await webhook(captured(order.orderId, "pay_1"));
  await settle();
  assert.strictEqual(invoiceDocs.filter((d) => d.kind === "invoice").length, 1);
  const n = notifications.find((x) => x.audience === "client" && x.type === "payment_received");
  assert.match(n.body, /Your invoice INV\/.*\/0001 is ready/);

  // The client sees it; another client can't open it.
  const list = await call("GET", "/api/portal/invoices");
  assert.strictEqual(list.body.invoices.length, 1);
  const pdf = await fetch(`${base}${list.body.invoices[0].pdf}`, { headers: { "x-test-user": "client" } });
  assert.strictEqual(pdf.status, 200);
  assert.strictEqual(pdf.headers.get("content-type"), "application/pdf");
  assert.strictEqual((await pdf.arrayBuffer()).byteLength > 1000, true);
  const other = await call("GET", list.body.invoices[0].pdf, { user: "other" });
  assert.strictEqual(other.status, 404, "another company's invoice is invisible");
  assert.strictEqual((await call("GET", "/api/portal/invoices", { user: "other" })).body.invoices.length, 0);
});

test("finance can refund part of a payment: Razorpay called, credit note issued, client told", async () => {
  const { cal } = await paidService();
  users.fin = { _id: oid(), email: "fin@firm.com", name: "Rahul", role: "staff", department: "finance" };
  const r = await call("POST", `/api/invoices/calendar/${cal._id}/items/0/refund`, { user: "fin", body: { amount: "25", reason: "Agent change not needed" } });
  assert.strictEqual(r.status, 201, JSON.stringify(r.body));
  assert.strictEqual(rzp.refunds[0].amount, 2500);
  assert.strictEqual(rzp.refunds[0].payment_id, "pay_1");
  assert.strictEqual(cal.items[0].paymentStatus, "Partially Refunded");
  assert.match(r.body.creditNote.number, /^CN\/\d{4}-\d{2}\/0001$/);
  const inv = invoiceDocs.find((d) => d.kind === "invoice");
  assert.strictEqual(inv.status, "partially_refunded");
  assert.strictEqual(inv.refundedMinor, 2500);
  await settle();
  assert.ok(notifications.some((n) => n.audience === "client" && /Refund of USD 25\.00/.test(n.title) && /Agent change not needed/.test(n.body)));

  // Can't refund more than what's left.
  const over = await call("POST", `/api/invoices/calendar/${cal._id}/items/0/refund`, { user: "fin", body: { amount: "200", reason: "Too much" } });
  assert.strictEqual(over.status, 400);
  assert.match(over.body.error, /at most USD 100\.00/);
  // The rest, with no amount = everything left.
  const rest = await call("POST", `/api/invoices/calendar/${cal._id}/items/0/refund`, { user: "fin", body: { reason: "Service cancelled" } });
  assert.strictEqual(rest.status, 201);
  assert.strictEqual(rzp.refunds[1].amount, 10000);
  assert.strictEqual(cal.items[0].paymentStatus, "Refunded");
  assert.strictEqual(inv.status, "refunded");
  const again = await call("POST", `/api/invoices/calendar/${cal._id}/items/0/refund`, { user: "fin", body: { reason: "Once more" } });
  assert.match(again.body.error, /already been refunded in full/);
});

test("only finance and admins can refund; a reason is required", async () => {
  const { cal } = await paidService();
  users.staff = { _id: oid(), email: "tech@firm.com", name: "Tech", role: "staff", department: "tech" };
  users.fin = { _id: oid(), email: "fin@firm.com", name: "Rahul", role: "staff", department: "finance" };
  let r = await call("POST", `/api/invoices/calendar/${cal._id}/items/0/refund`, { user: "staff", body: { reason: "Please" } });
  assert.strictEqual(r.status, 403);
  r = await call("POST", `/api/invoices/calendar/${cal._id}/items/0/refund`, { user: "fin", body: { reason: "" } });
  assert.strictEqual(r.status, 400);
  assert.strictEqual(rzp.refunds.length, 0, "nothing sent to Razorpay");
  const billing = await call("GET", `/api/invoices/calendar/${cal._id}`, { user: "staff" });
  assert.strictEqual(billing.body.canRefund, false);
  assert.strictEqual(billing.body.items[0].payments[0].remaining, "USD 125.00");
});

test("if Razorpay refuses a refund, nothing is recorded", async () => {
  const { cal } = await paidService();
  users.fin = { _id: oid(), email: "fin@firm.com", name: "Rahul", role: "staff", department: "finance" };
  rzp.refundFail = { statusCode: 400, error: { description: "The amount must be at least INR 1.00" } };
  const r = await call("POST", `/api/invoices/calendar/${cal._id}/items/0/refund`, { user: "fin", body: { amount: "0.01", reason: "Tiny" } });
  assert.strictEqual(r.status, 502);
  assert.match(r.body.error, /Razorpay couldn't process the refund: The amount must be at least/);
  assert.strictEqual(cal.items[0].refunds.length, 0);
  assert.strictEqual(cal.items[0].paymentStatus, "Paid");
  assert.strictEqual(invoiceDocs.filter((d) => d.kind === "credit_note").length, 0);
});

test("a duplicate payment can be refunded in full without touching the real one", async () => {
  const { cal, order } = await paidService();
  users.fin = { _id: oid(), email: "fin@firm.com", name: "Rahul", role: "staff", department: "finance" };
  await webhook(captured(order.orderId, "pay_dup"));
  assert.ok(cal.items[0].paymentEvents.some((e) => e.event === "duplicate_payment"));
  const b = await call("GET", `/api/invoices/calendar/${cal._id}`, { user: "fin" });
  assert.strictEqual(b.body.items[0].payments.length, 2);
  const r = await call("POST", `/api/invoices/calendar/${cal._id}/items/0/refund`, { user: "fin", body: { paymentId: "pay_dup", reason: "Duplicate payment" } });
  assert.strictEqual(r.status, 201, JSON.stringify(r.body));
  assert.strictEqual(rzp.refunds[0].payment_id, "pay_dup");
  assert.strictEqual(rzp.refunds[0].amount, 12500);
  assert.strictEqual(cal.items[0].paymentStatus, "Paid", "the real payment is untouched");
  assert.strictEqual(r.body.creditNote, null, "no invoice was issued for the duplicate, so no credit note");
});

function refundHook(eventName, entity) {
  return webhook({ event: eventName, payload: { refund: { entity } } });
}

test("Razorpay refund updates: processed tells the client; failed voids the credit note", async () => {
  const { cal } = await paidService();
  users.fin = { _id: oid(), email: "fin@firm.com", name: "Rahul", role: "staff", department: "finance" };
  const r = await call("POST", `/api/invoices/calendar/${cal._id}/items/0/refund`, { user: "fin", body: { amount: "50", reason: "Partial" } });
  const rid = rzp.refunds[0].id;
  let w = await refundHook("refund.processed", { id: rid, payment_id: "pay_1", amount: 5000, currency: "USD", status: "processed" });
  assert.strictEqual(w.status, 200);
  assert.strictEqual(cal.items[0].refunds[0].status, "processed");
  await settle();
  assert.ok(notifications.some((n) => n.audience === "client" && /on its way/.test(n.title)));

  // A second refund fails at the bank.
  await call("POST", `/api/invoices/calendar/${cal._id}/items/0/refund`, { user: "fin", body: { amount: "10", reason: "Another" } });
  const rid2 = rzp.refunds[1].id;
  await refundHook("refund.failed", { id: rid2, payment_id: "pay_1", amount: 1000, currency: "USD", status: "failed" });
  assert.strictEqual(cal.items[0].refunds[1].status, "failed");
  const note = invoiceDocs.find((d) => d.kind === "credit_note" && d.razorpayRefundId === rid2);
  assert.strictEqual(note.status, "void");
  const inv = invoiceDocs.find((d) => d.kind === "invoice");
  assert.strictEqual(inv.refundedMinor, 5000, "failed refund no longer counted");
  assert.strictEqual(cal.items[0].paymentStatus, "Partially Refunded");
  await settle();
  assert.ok(notifications.some((n) => n.audience === "staff" && /Refund FAILED/.test(n.title)));
  assert.ok(r.body.ok);
});

test("a refund made directly in the Razorpay dashboard is recorded with a credit note", async () => {
  const { cal } = await paidService();
  await refundHook("refund.processed", { id: "rfnd_dash", payment_id: "pay_1", amount: 12500, currency: "USD", status: "processed", notes: {} });
  assert.strictEqual(cal.items[0].refunds.length, 1);
  assert.strictEqual(cal.items[0].refunds[0].by, "razorpay-dashboard");
  assert.strictEqual(cal.items[0].paymentStatus, "Refunded");
  assert.ok(invoiceDocs.some((d) => d.kind === "credit_note" && d.razorpayRefundId === "rfnd_dash"));
  // Razorpay retries the webhook: nothing doubles.
  await refundHook("refund.processed", { id: "rfnd_dash", payment_id: "pay_1", amount: 12500, currency: "USD", status: "processed" });
  assert.strictEqual(cal.items[0].refunds.length, 1);
  assert.strictEqual(invoiceDocs.filter((d) => d.kind === "credit_note").length, 1);
});
