// lib/email.js
//
// Minimal SMTP mailer for the signup-approval flow:
//   - notifyAdminOfSignup(user)  → sent to ADMIN_EMAIL when someone signs up
//   - notifyUserApproved(user)   → sent to the new user once approved
//   - notifyUserRejected(user)   → sent to the new user if rejected
//
// Uses plain SMTP via nodemailer so it works with Zoho, Gmail, or any
// other provider — just set the SMTP_* env vars. If they're not set, this
// logs a warning and no-ops instead of crashing the server, so local dev
// without email configured still works (you'll just need to approve users
// directly in the database, or read the token from the server log — see
// below).

const nodemailer = require("nodemailer");

function getTransport() {
  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS } = process.env;
  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS) return null;
  return nodemailer.createTransport({
    host: SMTP_HOST,
    port: Number(SMTP_PORT) || 587,
    secure: Number(SMTP_PORT) === 465, // true for 465, false for 587/others (STARTTLS)
    auth: { user: SMTP_USER, pass: SMTP_PASS },
  });
}

function appUrl() {
  return (process.env.APP_URL || "http://localhost:3000").replace(/\/$/, "");
}

async function sendMail({ to, subject, html, text }) {
  const transport = getTransport();
  if (!transport) {
    console.warn(
      `[email] SMTP not configured (SMTP_HOST/SMTP_USER/SMTP_PASS missing) — ` +
      `skipping email "${subject}" to ${to}. Set these in .env to actually send mail.`
    );
    return { skipped: true };
  }
  const from = process.env.SMTP_FROM || process.env.SMTP_USER;
  return transport.sendMail({ from, to, subject, html, text });
}

async function notifyAdminOfSignup(user, approveToken, rejectToken) {
  const adminEmails = (process.env.ADMIN_EMAIL || "")
    .split(",")
    .map((e) => e.trim())
    .filter(Boolean);
  if (!adminEmails.length) {
    console.warn("[email] ADMIN_EMAIL is not set — no one will be notified of this signup request.");
    return;
  }

  const approveUrl = `${appUrl()}/api/auth/approve/${approveToken}`;
  const rejectUrl = `${appUrl()}/api/auth/reject/${rejectToken}`;

  const html = `
    <p>New signup request for the Compliance Calendar Generator:</p>
    <p><strong>Name:</strong> ${user.name || "(not provided)"}<br>
       <strong>Email:</strong> ${user.email}</p>
    <p>
      <a href="${approveUrl}" style="background:#1a7f37;color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none;margin-right:10px;">Approve</a>
      <a href="${rejectUrl}" style="background:#b91c1c;color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none;">Reject</a>
    </p>
    <p style="color:#666;font-size:13px;">These links expire in 7 days and can each only be used once.</p>
  `;
  const text = `New signup request: ${user.name || "(no name)"} <${user.email}>\n\nApprove: ${approveUrl}\nReject: ${rejectUrl}\n\n(Links expire in 7 days.)`;

  await sendMail({
    to: adminEmails.join(","),
    subject: `Approve access request — ${user.email}`,
    html,
    text,
  });
}

async function notifyUserApproved(user) {
  const loginUrl = `${appUrl()}/login.html`;
  await sendMail({
    to: user.email,
    subject: "Your account has been approved",
    html: `<p>Hi ${user.name || ""},</p><p>Your account for the Compliance Calendar Generator has been approved. You can log in now:</p><p><a href="${loginUrl}">${loginUrl}</a></p>`,
    text: `Your account has been approved. Log in at: ${loginUrl}`,
  });
}

async function notifyUserRejected(user) {
  const adminEmail = (process.env.ADMIN_EMAIL || "").split(",")[0].trim();
  await sendMail({
    to: user.email,
    subject: "Your access request was not approved",
    html: `<p>Hi ${user.name || ""},</p><p>Your signup request for the Compliance Calendar Generator was not approved.${adminEmail ? ` If you think this is a mistake, reach out to ${adminEmail}.` : ""}</p>`,
    text: `Your signup request was not approved.${adminEmail ? ` Contact ${adminEmail} if you think this is a mistake.` : ""}`,
  });
}

module.exports = { notifyAdminOfSignup, notifyUserApproved, notifyUserRejected };
