// tests/production-hardening.test.js
//
// The "ready for real traffic" pieces: daily AI budget and human check,
// shared rate limits, single-run jobs, one-at-a-time payment recording,
// email retries, file content checks.
//
//   node --test tests/

const test = require("node:test");
const assert = require("node:assert");
const path = require("node:path");

process.env.NODE_ENV = "test";
process.env.JWT_SECRET = "test-secret";

const root = path.join(__dirname, "..");
const stub = (rel, exports) => {
  const file = require.resolve(path.join(root, rel));
  require.cache[file] = { id: file, filename: file, loaded: true, exports };
};

// In-memory stand-ins.
const counters = {};
stub("models/Counter.js", { next: async (name) => (counters[name] = (counters[name] || 0) + 1) });
const staffAlerts = [];
stub("lib/notify.js", { notifyStaff: async (n) => { staffAlerts.push(n); }, notifyClient: async () => ({}) });

const locks = new Map();
function lockQuery(result) { return { then: (a, b) => Promise.resolve(result()).then(a, b), catch: (b) => Promise.resolve(result()).catch(b) }; }
stub("models/JobLock.js", {
  create: async (doc) => {
    if (locks.has(doc._id)) { const e = new Error("dup"); e.code = 11000; throw e; }
    locks.set(doc._id, { finishedAt: null, ...doc });
    return doc;
  },
  findOneAndUpdate: (q, u) => lockQuery(() => {
    const d = locks.get(q._id);
    if (!d) return null;
    if ("finishedAt" in q && d.finishedAt !== q.finishedAt) return null;
    if (q.lockedUntil && !(d.lockedUntil < q.lockedUntil.$lt)) return null;
    Object.assign(d, u.$set);
    return d;
  }),
  updateOne: (q, u) => lockQuery(() => { const d = locks.get(q._id); if (d && d.owner === q.owner) Object.assign(d, u.$set); return {}; }),
  deleteOne: (q) => lockQuery(() => { const d = locks.get(q._id); if (d && d.owner === q.owner) locks.delete(q._id); return {}; }),
});

const realFetch = global.fetch;
let fetchReply = null;
const fetchCalls = [];
global.fetch = async (url, opts) => {
  if (fetchReply) { fetchCalls.push({ url: String(url), opts }); return fetchReply(String(url), opts); }
  return realFetch(url, opts);
};

// =====================================================================
// Daily AI budget and human check
// =====================================================================
const guard = require("../lib/abuseGuard");

