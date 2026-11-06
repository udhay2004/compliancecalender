// tests/reminder-cc.test.js
//
// Every reminder email is CC'd to finance (REMINDER_CC_EMAIL, default
// finance@theconnectventures.com) — lib/reminders.js, lib/notify.js,
// lib/mailer.js. The real reminder sweep, notify and mailer run here; the
// database models are in-memory stand-ins and Resend is faked at the
// fetch() level, so the exact request body is checked.
//
//   node --test tests/

const test = require("node:test");
const assert = require("node:assert");
const path = require("node:path");

process.env.NODE_ENV = "test";
process.env.APP_URL = "https://app.example.com";
process.env.RESEND_API_KEY = "re_test";
process.env.ADMIN_EMAIL = "admin@theconnectventures.com";
delete process.env.REMINDER_CC_EMAIL;
delete process.env.SMTP_HOST;

const root = path.join(__dirname, "..");
const stub = (rel, exports) => {
  const file = require.resolve(path.join(root, rel));
  require.cache[file] = { id: file, filename: file, loaded: true, exports };
};
const query = (result) => {
  const q = { populate: () => q, select: () => q, lean: () => q, then: (a, b) => Promise.resolve(result()).then(a, b), catch: (b) => Promise.resolve(result()).catch(b) };
  return q;
};

let calendars = [];
let orgs = [];
stub("models/Calendar.js", { find: () => Promise.resolve(calendars) });
stub("models/ClientOrg.js", { findById: (id) => query(() => orgs.find((o) => String(o._id) === String(id)) || null) });
stub("models/Notification.js", { create: async (n) => n });
stub("lib/whatsapp.js", { canMessage: () => false, sendToOrg: async () => ({ ok: false }) });

// Resend, faked.
const sent = [];
let reply = () => new Response("{}", { status: 200 });
global.fetch = async (url, opts) => {
  const body = JSON.parse(opts.body);
  sent.push(body);
  return reply(body);
};

const { runReminderSweep, reminderCc } = require("../lib/reminders");
const { sendEmail } = require("../lib/mailer");

const DAY = 86400000;
function setup({ contact = "jane@acme.com" } = {}) {
  sent.length = 0;
  orgs = [{ _id: "org1", name: "Acme Inc", primaryContactName: "Jane", primaryContactEmail: contact, assignedStaff: null }];
  const cal = {
    _id: "cal1", clientOrgId: "org1", status: "approved", supersededAt: null,
    profile: { companyName: "Acme Inc", state: "Delaware", entityType: "Corporation", fyEnd: "Dec" },
    items: [{
      category: "Mandatory Annual", compliance_name: "Delaware Franchise Tax", due_date: "1 March (Annually)",
      dueDateActual: new Date(Date.now() + 5 * DAY), dueDateSource: "staff",
      selectedByClient: true, selectedAt: new Date(Date.now() - DAY / 2), clientStatus: "Awaiting Documents",
      paymentStatus: "Overdue", feeAmountCents: 10000, documents: [], paymentEvents: [], remindersSent: [],
    }],
    save: async () => cal,
  };
  calendars = [cal];
}
const quietly = async (fn) => {
  const { log, warn } = console;
  const lines = [];
  console.log = console.warn = (...a) => lines.push(a.join(" "));
  try { return { result: await fn(), lines }; } finally { Object.assign(console, { log, warn }); }
};

test("reminder CC: default is finance; comma list is trimmed; blanks and non-addresses are dropped", async () => {
  assert.deepStrictEqual(reminderCc(), ["finance@theconnectventures.com"]);
  process.env.REMINDER_CC_EMAIL = "   ";
  assert.deepStrictEqual(reminderCc(), ["finance@theconnectventures.com"]);
  process.env.REMINDER_CC_EMAIL = " finance@theconnectventures.com , ,accounts@theconnectventures.com,not-an-email ";
  const { result } = await quietly(() => reminderCc());
  assert.deepStrictEqual(result, ["finance@theconnectventures.com", "accounts@theconnectventures.com"]);
  delete process.env.REMINDER_CC_EMAIL;
});

test("reminder CC: every reminder email from the daily sweep CCs finance, and only finance", async () => {
  setup();
  const { lines } = await quietly(() => runReminderSweep());
  // Payment-overdue + client digest to Jane, team digest to admin.
  assert.strictEqual(sent.length, 3);
  for (const m of sent) assert.deepStrictEqual(m.cc, ["finance@theconnectventures.com"]);
  assert.deepStrictEqual(sent.map((m) => m.to[0]).sort(), ["admin@theconnectventures.com", "jane@acme.com", "jane@acme.com"]);
  assert.strictEqual(lines.filter((l) => l.includes("cc=finance@theconnectventures.com")).length, 3, "one CC log line per send");
});

test("reminder CC: not added twice when finance is already the To address (case-insensitive)", async () => {
  setup({ contact: "Finance@TheConnectVentures.com" });
  await quietly(() => runReminderSweep());
  const toFinance = sent.filter((m) => m.to[0].toLowerCase() === "finance@theconnectventures.com");
  assert.ok(toFinance.length >= 1);
  for (const m of toFinance) assert.strictEqual(m.cc, undefined);
  const r = await quietly(() => sendEmail({ to: "a@b.com", cc: ["X@y.com", "x@Y.com", " a@B.com "], subject: "s", text: "t" }));
  assert.deepStrictEqual(sent[sent.length - 1].cc, ["X@y.com"]);
  assert.deepStrictEqual(r.result, { sent: "resend" });
});

test("reminder CC: if the provider refuses the CC, the client's reminder is still sent without it", async () => {
  setup();
  reply = (body) => (body.cc ? new Response("invalid cc", { status: 422 }) : new Response("{}", { status: 200 }));
  const { result, lines } = await quietly(() => runReminderSweep());
  reply = () => new Response("{}", { status: 200 });
  const delivered = sent.filter((m) => !m.cc);
  assert.strictEqual(delivered.length, 3, "all three reminders still went out");
  assert.strictEqual(result.clientDigests, 1);
  assert.ok(lines.some((l) => l.includes("cc=none") && l.includes("422")));
  assert.ok(!lines.some((l) => l.includes("invalid cc")), "provider response body is not logged");
});

test("reminder CC: other emails are untouched (no cc key at all)", async () => {
  sent.length = 0;
  await sendEmail({ to: "someone@example.com", subject: "Welcome", text: "hi" });
  assert.ok(!("cc" in sent[0]));
});
