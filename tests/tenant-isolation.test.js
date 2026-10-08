// tests/tenant-isolation.test.js
//
// "Can company A see or change anything of company B's?" and "can a role
// reach what it shouldn't?", asked directly: two seeded client companies,
// one account per role, the REAL session middleware (signed cookies, as a
// browser sends them) and the REAL routes over real HTTP. Replaced with
// in-memory stand-ins (via the require cache, as in the other suites): the
// Mongoose models, file storage, email, notifications and Razorpay.
//
// The role checks walk every route each router actually has, so a route
// added later is covered without editing this file.
//
//   node --test tests/

const test = require("node:test");
const assert = require("node:assert");
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const jwt = require("jsonwebtoken");

process.env.JWT_SECRET = "tenant-isolation-test-secret";
process.env.NODE_ENV = "test";
process.env.TWO_FACTOR_REQUIRED = "false"; // switched on inside the test that covers it
process.env.RAZORPAY_KEY_ID = "rzp_test_key";
process.env.RAZORPAY_KEY_SECRET = "rzp_test_secret";
// Uploads in this suite go to their own temporary folder. Suites run side by
// side, and tests/client-flow.test.js counts the files in the shared one.
const PRIVATE_TMP = fs.mkdtempSync(path.join(require("node:os").tmpdir(), "cc-isolation-"));
["TMPDIR", "TEMP", "TMP"].forEach((k) => { process.env[k] = PRIVATE_TMP; });
test.after(() => fs.rmSync(PRIVATE_TMP, { recursive: true, force: true }));

const root = path.join(__dirname, "..");
const RealCalendarSchema = require("../models/Calendar").schema;
const stub = (rel, exports) => {
  const file = require.resolve(path.join(root, rel));
  require.cache[file] = { id: file, filename: file, loaded: true, exports };
};

// ---------------------------------------------------------------------
// A small in-memory "collection" that answers the queries the routes make
// ---------------------------------------------------------------------
let seq = 0;
const oid = () => (++seq).toString(16).padStart(24, "0");
const clone = (v) => JSON.parse(JSON.stringify(v));
const same = (a, b) => String(a ?? null) === String(b ?? null);

function matches(doc, q) {
  return Object.entries(q || {}).every(([key, want]) => {
    if (key === "$or") return want.some((sub) => matches(doc, sub));
    const actual = key.split(".").reduce((o, p) => (o == null ? undefined : o[p]), doc);
    if (want && typeof want === "object" && !(want instanceof Date)) {
      if ("$ne" in want) return Array.isArray(actual) ? !actual.some((x) => same(x, want.$ne)) : !same(actual, want.$ne);
      if ("$in" in want) return want.$in.some((x) => same(actual, x));
      if ("$gt" in want || "$gte" in want || "$lt" in want || "$lte" in want) return true;
    }
    return same(actual, want);
  });
}
function query(run) {
  const q = {
    sort: () => q, select: () => q, lean: () => q, limit: () => q, populate: () => q,
    then: (res, rej) => Promise.resolve().then(run).then(res, rej),
    catch: (rej) => Promise.resolve().then(run).catch(rej),
  };
  return q;
}
function collection(decorate = (d) => d) {
  const rows = [];
  const add = (data) => {
    const doc = decorate({ _id: oid(), createdAt: new Date(), ...data });
    if (!doc.save) Object.defineProperty(doc, "save", { value: async () => doc, enumerable: false });
    if (!doc.populate) Object.defineProperty(doc, "populate", { value: async () => doc, enumerable: false });
    rows.push(doc);
    return doc;
  };
  return {
    rows, add,
    find: (q) => query(() => rows.filter((d) => matches(d, q))),
    findOne: (q) => query(() => rows.find((d) => matches(d, q)) || null),
    findById: (id) => query(() => rows.find((d) => same(d._id, id)) || null),
    create: async (data) => add(data),
    countDocuments: async (q) => rows.filter((d) => matches(d, q)).length,
    exists: async (q) => rows.some((d) => matches(d, q)),
    updateMany: async (q, u) => { rows.filter((d) => matches(d, q)).forEach((d) => applyUpdate(d, u)); },
    updateOne: async (q, u) => { const d = rows.find((x) => matches(x, q)); if (d) applyUpdate(d, u); },
    aggregate: async () => [],
  };
}
function applyUpdate(doc, u) {
  Object.assign(doc, u.$set || {});
  Object.entries(u.$addToSet || {}).forEach(([k, v]) => { doc[k] = doc[k] || []; if (!doc[k].some((x) => same(x, v))) doc[k].push(v); });
}

