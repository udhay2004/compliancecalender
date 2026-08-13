// lib/reminders.js
//
// Two independent reminder types, run on a daily schedule (wired up in
// server.js via node-cron):
//
//   1. PAYMENT reminders — any item with paymentStatus "Overdue". Works
//      today, no setup beyond marking an item overdue via
//      PATCH /api/calendars/:id/items/:index/status.
//   2. DUE-DATE reminders — any item with `dueDateActual` set (see
//      models/Calendar.js for why this is separate from the free-text
//      `due_date`) that's within REMINDER_WINDOW_DAYS or already past,
//      and not yet "Filed". Only covers items staff has given a real
//      date to — this is a known, documented gap, not a silent one.
//
// Both respect `lastReminderSentAt` so the same item doesn't get
// re-emailed every single day — see REMINDER_COOLDOWN_DAYS.
//
// EMAIL DELIVERY: if SMTP_HOST/SMTP_USER/SMTP_PASS aren't set, this
// logs what it WOULD have sent instead of actually sending — so the
// reminders logic can be built and tested before you've picked an email
// provider (Postmark/SendGrid/SES are the standard choices; don't try
// to send transactional email without one of these in production,
// deliverability will suffer badly).

const nodemailer = require("nodemailer");
const Calendar = require("../models/Calendar");
const ClientOrg = require("../models/ClientOrg");

const REMINDER_WINDOW_DAYS = parseInt(process.env.REMINDER_WINDOW_DAYS || "7", 10);
const REMINDER_COOLDOWN_DAYS = parseInt(process.env.REMINDER_COOLDOWN_DAYS || "7", 10);

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

async function sendEmail({ to, subject, text }) {
  const transport = getTransport();
  if (!transport) {
    console.log(`[reminders] SMTP not configured — would have sent to ${to}:\n  Subject: ${subject}\n  ${text}\n`);
    return;
  }
  if (!to) {
    console.warn(`[reminders] Skipping send — no recipient email on record. Subject: ${subject}`);
    return;
  }
  await transport.sendMail({
    from: process.env.SMTP_FROM || process.env.SMTP_USER,
    to,
    subject,
    text,
  });
}

function needsCooldown(lastSentAt) {
  if (!lastSentAt) return false;
  const ageDays = (Date.now() - new Date(lastSentAt).getTime()) / (24 * 60 * 60 * 1000);
  return ageDays < REMINDER_COOLDOWN_DAYS;
}

async function runReminderSweep() {
  const calendars = await Calendar.find({ status: "approved", clientOrgId: { $ne: null } });
  let sent = 0;

  for (const calendar of calendars) {
    const org = await ClientOrg.findById(calendar.clientOrgId);
    const recipient = org?.primaryContactEmail;
    let changed = false;

    for (const item of calendar.items) {
      if (needsCooldown(item.lastReminderSentAt)) continue;

      // --- Payment reminder ---
      if (item.paymentStatus === "Overdue") {
        await sendEmail({
          to: recipient,
          subject: `Payment overdue: ${item.compliance_name} — ${calendar.profile.companyName || "your company"}`,
          text:
            `This is a reminder that payment for "${item.compliance_name}" is overdue.\n\n` +
            `Please log in to the ComplyGlobally client portal to review and settle this item.`,
        });
        item.lastReminderSentAt = new Date();
        changed = true;
        sent++;
        continue; // one reminder per item per sweep — don't double-send payment + due-date same day
      }

      // --- Due-date reminder ---
      if (item.dueDateActual && item.clientStatus !== "Filed") {
        const daysUntilDue = Math.ceil((new Date(item.dueDateActual) - Date.now()) / (24 * 60 * 60 * 1000));
        if (daysUntilDue <= REMINDER_WINDOW_DAYS) {
          const phrase =
            daysUntilDue < 0
              ? `is overdue by ${Math.abs(daysUntilDue)} day(s)`
              : daysUntilDue === 0
              ? "is due today"
              : `is due in ${daysUntilDue} day(s)`;
          await sendEmail({
            to: recipient,
            subject: `${daysUntilDue < 0 ? "OVERDUE" : "Upcoming"}: ${item.compliance_name} — ${calendar.profile.companyName || "your company"}`,
            text:
              `"${item.compliance_name}" ${phrase} (${new Date(item.dueDateActual).toDateString()}).\n\n` +
              `Current status: ${item.clientStatus}. Please log in to the ComplyGlobally client portal for details ` +
              `or to upload any required documents.`,
          });
          item.lastReminderSentAt = new Date();
          changed = true;
          sent++;
        }
      }
    }

    if (changed) await calendar.save();
  }

  console.log(`[reminders] Sweep complete — ${sent} reminder(s) sent/logged.`);
  return sent;
}

module.exports = { runReminderSweep };
