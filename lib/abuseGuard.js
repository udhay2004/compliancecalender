// lib/abuseGuard.js
//
// Protects the paid AI research (each calendar costs real money) from
// bots and runaway use. Two independent guards:
//
// 1. HUMAN CHECK (Cloudflare Turnstile, free). When TURNSTILE_SITE_KEY and
//    TURNSTILE_SECRET_KEY are set, the public generator shows a small
//    "verify you are human" box and the server checks its token with
//    Cloudflare before spending anything. Without the keys the check is off
//    (a warning is logged at startup in production).
//
// 2. DAILY BUDGET. Counts AI calendar runs per UTC day in MongoDB (shared by
//    every server copy). Once the limit is reached, further runs are refused
//    with a friendly message until tomorrow, and the team is told once.
//      AI_DAILY_LIMIT_PUBLIC   free tool on the website   (default 150)
//      AI_DAILY_LIMIT_TOTAL    public + client portal     (default 400)
//    Staff generating calendars in the staff app are never blocked (they have
//    their own per-person limit), but they do count towards the total.

const Counter = require("../models/Counter");

const num = (v, d) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n >= 0 ? n : d;
};
const limits = () => ({
  public: num(process.env.AI_DAILY_LIMIT_PUBLIC, 150),
  total: num(process.env.AI_DAILY_LIMIT_TOTAL, 400),
});
const today = () => new Date().toISOString().slice(0, 10);

class BudgetError extends Error {
  constructor(message) {
    super(message);
    this.status = 429;
  }
}

const alerted = new Set();
function alertOnce(kind, limit) {
  const key = `${today()}:${kind}`;
  if (alerted.has(key)) return;
  alerted.add(key);
  const { notifyStaff } = require("./notify");
  notifyStaff({
    type: "status_changed",
    title: `Daily AI limit reached (${kind}: ${limit} calendars)`,
    body: `No more ${kind === "public" ? "free website" : "client"} calendars will be generated today (UTC). ` +
      `If this is real demand, raise AI_DAILY_LIMIT_${kind === "public" ? "PUBLIC" : "TOTAL"} in Railway. If it looks like a bot, turn on the human check (TURNSTILE_SITE_KEY / TURNSTILE_SECRET_KEY).`,
    link: "/admin.html",
  }).catch(() => {});
}

/**
 * Count one AI run and refuse it if today's limit is used up.
 * source: "public" | "client" | "staff"
 * Throws BudgetError (status 429) when over the limit.
 */
async function reserveAiRun(source) {
  const l = limits();
  const day = today();
  const total = await Counter.next(`ai-runs:total:${day}`);
  if (source === "staff") return;
  if (l.total && total > l.total) {
    alertOnce("total", l.total);
    throw new BudgetError("We've reached today's limit for new calendars. Please try again tomorrow, or contact us and we'll prepare it for you.");
  }
  if (source === "public") {
    const pub = await Counter.next(`ai-runs:public:${day}`);
    if (l.public && pub > l.public) {
      alertOnce("public", l.public);
      throw new BudgetError("Our free calendar tool is very busy today. Please try again tomorrow, or contact us and we'll prepare it for you.");
    }
  }
}

// ---------------------------------------------------------------------
// Cloudflare Turnstile
// ---------------------------------------------------------------------
const turnstileKeys = () => ({
  siteKey: (process.env.TURNSTILE_SITE_KEY || "").trim(),
  secret: (process.env.TURNSTILE_SECRET_KEY || "").trim(),
});
const humanCheckEnabled = () => {
  const k = turnstileKeys();
  return Boolean(k.siteKey && k.secret);
};

/**
 * Verify a Turnstile token. Returns { ok, error }.
 * Always ok when the check is switched off.
 */
async function verifyHuman(token, remoteIp) {
  if (!humanCheckEnabled()) return { ok: true, skipped: true };
  if (!token || typeof token !== "string" || token.length > 2048) {
    return { ok: false, error: "Please complete the \"verify you are human\" check and try again." };
  }
  try {
    const body = new URLSearchParams({ secret: turnstileKeys().secret, response: token });
    if (remoteIp) body.set("remoteip", remoteIp);
    const res = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      body,
      signal: AbortSignal.timeout(8000),
    });
    const data = await res.json().catch(() => ({}));
    if (data.success) return { ok: true };
    return { ok: false, error: "The \"verify you are human\" check didn't pass. Please try it again." };
  } catch (err) {
    // Cloudflare unreachable: don't lock real people out; the daily budget
    // still protects the spend.
    console.error("[abuse-guard] Turnstile check failed to run (allowing):", err.message);
    return { ok: true, unverified: true };
  }
}

module.exports = { reserveAiRun, BudgetError, limits, verifyHuman, humanCheckEnabled, turnstileKeys };