// ---------------------------------------------------------------------
// Models
// ---------------------------------------------------------------------
const ROLE_RANK = { client: 0, staff: 1, admin: 2, super_admin: 3 };
class FakeUser {
  constructor(a) {
    Object.assign(this, { _id: oid(), email: "", name: "", role: "staff", department: "", passwordHash: "set", googleId: null, clientOrgId: null,
      active: true, mustSetPassword: false, tokenVersion: 0, totpEnabled: false, totpRecoveryCodes: [], failedOtpAttempts: 0, lockedUntil: null }, a);
  }
  async setPassword(p) { this.passwordHash = `hash:${p}`; this.mustSetPassword = false; this.tokenVersion += 1; }
  toSafeJSON() { return { id: this._id, email: this.email, name: this.name, role: this.role, active: this.active, clientOrgId: this.clientOrgId }; }
  async save() {
    if (!FakeUser.ROLES.includes(this.role)) throw Object.assign(new Error("bad role"), { name: "ValidationError" });
    if (!userRows.includes(this)) userRows.push(this);
    return this;
  }
}
const userRows = [];
FakeUser.ROLES = ["client", "staff", "admin", "super_admin"];
FakeUser.ROLE_RANK = ROLE_RANK;
FakeUser.hasAtLeast = (r, m) => (ROLE_RANK[r] ?? -1) >= (ROLE_RANK[m] ?? Infinity);
FakeUser.findById = (id) => query(() => userRows.find((u) => same(u._id, id)) || null);
FakeUser.findOne = (q) => query(() => userRows.find((u) => matches(u, q)) || null);
FakeUser.find = (q) => query(() => userRows.filter((u) => matches(u, q)));

const Orgs = collection();
const Invoices = collection();
const Messages = collection();
const Notifications = collection((d) => ({ readBy: [], ...d }));
const Calendars = collection((data) => {
  const doc = { status: "approved", supersededAt: null, supersedes: null, source: "client", ...data };
  doc.items = (doc.items || []).map((it) => ({
    category: "Mandatory Annual", due_date: "31 March (Annually)", description: "", authority: "", clientStatus: "Not Started",
    paymentStatus: "Not Invoiced", feeAmountCents: null, razorpayOrderId: null, razorpayPaymentId: null, paymentEvents: [], documents: [],
    selectedByClient: false, refunds: [], remindersSent: [], ...it,
  }));
  Object.defineProperty(doc, "toObject", { value: () => clone(doc), enumerable: false });
  doc.profile = { companyName: "Co", country: "United States", state: "Delaware", entityType: "Corporation", ...(doc.profile || {}) };
  Object.defineProperty(doc.profile, "toObject", { value: () => clone(doc.profile), enumerable: false });
  return doc;
});
Calendars.schema = RealCalendarSchema;

const audit = [];
const stored = new Map();
stub("models/User.js", FakeUser);
stub("models/Calendar.js", Calendars);
stub("models/ClientOrg.js", Orgs);
stub("models/Invoice.js", Invoices);
stub("models/Message.js", Messages);
stub("models/Notification.js", Notifications);
stub("models/AuditLog.js", { find: () => query(() => audit) });
stub("lib/auditLog.js", { logActivity: (e) => audit.push(e) });
stub("lib/notify.js", { notifyStaff: async () => {}, notifyClient: async () => {} });
stub("lib/mailer.js", { sendEmail: async () => ({}), fromAddress: () => "t@e.com" });
stub("config/razorpay.js", { orders: { create: async ({ amount, currency }) => ({ id: `order_${oid()}`, amount, currency, status: "created" }), fetch: async () => null } });
stub("lib/storage.js", {
  DRIVER: "local", describe: () => "test",
  saveFile: async ({ fileName, filePath }) => { const k = `${oid()}-${fileName}`; stored.set(k, fs.readFileSync(filePath)); return { fileKey: k, fileUrl: "" }; },
  getFile: async (k) => (stored.has(k) ? { stream: require("node:stream").Readable.from([stored.get(k)]), contentType: "application/pdf" } : null),
  fileExists: async (k) => stored.has(k),
  findMissing: async () => new Set(),
});

// ---------------------------------------------------------------------
// The app: real session middleware, real routers, mounted as in server.js
// ---------------------------------------------------------------------
const express = require("express");
const cookieParser = require("cookie-parser");
const { errorHandler } = require("../lib/asyncErrors");
const { requirePageAuth, requirePageRole, requirePageClientRole } = require("../middleware/auth");

const ROUTERS = {
  "/api/calendars": require("../routes/calendar.routes"),
  "/api/admin": require("../routes/admin.routes"),
  "/api/portal": require("../routes/portal.routes"),
  "/api/portal/payments": require("../routes/payments.routes"),
  "/api/messages": require("../routes/messages.routes"),
  "/api/dashboard": require("../routes/dashboard.routes"),
  "/api/notifications": require("../routes/notifications.routes"),
  "/api/invoices": require("../routes/invoices.routes"),
  "/api/pipeline": require("../routes/pipeline.routes"),
  "/api/reports": require("../routes/reports.routes"),
};
const app = express();
app.use(express.json());
app.use(cookieParser());
// Page guards, the same middleware and order server.js uses.
["/app", "/review", "/calendar", "/pipeline", "/reports", "/dashboard"].forEach((p) =>
  app.get(p, requirePageAuth, requirePageRole("staff"), (req, res) => res.send("staff page")));
app.get("/admin", requirePageAuth, requirePageRole("admin"), (req, res) => res.send("admin page"));
app.get("/portal", requirePageAuth, requirePageClientRole, (req, res) => res.send("portal page"));
Object.entries(ROUTERS).forEach(([prefix, router]) => app.use(prefix, router));
app.use(errorHandler);

