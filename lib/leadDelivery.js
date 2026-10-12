// lib/leadDelivery.js
//
// What a visitor gets after generating a calendar on the public tool
// (routes/public.routes.js): the whole calendar by email, and a portal
// account they can use if they want to.
//
//   * No account for the email yet: one is created with the phone number
//     they typed as its first password. The email says so: "username is
//     your email, password is your phone number". The calendar is already
//     in their portal when they sign in.
//   * A client account already exists: nothing about it changes (never the
//     password). The email says to sign in as usual; the calendar joins
//     their portal the next time they do.
//   * The email belongs to a team account: the calendar is emailed, with
//     nothing about signing in.
//
// Signing in stays optional. The calendar itself, with every due date, is
// in the email.

const User = require("../models/User");
const D = require("./deadlines");
const { sendEmail } = require("./mailer");
const { businessInfo } = require("./businessInfo");
const { createClientAccount, claimCalendars } = require("./clientAccounts");
const { logActivity } = require("./auditLog");
const { overLimit } = require("./rateLimitStore");

// One inbox gets at most this many calendar emails a day, however many
// calendars are generated with its address.
const MAX_EMAILS_PER_DAY = 10;
// How long the page waits to hear that the email was accepted for sending.
const SEND_WAIT_MS = 12000;

/** The phone number as a password: digits, with the leading + if given. */
function phonePassword(phone) {
  const raw = String(phone || "").trim();
  return (raw.startsWith("+") ? "+" : "") + raw.replace(/\D/g, "");
}

/**
 * The ways someone might type the phone number they gave us: with or
 * without spaces and brackets, with or without the leading +.
 */
