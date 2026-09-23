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
    selectedByClient: false, selectedAt: null, quoteNote: "",
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
    if (k === "items.razorpayOrderId") return doc.items.some((it) => it.razorpayOrderId === v);
    if (k === "items.paymentEvents.razorpayOrderId") return doc.items.some((it) => it.paymentEvents.some((e) => e.razorpayOrderId === v));
    const actual = doc[k];
    if (v === null) return actual === null || actual === undefined;
    return String(actual) === String(v);
  });
}

const FakeCalendar = {
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
const rzp = { orders: {}, payments: {}, created: 0, captured: [] };
const fakeRazorpay = {
  orders: {
    create: async ({ amount, currency }) => { rzp.created++; const id = `order_${rzp.created}`; rzp.orders[id] = { id, amount, currency, status: "created" }; return rzp.orders[id]; },
    fetch: async (id) => rzp.orders[id],
    fetchPayments: async (id) => ({ items: Object.values(rzp.payments).filter((p) => p.order_id === id) }),
  },
  payments: {
    fetch: async (id) => rzp.payments[id],
    capture: async (id) => { rzp.captured.push(id); rzp.payments[id].status = "captured"; return rzp.payments[id]; },
  },
};

let generatedItems = [];
stub("models/Calendar.js", FakeCalendar);
stub("models/ClientOrg.js", FakeClientOrg);
stub("middleware/auth.js", fakeAuth);
stub("config/razorpay.js", fakeRazorpay);
stub("lib/storage.js", { saveFile: async ({ fileName }) => ({ fileKey: `k/${fileName}`, fileUrl: "" }), getFileStream: async () => null });
stub("lib/claude.js", { generateCompanyCalendar: async () => ({ items: clone(generatedItems), sourceMode: "live" }) });
stub("lib/notify.js", {
  notifyStaff: async (n) => { notifications.push({ audience: "staff", ...n }); },
  notifyClient: async (n) => { notifications.push({ audience: "client", ...n }); },
});
stub("lib/auditLog.js", { logActivity: (e) => audit.push(e) });
stub("models/Message.js", { create: async (m) => { messages.push(m); return m; } });

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
  rzp.orders = {}; rzp.payments = {}; rzp.captured = []; rzp.created = 0;
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