let server, base;
test.before(async () => { server = http.createServer(app); await new Promise((r) => server.listen(0, r)); base = `http://127.0.0.1:${server.address().port}`; });
test.after(() => server.close());

const cookieFor = (user, { mfa = 1, version = user.tokenVersion } = {}) =>
  `cc_session=${jwt.sign({ id: String(user._id), p: "session", v: version, m: mfa }, process.env.JWT_SECRET, { expiresIn: "1h" })}`;

async function call(method, url, { as, body, form } = {}) {
  const headers = {};
  if (as) headers.Cookie = cookieFor(as);
  const opts = { method, headers, redirect: "manual" };
  if (form) opts.body = form;
  else if (body !== undefined) { opts.body = JSON.stringify(body); headers["Content-Type"] = "application/json"; }
  const res = await fetch(base + url, opts);
  const text = await res.text();
  let json = {}; try { json = JSON.parse(text); } catch {}
  return { status: res.status, body: json, text, location: res.headers.get("location") };
}

// Every route a router has, with placeholder ids.
function routesOf(prefix) {
  const out = [];
  ROUTERS[prefix].stack.filter((l) => l.route).forEach((l) => {
    [].concat(l.route.path).forEach((p) => {
      if (typeof p !== "string") return;
      const url = prefix + p.replace(/:(\w+)/g, (_, name) => (/index$/i.test(name) ? "0" : "aaaaaaaaaaaaaaaaaaaaaaaa"));
      Object.keys(l.route.methods).forEach((m) => out.push({ method: m.toUpperCase(), url }));
    });
  });
  return out;
}

// ---------------------------------------------------------------------
// Two companies, one account per role
// ---------------------------------------------------------------------
let A, B, alice, bob, staff, finance, admin, owner;
function seed() {
  [userRows, Orgs.rows, Calendars.rows, Invoices.rows, Messages.rows, Notifications.rows, audit].forEach((r) => (r.length = 0));
  stored.clear();
  const company = (name, email) => {
    const org = Orgs.add({ name, primaryContactEmail: email, primaryContactPhone: "+1 415 555 0100", primaryContactName: name, assignedStaff: null });
    const key = `${name}-secret.pdf`;
    stored.set(key, Buffer.from(`%PDF-1.4 ${name} confidential`));
    const cal = Calendars.add({
      clientOrgId: org._id,
      profile: { companyName: name },
      reviewNotes: `internal note about ${name}`,
      items: [{
        compliance_name: `${name} Annual Report`, selectedByClient: true, paymentStatus: "Invoiced", feeAmountCents: 12500,
        documents: [{ type: "client_upload", fileKey: key, fileUrl: "", fileName: key, requirementLabel: "Certificate of Incorporation / Formation", reviewStatus: "pending" }],
        paymentEvents: [{ event: "order_created", razorpayOrderId: `order_${name}`, amountCents: 12500, currency: "USD" }],
      }],
    });
    const pending = Calendars.add({ clientOrgId: org._id, status: "pending_review", profile: { companyName: `${name} (draft)` }, reviewNotes: "draft note", items: [{ compliance_name: "Draft filing", confidence: "low" }] });
    const invoice = Invoices.add({ clientOrgId: org._id, kind: "invoice", number: `INV/${name}/1`, status: "issued", issuedAt: new Date(), amountMinor: 12500, currency: "USD", description: `${name} invoice`, calendarId: cal._id, itemIndex: 0 });
    Messages.add({ clientOrgId: org._id, senderRole: "staff", senderName: "Team", body: `private message for ${name}`, readByClient: false, readByStaff: true });
    const bell = Notifications.add({ audience: "client", clientOrgId: org._id, type: "message", title: `bell for ${name}`, body: "" });
    return { org, cal, pending, invoice, bell, key };
  };
  A = company("Alpha", "alice@alpha.example");
  B = company("Beta", "bob@beta.example");
  Notifications.add({ audience: "staff", clientOrgId: A.org._id, type: "message", title: "staff-only bell", body: "" });
  const user = (attrs) => { const u = new FakeUser(attrs); userRows.push(u); return u; };
  alice = user({ email: "alice@alpha.example", name: "Alice", role: "client", clientOrgId: A.org._id });
  bob = user({ email: "bob@beta.example", name: "Bob", role: "client", clientOrgId: B.org._id });
  staff = user({ email: "tech@firm.example", name: "Tech", role: "staff", department: "tech" });
  finance = user({ email: "fin@firm.example", name: "Fin", role: "staff", department: "finance" });
  admin = user({ email: "admin@firm.example", name: "Admin", role: "admin" });
  owner = user({ email: "owner@firm.example", name: "Owner", role: "super_admin" });
}
test.beforeEach(seed);

const pdf = (name = "doc.pdf", type = "application/pdf", content = "%PDF-1.4 x") => {
  const f = new FormData();
  f.append("requirementLabel", "Certificate of Incorporation / Formation");
  f.append("file", new Blob([content], { type }), name);
  return f;
};

