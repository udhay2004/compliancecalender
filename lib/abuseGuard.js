// lib/abuseGuard.js
//
// Keeps bots off the free calendar generator (every submission creates a
// lead and emails the team).
//
// HUMAN CHECK (Cloudflare Turnstile, free). When TURNSTILE_SITE_KEY and
// TURNSTILE_SECRET_KEY are set, the public generator shows a small
// "verify you are human" box and the server checks its token with
// Cloudflare before building anything. Without the keys the check is off
// (a warning is logged at startup in production). The per-IP rate limit in
// routes/public.routes.js applies either way.

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
    // Cloudflare unreachable: don't lock real people out; the per-IP rate
    // limit still applies.
    console.error("[abuse-guard] Turnstile check failed to run (allowing):", err.message);
    return { ok: true, unverified: true };
  }
}

module.exports = { verifyHuman, humanCheckEnabled, turnstileKeys };
