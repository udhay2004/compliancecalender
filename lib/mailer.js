// lib/mailer.js
//
// The one place in the app that actually sends mail. Three backends,
// tried in this order:
//
//   1. Resend   — if RESEND_API_KEY is set. Plain HTTPS call, no SDK
//                 and therefore no extra dependency; Node 18+ has fetch
//                 built in.
//   2. SMTP     — if SMTP_HOST/SMTP_USER/SMTP_PASS are set. The
//                 original path, kept working so nothing that relied on
//                 it (lib/reminders.js, routes/public.routes.js,
//                 portal/calendar routes) changes behavior.
//   3. Console  — neither configured: log what WOULD have been sent.
//                 Keeps local development usable without credentials.
//
// Note for the login-code flow specifically: console mode prints the
// code to the server log. That's fine on a laptop and completely
// unacceptable in production, so sendEmail refuses to fall through to
// console mode for mail marked critical when NODE_ENV is production —
// a silent no-op there would mean nobody could ever log in, and the
// failure would look like "the code never arrived" instead of pointing
// at the missing config.

const nodemailer = require("nodemailer");

// One shared, pooled SMTP connection instead of a new connection for every
// email (much faster when the daily reminders send hundreds), with time
// limits so a slow mail server can never hang a request.
let transport = null;
function getTransport() {
  if (!process.env.SMTP_HOST || !process.env.SMTP_USER || !process.env.SMTP_PASS) {
    return null;
  }
  if (!transport) {
    const port = parseInt(process.env.SMTP_PORT || "587", 10);
    transport = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port,
      secure: process.env.SMTP_SECURE === "true" || port === 465,
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
      pool: true,
      maxConnections: 3,
      connectionTimeout: 10000,
      greetingTimeout: 10000,
      socketTimeout: 20000,
    });
  }
  return transport;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Temporary problems worth one more try: rate limits, provider errors, network.
const isTemporary = (err) => /\((429|5\d\d)\)/.test(err.message) || ["ECONNRESET", "ETIMEDOUT", "ECONNREFUSED", "EAI_AGAIN", "ESOCKET"].includes(err.code) || err.name === "TimeoutError";

async function withRetry(fn, logPrefix) {
  try {
    return await fn();
  } catch (err) {
    if (!isTemporary(err)) throw err;
    console.warn(`${logPrefix} Email provider hiccup (${err.message}); retrying once…`);
    await sleep(1500);
    return fn();
  }
}

function fromAddress() {
  return (
    process.env.MAIL_FROM ||
    process.env.SMTP_FROM ||
    process.env.SMTP_USER ||
    "no-reply@theconnectventures.com"
  );
}

async function sendViaResend({ to, subject, text, html }) {
  const res = await fetch("https://api.resend.com/emails", {
    signal: AbortSignal.timeout(15000),
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: fromAddress(),
      to: Array.isArray(to) ? to : [to],
      subject,
      text,
      ...(html ? { html } : {}),
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    // Surfaced to the caller rather than swallowed: for a login code,
    // "we couldn't send it" has to become a visible error, not a
    // success message in front of an empty inbox.
    throw new Error(`Resend rejected the message (${res.status}): ${body.slice(0, 300)}`);
  }
  return res.json().catch(() => ({}));
}

/**
 * @param {object}  opts
 * @param {string}  opts.to
 * @param {string}  opts.subject
 * @param {string}  opts.text
 * @param {string} [opts.html]
 * @param {string} [opts.logPrefix]
 * @param {boolean}[opts.critical]  true for mail the user is actively
 *        waiting on (login codes). Throws instead of silently no-opping
 *        when no provider is configured in production.
 */
async function sendEmail({ to, subject, text, html, logPrefix = "[mailer]", critical = false }) {
  if (!to) {
    console.warn(`${logPrefix} Skipping send — no recipient. Subject: ${subject}`);
    return { skipped: true };
  }

  if (process.env.RESEND_API_KEY) {
    await withRetry(() => sendViaResend({ to, subject, text, html }), logPrefix);
    return { sent: "resend" };
  }

  const smtp = getTransport();
  if (smtp) {
    await withRetry(() => smtp.sendMail({ from: fromAddress(), to, subject, text, html }), logPrefix);
    return { sent: "smtp" };
  }

  if (critical && process.env.NODE_ENV === "production") {
    throw new Error(
      "No email provider configured (set RESEND_API_KEY, or SMTP_HOST/SMTP_USER/SMTP_PASS). " +
      "Refusing to pretend a sign-in code was delivered."
    );
  }

  console.log(
    `${logPrefix} No email provider configured — would have sent to ${to}:\n  Subject: ${subject}\n  ${text}\n`
  );
  return { skipped: true };
}

/** Close pooled connections (used during shutdown). */
function closeMailer() {
  if (transport) { try { transport.close(); } catch (_) {} transport = null; }
}

module.exports = { sendEmail, fromAddress, closeMailer };