// =====================================================================
// Company A can't see or touch company B
// =====================================================================
test("a client only ever lists their own company's calendars, invoices, messages and notifications", async () => {
  const cals = await call("GET", "/api/portal/calendars", { as: alice });
  assert.strictEqual(cals.status, 200);
  assert.deepStrictEqual(cals.body.calendars.map((c) => c._id), [A.cal._id]);
  assert.ok(!cals.text.includes("Beta"), "nothing of Beta's anywhere in the reply");

  const pending = await call("GET", "/api/portal/calendars/pending", { as: alice });
  assert.deepStrictEqual(pending.body.calendars.map((c) => c._id), [A.pending._id]);

  const inv = await call("GET", "/api/portal/invoices", { as: alice });
  assert.deepStrictEqual(inv.body.invoices.map((i) => i.number), ["INV/Alpha/1"]);

  const bells = await call("GET", "/api/notifications", { as: alice });
  assert.deepStrictEqual(bells.body.notifications.map((n) => n.title), ["bell for Alpha"], "not Beta's, and not the team's");

  const thread = await call("GET", `/api/messages/${A.org._id}`, { as: alice });
  assert.deepStrictEqual(thread.body.messages.map((m) => m.body), ["private message for Alpha"]);
});

test("guessing another company's ids gets 'not found' on every portal route, and changes nothing", async () => {
  const before = JSON.stringify([B.cal, B.org, B.invoice]);
  const id = B.cal._id;
  const tries = [
    ["GET", `/api/portal/calendars/${id}`],
    ["POST", `/api/portal/calendars/${id}/items/0/select`, { body: { selected: false } }],
    ["POST", `/api/portal/calendars/${id}/items/0/upload`, { form: pdf() }],
    ["GET", `/api/portal/calendars/${id}/items/0/documents/0/download`],
    ["GET", `/api/portal/calendars/${id}/items/0/documents/0/download?view=1`],
    ["POST", "/api/portal/calendars/regenerate", { body: { calendarId: id, profile: { companyName: "Hijacked" } } }],
    ["POST", `/api/portal/payments/calendars/${id}/items/0/create-order`],
    ["POST", `/api/portal/payments/calendars/${id}/items/0/verify`, { body: { razorpay_order_id: "order_Beta", razorpay_payment_id: "pay_x", razorpay_signature: "00" } }],
    ["GET", `/api/portal/invoices/${B.invoice._id}/pdf`],
    ["GET", `/api/portal/calendars/${B.pending._id}`],
  ];
  for (const [method, url, opts] of tries) {
    const r = await call(method, url, { as: alice, ...opts });
    assert.strictEqual(r.status, 404, `${method} ${url} → ${r.status} ${r.text.slice(0, 80)}`);
    assert.ok(!r.text.includes("Beta"), `${method} ${url} leaked something`);
  }
  assert.strictEqual(JSON.stringify([B.cal, B.org, B.invoice]), before, "Beta's data is untouched");
  assert.strictEqual(Calendars.rows.length, 4, "no calendar was created");

  // The same requests by Beta's own client work (so the 404s above are the
  // ownership check, not a broken route).
  assert.strictEqual((await call("GET", `/api/portal/calendars/${id}`, { as: bob })).status, 200);
  const own = await call("GET", `/api/portal/calendars/${id}/items/0/documents/0/download`, { as: bob });
  assert.strictEqual(own.status, 200);
  assert.match(own.text, /Beta confidential/);
});

test("a calendar export can't be pointed at another company's calendar", async () => {
  const r = await call("GET", `/api/portal/calendar.ics?calendar=${B.cal._id}`, { as: alice });
  assert.strictEqual(r.status, 200);
  assert.ok(!r.text.includes("Beta"));
  const own = await call("GET", "/api/portal/calendar.ics", { as: alice });
  assert.match(own.text, /BEGIN:VCALENDAR/);
  assert.ok(!own.text.includes("Beta"));
});

test("chat: a client can't read or write another company's thread, or link a message to its calendar", async () => {
  assert.strictEqual((await call("GET", `/api/messages/${B.org._id}`, { as: alice })).status, 403);
  assert.strictEqual((await call("POST", `/api/messages/${B.org._id}`, { as: alice, body: { body: "hello Beta" } })).status, 403);
  assert.strictEqual(Messages.rows.filter((m) => same(m.clientOrgId, B.org._id)).length, 1);
  assert.strictEqual(Messages.rows.find((m) => same(m.clientOrgId, B.org._id)).readByClient, false, "and it wasn't marked read");

  const sent = await call("POST", `/api/messages/${A.org._id}`, { as: alice, body: { body: "about this", calendarId: B.cal._id, itemIndex: 0, itemLabel: "Beta Annual Report" } });
  assert.strictEqual(sent.status, 201);
  assert.strictEqual(sent.body.message.calendarId, null, "the link to Beta's calendar is dropped");
  assert.strictEqual(sent.body.message.itemLabel, "");
  const ok = await call("POST", `/api/messages/${A.org._id}`, { as: alice, body: { body: "about mine", calendarId: A.cal._id, itemIndex: 0, itemLabel: "Alpha Annual Report" } });
  assert.strictEqual(String(ok.body.message.calendarId), String(A.cal._id));

  for (const bad of [{ body: { $gt: "" } }, { body: ["x"] }, { body: 42 }, {}]) {
    assert.strictEqual((await call("POST", `/api/messages/${A.org._id}`, { as: alice, body: bad })).status, 400);
  }
  assert.strictEqual((await call("GET", "/api/messages/not-an-id", { as: alice })).status, 400);
});