test("the free tool stops at its daily limit, clients at the total, staff never", async () => {
  process.env.AI_DAILY_LIMIT_PUBLIC = "2";
  process.env.AI_DAILY_LIMIT_TOTAL = "4";
  Object.keys(counters).forEach((k) => delete counters[k]);
  staffAlerts.length = 0;
  await guard.reserveAiRun("public");
  await guard.reserveAiRun("public");
  await assert.rejects(guard.reserveAiRun("public"), (e) => e instanceof guard.BudgetError && e.status === 429 && /very busy today/.test(e.message));
  await new Promise((r) => setTimeout(r, 10));
  assert.strictEqual(staffAlerts.length, 1, "the team is told once");
  await guard.reserveAiRun("client"); // total is now 4
  await assert.rejects(guard.reserveAiRun("client"), /today's limit/);
  await guard.reserveAiRun("staff"); // counted, never blocked
  await guard.reserveAiRun("public").catch(() => {});
  await new Promise((r) => setTimeout(r, 10));
  assert.strictEqual(staffAlerts.length, 2, "one alert per limit per day");
  delete process.env.AI_DAILY_LIMIT_PUBLIC; delete process.env.AI_DAILY_LIMIT_TOTAL;
});

test("human check: off without keys; with keys the token is verified with Cloudflare", async () => {
  delete process.env.TURNSTILE_SITE_KEY; delete process.env.TURNSTILE_SECRET_KEY;
  assert.deepStrictEqual(await guard.verifyHuman(undefined), { ok: true, skipped: true });

  process.env.TURNSTILE_SITE_KEY = "site"; process.env.TURNSTILE_SECRET_KEY = "secret";
  assert.strictEqual((await guard.verifyHuman("")).ok, false, "missing token refused");
  fetchReply = async (url, opts) => new Response(JSON.stringify({ success: opts.body.get("response") === "good" }), { status: 200 });
  assert.strictEqual((await guard.verifyHuman("good", "1.2.3.4")).ok, true);
  assert.strictEqual(fetchCalls.at(-1).url, "https://challenges.cloudflare.com/turnstile/v0/siteverify");
  assert.strictEqual(fetchCalls.at(-1).opts.body.get("secret"), "secret");
  assert.strictEqual(fetchCalls.at(-1).opts.body.get("remoteip"), "1.2.3.4");
  assert.strictEqual((await guard.verifyHuman("bad")).ok, false);
  // Cloudflare down: real people aren't locked out (the budget still applies).
  fetchReply = async () => { throw new Error("network down"); };
  assert.strictEqual((await guard.verifyHuman("any")).ok, true);
  fetchReply = null;
  delete process.env.TURNSTILE_SITE_KEY; delete process.env.TURNSTILE_SECRET_KEY;
});

// =====================================================================
// Rate limits (memory fallback path; the database path is the same logic)
// =====================================================================
test("overLimit counts per person and resets after the window", async () => {
  const { overLimit } = require("../lib/rateLimitStore");
  assert.strictEqual(await overLimit("t", "a", 2, 50), false);
  assert.strictEqual(await overLimit("t", "a", 2, 50), false);
  assert.strictEqual(await overLimit("t", "a", 2, 50), true, "3rd in the window is over");
  assert.strictEqual(await overLimit("t", "b", 2, 50), false, "someone else is separate");
  await new Promise((r) => setTimeout(r, 70));
  assert.strictEqual(await overLimit("t", "a", 2, 50), false, "new window");
});

test("the rate-limit store works with express-rate-limit (falls back to memory)", async () => {
  const { mongoStore } = require("../lib/rateLimitStore");
  const st = mongoStore("x");
  st.init({ windowMs: 1000 });
  assert.strictEqual((await st.increment("ip1")).totalHits, 1);
  assert.strictEqual((await st.increment("ip1")).totalHits, 2);
  await st.resetAll();
  assert.strictEqual((await st.increment("ip1")).totalHits, 1);
  st.shutdown();
});

// =====================================================================
// Scheduled jobs run once
// =====================================================================
test("a daily job runs on one server only, once per day; a failed run can be retried", async () => {
  const { runExclusive } = require("../lib/jobLock");
  locks.clear();
  let runs = 0;
  const job = () => runExclusive("reminders", { period: "2026-09-26", ttlMs: 60000 }, async () => { runs++; await new Promise((r) => setTimeout(r, 20)); return "done"; });
  const [a, b] = await Promise.all([job(), job()]); // two servers at 08:00
  assert.strictEqual(runs, 1);
  assert.deepStrictEqual([a.ran, b.ran].sort(), [false, true]);
  assert.strictEqual((await job()).ran, false, "not again the same day (e.g. after a restart)");
  assert.strictEqual((await runExclusive("reminders", { period: "2026-09-27" }, async () => runs++)).ran, true, "next day runs");

  await assert.rejects(runExclusive("backup", { period: "d1" }, async () => { throw new Error("R2 down"); }), /R2 down/);
  assert.strictEqual((await runExclusive("backup", { period: "d1" }, async () => "ok")).ran, true, "failed run released for a retry");

  // A server that died mid-job: its claim runs out and another may take over.
  locks.set("stuck:d", { _id: "stuck:d", owner: "dead", lockedUntil: new Date(Date.now() - 1000), finishedAt: null });
  assert.strictEqual((await runExclusive("stuck", { period: "d" }, async () => "ok")).ran, true);
});

// =====================================================================
// Payment recorded once
// =====================================================================
test("the same payment arriving twice at once is processed one after the other", async () => {
  const { withKeyLock } = require("../lib/keyedLock");
  const order = [];
  let recorded = false;
  const record = (who) => withKeyLock("payment:pay_1", async () => {
    order.push(`${who}:start`);
    await new Promise((r) => setTimeout(r, 15));
    const outcome = recorded ? "duplicate" : "paid";
    recorded = true;
    order.push(`${who}:${outcome}`);
    return outcome;
  });
  const results = await Promise.all([record("browser"), record("webhook")]);
  assert.deepStrictEqual(results, ["paid", "duplicate"]);
  assert.deepStrictEqual(order, ["browser:start", "browser:paid", "webhook:start", "webhook:duplicate"]);
  // Different payments don't wait for each other.
  const t0 = Date.now();
  await Promise.all([withKeyLock("payment:a", () => new Promise((r) => setTimeout(r, 30))), withKeyLock("payment:b", () => new Promise((r) => setTimeout(r, 30)))]);
  assert.ok(Date.now() - t0 < 55);
});

test("a conflicting save is retried", async () => {
  const { retryOnConflict } = require("../lib/keyedLock");
  let n = 0;
  const r = await retryOnConflict(async () => { n++; if (n < 2) { const e = new Error("No matching document"); e.name = "VersionError"; throw e; } return "saved"; });
  assert.strictEqual(r, "saved");
  assert.strictEqual(n, 2);
  await assert.rejects(retryOnConflict(async () => { throw new Error("other"); }), /other/);
});

// =====================================================================
// Email retry
// =====================================================================
test("a temporary email provider error is retried once; a real rejection is not", async () => {
  process.env.RESEND_API_KEY = "re_test";
  const { sendEmail } = require("../lib/mailer");
  let calls = 0;
  fetchReply = async () => { calls++; return calls === 1 ? new Response("busy", { status: 503 }) : new Response("{}", { status: 200 }); };
  assert.deepStrictEqual(await sendEmail({ to: "a@b.com", subject: "s", text: "t" }), { sent: "resend" });
  assert.strictEqual(calls, 2);
  calls = 0;
  fetchReply = async () => { calls++; return new Response("bad address", { status: 422 }); };
  await assert.rejects(sendEmail({ to: "x", subject: "s", text: "t" }), /422/);
  assert.strictEqual(calls, 1);
  fetchReply = null;
  delete process.env.RESEND_API_KEY;
});

// =====================================================================
// Upload content checks
// =====================================================================
test("file types are recognised by content", async () => {
  const fs = require("node:fs");
  const os = require("node:os");
  const { _internals } = require("../middleware/upload");
  const write = (bytes) => { const p = path.join(os.tmpdir(), `t-${Math.random()}`); fs.writeFileSync(p, Buffer.from(bytes)); return p; };
  const file = (name, mimetype, bytes) => ({ originalname: name, mimetype, path: write(bytes), size: bytes.length || 1 });
  const ok = [
    file("a.pdf", "application/pdf", [...Buffer.from("%PDF-1.7\n")]),
    file("b.png", "image/png", [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]),
    file("c.jpg", "image/jpeg", [0xff, 0xd8, 0xff, 0xe0, 0]),
    file("d.webp", "image/webp", [...Buffer.from("RIFF\0\0\0\0WEBPVP8 ")]),
    file("e.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", [0x50, 0x4b, 0x03, 0x04, 0]),
    file("f.xls", "application/vnd.ms-excel", [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]),
  ];
  assert.strictEqual(await _internals.contentProblem(ok), null);
  assert.match(await _internals.contentProblem([file("x.png", "image/png", [...Buffer.from("%PDF")])]), /doesn't look like a real PNG/);
  assert.match(await _internals.contentProblem([file("x.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", [...Buffer.from("MZ")])]), /DOCX/);
  assert.match(await _internals.contentProblem([{ originalname: "e.pdf", mimetype: "application/pdf", path: write([]), size: 0 }]), /is empty/);
});

test.after(() => { global.fetch = realFetch; });
