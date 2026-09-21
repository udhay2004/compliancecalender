// lib/otp.js
//
// Everything about the email-code login that isn't HTTP plumbing:
// minting a code, hashing it, checking it, and the two emails that carry
// it. routes/auth.routes.js owns the request/response side and calls in
// here for the actual security-relevant work.

const crypto = require("crypto");
const LoginOtp = require("../models/LoginOtp");
const { sendEmail } = require("./mailer");

const CODE_LENGTH = 6;
const TTL_MINUTES = 10;
// Six digits with a 5-attempt cap means a guesser gets roughly a
// 1-in-200,000 shot per code before the account locks. Raising the
// length is pointless next to that cap; lowering the cap is what would
// actually matter.
const MAX_ATTEMPTS = 5;
// Stops the request endpoint being used as a free mail cannon against
// one of our own addresses.
const RESEND_COOLDOWN_SECONDS = 60;
// After this many failed codes the account freezes for LOCK_MINUTES,
// regardless of how many IPs the attempts came from.
const MAX_ACCOUNT_FAILURES = 10;
const LOCK_MINUTES = 15;

// crypto.randomInt is a CSPRNG. Math.random() is not, and a login code
// drawn from Math.random() is predictable from a handful of samples —
// this is the single most important line in the file.
function generateCode() {
  const max = 10 ** CODE_LENGTH;
  return String(crypto.randomInt(0, max)).padStart(CODE_LENGTH, "0");
}

// Keyed hash rather than a bare SHA-256: without the key, someone
// holding a dump of this collection could rainbow-table all million
// possible six-digit codes in about a second.
function hashCode(code) {
  return crypto
    .createHmac("sha256", process.env.JWT_SECRET)
    .update(String(code))
    .digest("hex");
}

// Length-independent, constant-time comparison. A plain === leaks how
// many leading characters matched through its timing, which is enough
// to reconstruct a secret given enough samples.
function safeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

// Has this address asked for a code within the cooldown window?
async function isInCooldown(email) {
  const recent = await LoginOtp.findOne({ email, consumedAt: null }).sort({ createdAt: -1 });
  if (!recent) return false;
  const ageSeconds = (Date.now() - recent.createdAt.getTime()) / 1000;
  return ageSeconds < RESEND_COOLDOWN_SECONDS;
}

// Mints a code, invalidating any earlier outstanding ones for the same
// address so only the newest email ever works — otherwise every code
// sent in the last ten minutes would stay live at once, multiplying an
// attacker's chances for free.
async function issueCode({ email, user, requestIp }) {
  await LoginOtp.updateMany(
    { email, consumedAt: null },
    { $set: { consumedAt: new Date() } }
  );

  const code = generateCode();
  await LoginOtp.create({
    email,
    userId: user?._id || null,
    codeHash: hashCode(code),
    purpose: "login",
    expiresAt: new Date(Date.now() + TTL_MINUTES * 60 * 1000),
    requestIp: requestIp || "",
  });
  return code;
}

// Returns { ok: true, record } or { ok: false, reason }. Reasons are for
// the server log and for deciding whether to lock the account — the
// route deliberately collapses them into one vague message for the
// browser.
async function verifyCode({ email, code }) {
  const record = await LoginOtp.findOne({ email, consumedAt: null }).sort({ createdAt: -1 });
  if (!record) return { ok: false, reason: "no_code" };
  if (record.expiresAt <= new Date()) return { ok: false, reason: "expired" };
  if (record.attempts >= MAX_ATTEMPTS) return { ok: false, reason: "too_many_attempts" };

  if (!safeEqual(hashCode(code), record.codeHash)) {
    record.attempts += 1;
    await record.save();
    return { ok: false, reason: "mismatch", attemptsLeft: Math.max(0, MAX_ATTEMPTS - record.attempts) };
  }

  record.consumedAt = new Date();
  await record.save();
  return { ok: true, record };
}

function layout(innerHtml) {
  return `<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;max-width:480px;margin:0 auto;padding:32px 24px;color:#1B2A2E;">
  <div style="font-size:15px;font-weight:700;color:#34A9A1;margin-bottom:24px;">Compliance Calendar</div>
  ${innerHtml}
  <p style="color:#98A6A5;font-size:12px;line-height:1.6;margin-top:32px;border-top:1px solid #E1E9E8;padding-top:16px;">
    This is an automated message from an internal system. Please don't reply to it.
  </p>
</div>`;
}

async function sendLoginCode({ to, code, name }) {
  const html = layout(`
    <p style="font-size:15px;line-height:1.6;">Hi ${name || "there"},</p>
    <p style="font-size:15px;line-height:1.6;">Here is your sign-in code:</p>
    <p style="font-size:34px;font-weight:700;letter-spacing:8px;background:#E3F5F3;color:#278A83;padding:18px 24px;border-radius:10px;text-align:center;margin:24px 0;">${code}</p>
    <p style="font-size:14px;line-height:1.6;color:#5C6E72;">It expires in ${TTL_MINUTES} minutes and can only be used once.</p>
    <p style="font-size:14px;line-height:1.6;color:#5C6E72;"><strong>If you didn't try to sign in, ignore this email and tell your administrator</strong> — someone has your address and is trying to get into your account.</p>
  `);

  await sendEmail({
    to,
    subject: `${code} is your sign-in code`,
    text: `Your sign-in code is ${code}. It expires in ${TTL_MINUTES} minutes and can only be used once.\n\nIf you didn't try to sign in, ignore this email and tell your administrator.`,
    html,
    logPrefix: "[otp]",
    critical: true,
  });
}

// Sent after a password is set or changed. Not a courtesy — it's the
// alarm bell that tells the real owner an attacker got in, which is why
// every consumer service sends one.
async function sendPasswordChangedNotice({ to, name }) {
  const html = layout(`
    <p style="font-size:15px;line-height:1.6;">Hi ${name || "there"},</p>
    <p style="font-size:15px;line-height:1.6;">The password on your Compliance Calendar account was just set or changed, and every other device that was signed in has been signed out.</p>
    <p style="font-size:14px;line-height:1.6;color:#5C6E72;"><strong>If this wasn't you, contact your administrator immediately.</strong></p>
  `);
  await sendEmail({
    to,
    subject: "Your password was changed",
    text: "The password on your Compliance Calendar account was just set or changed, and all other sessions were signed out. If this wasn't you, contact your administrator immediately.",
    html,
    logPrefix: "[otp]",
  });
}

module.exports = {
  CODE_LENGTH,
  TTL_MINUTES,
  MAX_ATTEMPTS,
  RESEND_COOLDOWN_SECONDS,
  MAX_ACCOUNT_FAILURES,
  LOCK_MINUTES,
  generateCode,
  hashCode,
  safeEqual,
  isInCooldown,
  issueCode,
  verifyCode,
  sendLoginCode,
  sendPasswordChangedNotice,
};