test("notifications: a client can't mark another company's (or the team's) as read", async () => {
  const staffBell = Notifications.rows.find((n) => n.audience === "staff");
  await call("POST", `/api/notifications/${B.bell._id}/read`, { as: alice });
  await call("POST", `/api/notifications/${staffBell._id}/read`, { as: alice });
  await call("POST", "/api/notifications/read-all", { as: alice });
  assert.deepStrictEqual(B.bell.readBy, []);
  assert.deepStrictEqual(staffBell.readBy, []);
  assert.strictEqual(A.bell.readBy.length, 1, "their own was marked");
});

test("clients never receive the team's internal note, the payment log or where files are stored", async () => {
  const r = await call("GET", `/api/portal/calendars/${A.cal._id}`, { as: alice });
  assert.strictEqual(r.status, 200);
  assert.ok(!("reviewNotes" in r.body.calendar));
  assert.ok(!r.text.includes("internal note"));
  assert.ok(!("paymentEvents" in r.body.calendar.items[0]));
  assert.ok(!r.text.includes(A.key) || !/"fileKey"/.test(r.text), "no storage key");
  assert.ok(!/"fileKey"|"fileUrl"/.test(r.text));
  assert.strictEqual(r.body.calendar.items[0].documents[0].fileName, "Alpha-secret.pdf", "the file name is still there");

  const pending = await call("GET", "/api/portal/calendars/pending", { as: alice });
  assert.deepStrictEqual(Object.keys(pending.body.calendars[0]).sort(), ["_id", "createdAt", "items", "profile"]);
  assert.deepStrictEqual(Object.keys(pending.body.calendars[0].items[0]).sort(), ["category", "compliance_name"]);
  assert.ok(!pending.text.includes("draft note"));

  // Staff still see all of it.
  const s = await call("GET", `/api/calendars/${A.cal._id}`, { as: staff });
  assert.strictEqual(s.body.calendar.reviewNotes, "internal note about Alpha");
  assert.strictEqual(s.body.calendar.items[0].documents[0].fileKey, A.key);
});

test("a stored file can only be fetched through a route that checks who is asking", async () => {
  // No static folder, and no route that takes a storage key.
  for (const url of [`/${A.key}`, `/uploads/${A.key}`, `/api/portal/files/${A.key}`, `/api/files/${A.key}`]) {
    const r = await call("GET", url, { as: alice });
    assert.strictEqual(r.status, 404, url);
  }
  const serverJs = fs.readFileSync(path.join(root, "server.js"), "utf8");
  const code = serverJs.split("\n").filter((line) => !line.trim().startsWith("//")).join("\n");
  const statics = code.split("express.static(").slice(1).map((rest) => rest.slice(0, 31));
  assert.deepStrictEqual(statics, ['path.join(__dirname, "public"),'], "only public/ is served as files");
  assert.ok(!fs.existsSync(path.join(root, "public", "uploads")));
});