function phonePasswordGuesses(typed) {
  const raw = String(typed || "");
  if (!/^\+?[\d\s().-]{7,25}$/.test(raw.trim())) return [];
  const digits = raw.replace(/\D/g, "");
  return [...new Set(["+" + digits, digits, digits.replace(/^00/, ""), "+" + digits.replace(/^00/, "")])].filter((g) => g !== raw);
}

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const fmt = (d) => `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;

/** Every filing with its next due date, soonest first; undated ones last. */
function calendarRows(calendar, now = new Date()) {
  const profile = calendar.profile || {};
  return (calendar.items || [])
    .map((item) => {
      const next = D.nextOccurrence(D.scheduleFor(item), profile, now, { businessDays: D.usesUsBusinessDays(item, profile) });
      return {
        name: item.compliance_name,
        category: item.category || "",
        authority: item.authority || "",
        rule: item.due_date || "",
        date: next ? next.date : null,
      };
    })
    .sort((a, b) => (a.date ? a.date.getTime() : Infinity) - (b.date ? b.date.getTime() : Infinity));
}

function buildEmail({ calendar, name, account, to, now = new Date() }) {
  const b = businessInfo();
  const brand = b.BRAND_NAME || "ComplyGlobally";
  const base = String(process.env.APP_URL || "").replace(/\/+$/, "");
  const loginUrl = `${base}/login?as=client&mode=password`;
  const company = calendar.profile?.companyName || "your company";
  const rows = calendarRows(calendar, now);
  const email = to || calendar.leadContact.email;

  const accountText = !account ? "" : account.kind === "new"
    ? `YOUR PORTAL (optional)\nWe have set up a portal for you. Sign in whenever you like to complete your company details, upload documents, message our team and have us file for you.\n\n  Sign in: ${loginUrl}\n  Username: ${email}\n  Password: ${account.password} (the phone number you gave us)\n\nYou can change the password in the portal at any time. Forgotten it? Choose "Sign in with an email code" on the sign-in page.\nIf you did not ask for this calendar, you can ignore this email.\n\n`
    : `YOUR PORTAL\nYou already have a portal with us. Sign in the way you usually do and this calendar will be there: ${loginUrl}\n\n`;

  const text =
    `Hi ${name || "there"},\n\nHere is the compliance calendar for ${company}: ${rows.length} filings, soonest first.\n\n` +
    rows.map((r) => `- ${r.date ? fmt(r.date) : "Date to be confirmed"}: ${r.name}${r.authority ? ` (${r.authority})` : ""}${r.date ? "" : ` — ${r.rule}`}`).join("\n") +
    `\n\n${accountText}Built from official government rules for the answers you gave. Rules change, so our team confirms each date before filing.\n\n${brand}\n${b.SUPPORT_EMAIL || ""} ${b.SUPPORT_PHONE || ""}`.trimEnd();

  const cell = "padding:10px 12px;border-bottom:1px solid #E4ECEB;font-size:14px;line-height:1.45;vertical-align:top;";
  const table = rows.map((r) => `<tr>
      <td style="${cell}white-space:nowrap;font-weight:700;color:${r.date ? "#1B2A2E" : "#8A9A9D"};">${r.date ? fmt(r.date) : "To be confirmed"}</td>
      <td style="${cell}"><strong>${esc(r.name)}</strong><br><span style="color:#5C6E72;font-size:13px;">${esc(r.date ? r.authority : r.rule)}</span></td>
    </tr>`).join("");

  const box = "background:#F1F8F7;border:1px solid #CFE6E3;border-radius:12px;padding:18px 20px;margin:26px 0;";
  const button = `<p style="margin:16px 0 0;"><a href="${esc(loginUrl)}" style="display:inline-block;background:#278A83;color:#fff;text-decoration:none;font-weight:700;font-size:14px;padding:11px 20px;border-radius:9px;">Sign in to your portal</a></p>`;
  const accountHtml = !account ? "" : account.kind === "new"
    ? `<div style="${box}">
        <div style="font-size:16px;font-weight:700;margin-bottom:6px;">Your portal is ready (optional)</div>
        <p style="font-size:14px;line-height:1.6;margin:0 0 12px;color:#3A4B4F;">Sign in whenever you like to complete your company details, upload documents, message our team and have us file for you.</p>
        <table role="presentation" style="font-size:14px;line-height:1.7;border-collapse:collapse;">
          <tr><td style="color:#5C6E72;padding-right:14px;">Username</td><td><strong>${esc(email)}</strong></td></tr>
          <tr><td style="color:#5C6E72;padding-right:14px;">Password</td><td><strong>${esc(account.password)}</strong> (the phone number you gave us)</td></tr>
        </table>
        ${button}
        <p style="font-size:13px;line-height:1.6;margin:14px 0 0;color:#5C6E72;">You can change the password in the portal at any time. Forgotten it? Choose "Sign in with an email code" on the sign-in page. If you did not ask for this calendar, you can ignore this email.</p>
      </div>`
    : `<div style="${box}">
        <div style="font-size:16px;font-weight:700;margin-bottom:6px;">It's in your portal</div>
        <p style="font-size:14px;line-height:1.6;margin:0;color:#3A4B4F;">You already have a portal with us. Sign in the way you usually do and this calendar will be there.</p>
        ${button}
      </div>`;

  const html = `<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;max-width:640px;margin:0 auto;padding:32px 24px;color:#1B2A2E;">
  <div style="font-size:15px;font-weight:700;color:#34A9A1;margin-bottom:24px;">Compliance Calendar by ${esc(brand)}</div>
  <p style="font-size:15px;line-height:1.6;">Hi ${esc(name || "there")},</p>
  <p style="font-size:15px;line-height:1.6;">Here is the compliance calendar for <strong>${esc(company)}</strong>: ${rows.length} filings, soonest first.</p>
  <table role="presentation" style="width:100%;border-collapse:collapse;border-top:2px solid #278A83;margin-top:18px;">${table}</table>
  ${accountHtml}
  <p style="font-size:13px;line-height:1.6;color:#5C6E72;">Built from official government rules for the answers you gave. Rules change, so our team confirms each date before filing.</p>
  <p style="font-size:13px;line-height:1.6;color:#5C6E72;">${esc(brand)} · ${esc(b.SUPPORT_EMAIL || "")} · ${esc(b.SUPPORT_PHONE || "")}</p>
