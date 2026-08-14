// lib/mailer.js
//
// Shared SMTP sending, extracted out of lib/reminders.js (which was the
// only caller until routes/public.routes.js needed to notify admin of
// new leads too — this is now the one place that owns the transporter).
//
// Same behavior as before: if SMTP_HOST/SMTP_USER/SMTP_PASS aren't set,
// sendEmail() logs what it WOULD have sent instead of sending, so email
// flows can be built and tested before an SMTP provider is chosen.

const nodemailer = require("nodemailer");

function getTransport() {
  if (!process.env.SMTP_HOST || !process.env.SMTP_USER || !process.env.SMTP_PASS) {
    return null;
  }
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT || "587", 10),
    secure: process.env.SMTP_SECURE === "true",
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
}

async function sendEmail({ to, subject, text, logPrefix = "[mailer]" }) {
  const transport = getTransport();
  if (!transport) {
    console.log(`${logPrefix} SMTP not configured — would have sent to ${to}:\n  Subject: ${subject}\n  ${text}\n`);
    return;
  }
  if (!to) {
    console.warn(`${logPrefix} Skipping send — no recipient email on record. Subject: ${subject}`);
    return;
  }
  await transport.sendMail({
    from: process.env.SMTP_FROM || process.env.SMTP_USER,
    to,
    subject,
    text,
  });
}

module.exports = { sendEmail };