// =====================================================================
// Uploads
// =====================================================================
test("uploads: wrong type, disguised content, empty and oversized files are refused; nothing is stored", async () => {
  const url = `/api/portal/calendars/${A.cal._id}/items/0/upload`;
  const before = stored.size;
  const cases = [
    [pdf("run.exe", "application/x-msdownload", "MZ\u0090"), /PDF, an image/],
    [pdf("page.html", "text/html", "<script>alert(1)</script>"), /PDF, an image/],
    [pdf("vector.svg", "image/svg+xml", "<svg onload=alert(1)>"), /PDF, an image/],
    [pdf("evil.pdf.html", "application/pdf", "%PDF-1.4"), /PDF, an image/],
    [pdf("fake.pdf", "application/pdf", "<script>alert(1)</script>"), /doesn't look like a real PDF/],
    [pdf("fake.png", "image/png", "%PDF-1.4 not a png"), /doesn't look like a real PNG/],
    [pdf("empty.pdf", "application/pdf", ""), /empty/],
    [pdf("big.pdf", "application/pdf", "%PDF-1.4 " + "x".repeat(16 * 1024 * 1024)), /under 15 MB/],
  ];
  for (const [form, message] of cases) {
    const r = await call("POST", url, { as: alice, form });
    assert.strictEqual(r.status, 400, r.text.slice(0, 100));
    assert.match(r.body.error, message);
  }
  assert.strictEqual(stored.size, before);
  assert.strictEqual(A.cal.items[0].documents.length, 1);

  const two = pdf();
  two.append("file", new Blob(["%PDF-1.4 second"], { type: "application/pdf" }), "second.pdf");
  assert.strictEqual((await call("POST", url, { as: alice, form: two })).status, 400, "one file at a time");

  const good = await call("POST", url, { as: alice, form: pdf("real.pdf") });
  assert.strictEqual(good.status, 201);
  assert.strictEqual(stored.size, before + 1);
});

// =====================================================================
// Roles, on every route
// =====================================================================
const STAFF_PREFIXES = ["/api/calendars", "/api/invoices", "/api/pipeline", "/api/reports", "/api/dashboard"];

test("without a session every API route answers 401", async () => {
  let n = 0;
  for (const prefix of Object.keys(ROUTERS)) {
    for (const { method, url } of routesOf(prefix)) {
      const r = await call(method, url);
      assert.strictEqual(r.status, 401, `${method} ${url}`);
      n++;
    }
  }
  assert.ok(n >= 70, `walked ${n} routes`);
});

test("a client is refused on every staff and admin route, reading or changing", async () => {
  const before = JSON.stringify([Calendars.rows, userRows.map((u) => u.toSafeJSON()), Orgs.rows]);
  for (const prefix of [...STAFF_PREFIXES, "/api/admin"]) {
    const routes = routesOf(prefix);
    assert.ok(routes.length, `${prefix} has routes`);
    for (const { method, url } of routes) {
      const r = await call(method, url.replace("aaaaaaaaaaaaaaaaaaaaaaaa", B.cal._id), { as: alice, body: method === "GET" ? undefined : { feeAmountUSD: 1, clientStatus: "Filed", paymentStatus: "Paid", role: "super_admin", active: false, paused: true } });
      assert.strictEqual(r.status, 403, `${method} ${url} → ${r.status}`);
    }
  }
  assert.strictEqual(JSON.stringify([Calendars.rows, userRows.map((u) => u.toSafeJSON()), Orgs.rows]), before, "nothing changed");
});

test("staff are refused on every admin route; team accounts are refused on client-portal routes", async () => {
  for (const { method, url } of routesOf("/api/admin")) {
    for (const who of [staff, finance]) {
      const r = await call(method, url, { as: who, body: method === "GET" ? undefined : {} });
      assert.strictEqual(r.status, 403, `${who.email} ${method} ${url} → ${r.status}`);
    }
  }
  for (const prefix of ["/api/portal", "/api/portal/payments"]) {
    for (const { method, url } of routesOf(prefix)) {
      for (const who of [staff, admin, owner]) {
        const r = await call(method, url, { as: who, body: method === "GET" ? undefined : {} });
        assert.strictEqual(r.status, 403, `${who.role} ${method} ${url} → ${r.status}`);
      }
    }
  }
  // Control: the roles that should get in, do.
  assert.strictEqual((await call("GET", "/api/admin/users", { as: admin })).status, 200);
  assert.strictEqual((await call("GET", `/api/calendars/${A.cal._id}`, { as: staff })).status, 200);
  assert.strictEqual((await call("GET", "/api/portal/profile", { as: alice })).status, 200);
});

test("pages are refused on the server, not just hidden: each role only gets its own pages", async () => {
  const staffPages = ["/app", "/review", "/calendar", "/pipeline", "/reports", "/dashboard"];
  for (const p of [...staffPages, "/admin", "/portal"]) {
    const r = await call("GET", p);
    assert.strictEqual(r.status, 302, p);
    assert.strictEqual(r.location, "/login?reason=session_expired");
  }
  for (const p of [...staffPages, "/admin"]) {
    const r = await call("GET", p, { as: alice });
    assert.strictEqual(r.location, "/login?reason=not_authorized", `client → ${p}`);
    assert.ok(!r.text.includes("page"));
  }
  assert.strictEqual((await call("GET", "/admin", { as: staff })).location, "/login?reason=not_authorized");
  assert.strictEqual((await call("GET", "/portal", { as: staff })).location, "/login?reason=not_authorized");
  for (const p of staffPages) assert.strictEqual((await call("GET", p, { as: staff })).status, 200, p);
  assert.strictEqual((await call("GET", "/admin", { as: admin })).status, 200);
  assert.strictEqual((await call("GET", "/portal", { as: alice })).status, 200);

  // server.js guards every page in public/ that isn't meant for the public.
  const serverJs = fs.readFileSync(path.join(root, "server.js"), "utf8");
  const publicPages = new Set(["index.html", "login.html", "two-factor.html"]);
  for (const file of fs.readdirSync(path.join(root, "public")).filter((f) => f.endsWith(".html") && !publicPages.has(f))) {
    assert.ok(serverJs.includes(`"/${file.slice(0, -5)}"`), `${file} has a guarded route in server.js`);
  }
  assert.ok(serverJs.indexOf("STAFF_PAGES.forEach") < serverJs.indexOf("express.static("), "guards are registered before the static folder");
});

test("a deactivated account, or one signed out everywhere, loses access at once", async () => {
  assert.strictEqual((await call("GET", "/api/portal/calendars", { as: alice })).status, 200);
  alice.active = false;
  assert.strictEqual((await call("GET", "/api/portal/calendars", { as: alice })).status, 401);
  assert.strictEqual((await call("GET", "/portal", { as: alice })).location, "/login?reason=session_expired");
  alice.active = true;
  const oldCookie = { Cookie: cookieFor(staff) };
  staff.tokenVersion += 1; // password change / "log out everywhere"
  const r = await fetch(`${base}/api/calendars/${A.cal._id}`, { headers: oldCookie });
  assert.strictEqual(r.status, 401);
});

test("two-factor is enforced by the server for staff, admins and the owner, on every team route", async () => {
  process.env.TWO_FACTOR_REQUIRED = "true";
  try {
    for (const who of [staff, admin, owner]) {
      // Signed in with a password, never set two-factor up.
      for (const prefix of [...STAFF_PREFIXES, "/api/admin"]) {
        for (const { method, url } of routesOf(prefix)) {
          const r = await call(method, url, { as: who, body: method === "GET" ? undefined : {} });
          assert.strictEqual(r.status, 403, `${who.role} ${method} ${url}`);
          assert.strictEqual(r.body.code, "MFA_SETUP_REQUIRED");
        }
      }
      assert.strictEqual((await call("GET", "/dashboard", { as: who })).location, "/two-factor?setup=1");
    }
    // Two-factor is on, but this session never passed the code step.
    staff.totpEnabled = true;
    const noCode = await fetch(`${base}/api/calendars/${A.cal._id}`, { headers: { Cookie: cookieFor(staff, { mfa: 0 }) } });
    assert.strictEqual(noCode.status, 401);
    const withCode = await fetch(`${base}/api/calendars/${A.cal._id}`, { headers: { Cookie: cookieFor(staff, { mfa: 1 }) } });
    assert.strictEqual(withCode.status, 200);
    // Clients are never asked.
    assert.strictEqual((await call("GET", "/api/portal/calendars", { as: alice })).status, 200);
  } finally {
    process.env.TWO_FACTOR_REQUIRED = "false";
  }
});

// =====================================================================
// Admin vs owner
// =====================================================================
test("an admin manages staff and clients; only the owner manages admins and owners", async () => {
  const good = "Harbor-Lantern-47";
  for (const role of ["admin", "super_admin"]) {
    const r = await call("POST", "/api/admin/users", { as: admin, body: { email: `new-${role}@firm.example`, password: good, role } });
    assert.strictEqual(r.status, 403, `admin creating ${role}`);
  }
  assert.strictEqual((await call("PATCH", `/api/admin/users/${staff._id}`, { as: admin, body: { role: "admin" } })).status, 403, "admin promoting staff");
  assert.strictEqual((await call("PATCH", `/api/admin/users/${owner._id}`, { as: admin, body: { active: false } })).status, 403);
  assert.strictEqual((await call("PATCH", `/api/admin/users/${owner._id}`, { as: admin, body: { password: good } })).status, 403);
  assert.strictEqual((await call("POST", `/api/admin/users/${owner._id}/reset-2fa`, { as: admin })).status, 403);
  assert.strictEqual((await call("PATCH", `/api/dashboard/team/${owner._id}/reset`, { as: admin })).status, 403);
  assert.strictEqual((await call("GET", "/api/admin/backups/download?key=backups/2026-09-24T02-30-00-000Z.ndjson.gz", { as: admin })).status, 403);
  assert.strictEqual(owner.active, true);
  assert.strictEqual(staff.role, "staff");
  assert.strictEqual(userRows.length, 6);

  const made = await call("POST", "/api/admin/users", { as: admin, body: { email: " New.Staff@Firm.example ", password: good, role: "staff", name: "New" } });
  assert.strictEqual(made.status, 201, made.text);
  assert.strictEqual(made.body.user.email, "new.staff@firm.example");
  assert.ok(audit.some((a) => a.action === "user_created" && /new\.staff@firm\.example/.test(a.summary)), "creating an account is in the security log");

  const promoted = await call("PATCH", `/api/admin/users/${staff._id}`, { as: owner, body: { role: "admin" } });
  assert.strictEqual(promoted.status, 200, promoted.text);
  assert.strictEqual(staff.role, "admin");
  assert.strictEqual(staff.department, "", "an admin has no department");
  assert.ok(audit.some((a) => a.action === "user_role_changed" && a.meta.from === "staff" && a.meta.to === "admin"));
});

test("passwords set by an admin follow the same rules as everyone's, and are logged", async () => {
  for (const weak of ["a", "password1234", "short1", "alllettersnodigits", "aaaaaaaaaaaaaaa1"]) {
    const r = await call("POST", "/api/admin/users", { as: admin, body: { email: "weak@firm.example", password: weak, role: "staff" } });
    assert.strictEqual(r.status, 400, `"${weak}" accepted on create`);
    const p = await call("PATCH", `/api/admin/users/${staff._id}`, { as: admin, body: { password: weak } });
    assert.strictEqual(p.status, 400, `"${weak}" accepted on reset`);
  }
  assert.strictEqual(staff.passwordHash, "set", "the weak resets changed nothing");
  assert.ok(!userRows.some((u) => u.email === "weak@firm.example"));

  const before = staff.tokenVersion;
  const ok = await call("PATCH", `/api/admin/users/${staff._id}`, { as: admin, body: { password: "Harbor-Lantern-47" } });
  assert.strictEqual(ok.status, 200);
  assert.strictEqual(staff.tokenVersion, before + 1, "their other sessions are signed out");
  assert.ok(audit.some((a) => a.action === "password_reset_by_admin" && a.meta.targetEmail === "tech@firm.example"));
  assert.ok(!JSON.stringify(audit).includes("Harbor-Lantern-47"), "the password itself is never logged");
  assert.ok(!ok.text.includes("hash:"), "and never sent back");
});

test("account edits that would break an account are refused with a reason", async () => {
  for (const [body, why] of [
    [{ role: "wizard" }, /role must be one of/],
    [{ role: { $ne: "client" } }, /role must be one of/],
    [{ role: "client" }, /can't become/],
  ]) {
    const r = await call("PATCH", `/api/admin/users/${staff._id}`, { as: owner, body });
    assert.strictEqual(r.status, 400, JSON.stringify(body));
    assert.match(r.body.error, why);
  }
  assert.match((await call("PATCH", `/api/admin/users/${alice._id}`, { as: owner, body: { role: "staff" } })).body.error, /can't become/);
  assert.strictEqual(alice.role, "client");
  assert.strictEqual(staff.role, "staff");

  // Locking yourself out.
  assert.strictEqual((await call("PATCH", `/api/admin/users/${owner._id}`, { as: owner, body: { active: false } })).status, 400);
  assert.strictEqual((await call("PATCH", `/api/admin/users/${owner._id}`, { as: owner, body: { role: "staff" } })).status, 400);
  assert.strictEqual(owner.active, true);
  assert.strictEqual(owner.role, "super_admin");

  for (const body of [{ email: { $ne: null }, password: "Harbor-Lantern-47", role: "staff" }, { email: "not-an-email", password: "Harbor-Lantern-47", role: "staff" }, { email: "x@firm.example", password: ["Harbor-Lantern-47"], role: "staff" }]) {
    assert.strictEqual((await call("POST", "/api/admin/users", { as: owner, body })).status, 400, JSON.stringify(body));
  }
  // A filter that isn't a plain value is ignored rather than sent to the database.
  const listed = await call("GET", "/api/admin/users?role[$ne]=client", { as: admin });
  assert.strictEqual(listed.status, 200);
  assert.strictEqual(listed.body.users.length, userRows.length);
});

test("refunds: only finance and admins; the amount can't exceed what was paid", async () => {
  Object.assign(A.cal.items[0], { paymentStatus: "Paid", razorpayPaymentId: "pay_1", paidAt: new Date(), paymentEvents: [...A.cal.items[0].paymentEvents, { event: "webhook_captured", razorpayOrderId: "order_Alpha", razorpayPaymentId: "pay_1", amountCents: 12500, currency: "USD" }] });
  const url = `/api/invoices/calendar/${A.cal._id}/items/0/refund`;
  assert.strictEqual((await call("POST", url, { as: staff, body: { reason: "test" } })).status, 403, "tech staff can't refund");
  assert.strictEqual((await call("POST", url, { as: alice, body: { reason: "test" } })).status, 403, "a client can't refund themselves");
  for (const amount of ["-5", "0", "abc", "1e9", "999999"]) {
    const r = await call("POST", url, { as: finance, body: { amount, reason: "test" } });
    assert.strictEqual(r.status, 400, `amount ${amount} → ${r.status}`);
  }
  assert.strictEqual((A.cal.items[0].refunds || []).length, 0);
});

// =====================================================================
// Page addresses without ".html"
// =====================================================================
test("server.js serves each page at an address without .html, and sends the old address there", async () => {
  // The same page wiring as server.js, read from it so the two can't drift.
  const serverJs = fs.readFileSync(path.join(root, "server.js"), "utf8");
  const names = JSON.parse(serverJs.match(/const PAGE_NAMES = (\[[^\]]+\]);/)[1]);
  const pages = fs.readdirSync(path.join(root, "public")).filter((f) => f.endsWith(".html")).map((f) => f.slice(0, -5));
  assert.deepStrictEqual([...names].sort(), pages.sort(), "every page in public/ is covered by the redirect");
  for (const name of names.filter((n) => n !== "index")) {
    assert.ok(serverJs.includes(`"/${name}"`), `/${name} has its own route`);
    assert.ok(!serverJs.includes(`app.get("/${name}.html"`), `/${name}.html is not served directly`);
  }
  assert.ok(serverJs.indexOf("PAGE_NAMES.map") < serverJs.indexOf("express.static("), "old addresses are redirected before files are served");

  // No page, email or notification still points at an .html address.
  const stale = [];
  const scan = (dir) => fs.readdirSync(path.join(root, dir), { withFileTypes: true }).forEach((e) => {
    if (e.isDirectory()) { if (e.name !== "vendor") scan(path.join(dir, e.name)); return; }
    if (!/\.(js|html)$/.test(e.name)) return;
    const src = fs.readFileSync(path.join(root, dir, e.name), "utf8");
    for (const m of src.matchAll(/(["'`=(]|\$\{[^}]*\})\/(app|review|calendar|pipeline|reports|admin|dashboard|portal|login|two-factor|index)\.html/g)) {
      stale.push(`${dir}/${e.name}: ${m[0]}`);
    }
  });
  ["routes", "lib", "middleware", "public"].forEach(scan);
  assert.deepStrictEqual(stale, []);
});