</div>`;

  return { subject: `Your compliance calendar for ${company}`, text, html };
}

/**
 * Sets up the visitor's account (if they have none) and emails the
 * calendar. Never throws: a calendar that was built is still returned to
 * the page even if the email or the account could not be done.
 * @returns {{ emailed: boolean, accountCreated: boolean }}
 */
async function deliverCalendar(calendar, contact) {
  const email = calendar.leadContact.email;
  const out = { emailed: false, accountCreated: false };
  let account = null;
  try {
    let user = await User.findOne({ email });
    if (!user) {
      user = await createClientAccount({
        email,
        name: contact.name || "",
        companyName: calendar.profile?.companyName || "",
        createdBy: "public-generate",
      });
      // alreadyExisted: someone registered this email a moment ago; theirs
      // is then an existing account and its sign-in is left alone.
      if (!user.alreadyExisted && user.role === "client" && !user.passwordHash && !user.googleId) {
        const password = phonePassword(contact.phone);
        await user.setPassword(password);
        user.initialPassword = true;
        await user.save();
        account = { kind: "new", password };
        out.accountCreated = true;
        logActivity({ action: "client_signed_up", actor: user, clientOrgId: user.clientOrgId, calendarId: calendar._id, summary: `${email} generated a calendar; a portal account was created for them.` });
        await claimCalendars(user, { pendingCalendarId: calendar._id, viaGenerate: true });
      }
    }
    if (!account && user.role === "client" && user.active) account = { kind: "existing" };
  } catch (err) {
    console.error("[lead-delivery] Account setup failed (non-fatal):", err.message);
  }

  out.emailed = (await sendCalendarEmail({ calendar, to: email, name: contact.name, account })) === "sent";
  return out;
}

/**
 * Emails the calendar and says what happened, so the page never claims an
 * email that didn't go: "sent" (the mail provider accepted it), "limit"
 * (this inbox has had its emails for today), "failed", or "slow" (no
 * answer from the mail provider yet). Never throws.
 */
async function sendCalendarEmail({ calendar, to, name, account }) {
  try {
    if (await overLimit("public-calendar-email", to, MAX_EMAILS_PER_DAY, 24 * 60 * 60 * 1000)) {
      console.warn(`[lead-delivery] Not emailed: ${to} has had ${MAX_EMAILS_PER_DAY} calendar emails in the last day.`);
      return "limit";
    }
    const message = buildEmail({ calendar, name, account, to });
    // critical: in production without a mail provider this fails loudly
    // instead of printing the message (which holds the password) to the log.
    const sending = sendEmail({ to, ...message, logPrefix: "[lead-delivery]", critical: true })
      .then((r) => (r && r.skipped ? "failed" : "sent"))
      .catch((err) => { console.error(`[lead-delivery] Calendar email to ${to} FAILED:`, err.message); return "failed"; });
    let timer;
    const result = await Promise.race([sending, new Promise((resolve) => { timer = setTimeout(() => resolve("slow"), SEND_WAIT_MS); })]);
    clearTimeout(timer);
    if (result === "sent") console.log(`[lead-delivery] Calendar emailed to ${to}.`);
    if (result === "slow") console.warn(`[lead-delivery] The mail provider hasn't answered after ${SEND_WAIT_MS / 1000}s for ${to}.`);
    return result;
  } catch (err) {
    console.error(`[lead-delivery] Calendar email to ${to} FAILED:`, err.message);
    return "failed";
  }
}

module.exports = { deliverCalendar, sendCalendarEmail, buildEmail, calendarRows, phonePassword, phonePasswordGuesses, MAX_EMAILS_PER_DAY };
