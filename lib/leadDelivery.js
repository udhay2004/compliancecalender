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

/**
 * Is what was typed the phone number we hold (digits only)? People type
 * their number with or without the country code or a leading 0, so a
 * national number matches the full international one and the other way
 * round, as long as at most a country code's worth of digits differs.
 */
function samePhone(typed, storedDigits) {
  const raw = String(typed || "").trim();
  const stored = String(storedDigits || "").replace(/\D/g, "");
  if (!stored || !/^\+?[\d\s().-]{7,25}$/.test(raw)) return false;
  const digits = raw.replace(/\D/g, "");
  const strip = (d) => d.replace(/^0+/, "");
  const a = strip(digits);
  const b = strip(stored);
  if (a.length < 7) return false;
  if (a === b) return true;
  const [longer, shorter] = a.length >= b.length ? [a, b] : [b, a];
  return longer.endsWith(shorter) && longer.length - shorter.length <= 4;
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

  // Why the portal is worth opening: the same points in the text and HTML
  // versions.
  const BENEFITS = [
    "Your calendar, always up to date, with reminders before each deadline",
    "Choose the filings you want us to handle, with the price shown up front",
    "Upload documents and pay securely online, in a few minutes",
    "Message our compliance team directly and follow each filing to completion",
  ];
  const pitch = "You don't have to track or file any of this yourself. Our compliance team can take every one of these deadlines off your plate, and we'll be with you at each step.";
  const forgot = `Forgotten your password? Choose "Sign in with an email code" on the sign-in page.`;

  const accountText = !account ? "" : account.kind === "new"
    ? `LET US HANDLE THIS FOR YOU: YOUR PORTAL IS READY\n${pitch}\n\nSign in to your portal to get:\n${BENEFITS.map((x) => `  * ${x}`).join("\n")}\n\nHow to sign in:\n  Go to: ${loginUrl}\n  Username: ${email}\n  Password: ${account.password} (the phone number you gave us)\n\nYour calendar is already there. Signing in is optional and free; you only pay for the filings you ask us to do.\nYou can change the password in the portal at any time. ${forgot}\nIf you did not ask for this calendar, you can ignore this email.\n\n`
    : `LET US HANDLE THIS FOR YOU\n${pitch}\n\nIn your portal you get:\n${BENEFITS.map((x) => `  * ${x}`).join("\n")}\n\nYou already have a portal with us. Sign in the way you usually do and this calendar will be there: ${loginUrl}\n${forgot}\n\n`;

  const text =
    `Hi ${name || "there"},\n\nHere is the compliance calendar for ${company}: ${rows.length} filings, soonest first.\n\n` +
    rows.map((r) => `- ${r.date ? fmt(r.date) : "Date to be confirmed"}: ${r.name}${r.authority ? ` (${r.authority})` : ""}${r.date ? "" : ` — ${r.rule}`}`).join("\n") +
    `\n\n${accountText}Built from official government rules for the answers you gave. Rules change, so our team confirms each date before filing.\n\n${brand}\n${b.SUPPORT_EMAIL || ""} ${b.SUPPORT_PHONE || ""}`.trimEnd();

  const cell = "padding:10px 12px;border-bottom:1px solid #E4ECEB;font-size:14px;line-height:1.45;vertical-align:top;";
  const table = rows.map((r) => `<tr>
      <td style="${cell}white-space:nowrap;font-weight:700;color:${r.date ? "#1B2A2E" : "#8A9A9D"};">${r.date ? fmt(r.date) : "To be confirmed"}</td>
      <td style="${cell}"><strong>${esc(r.name)}</strong><br><span style="color:#5C6E72;font-size:13px;">${esc(r.date ? r.authority : r.rule)}</span></td>
    </tr>`).join("");

  const box = "background:#F1F8F7;border:1px solid #CFE6E3;border-radius:12px;padding:20px 22px;margin:26px 0;";
  const small = "font-size:13px;line-height:1.6;margin:14px 0 0;color:#5C6E72;";
  const button = `<p style="margin:18px 0 0;"><a href="${esc(loginUrl)}" style="display:inline-block;background:#278A83;color:#fff;text-decoration:none;font-weight:700;font-size:15px;padding:12px 22px;border-radius:9px;">Sign in to your portal</a></p>`;
  const benefits = `<ul style="font-size:14px;line-height:1.6;margin:0 0 14px;padding-left:20px;color:#1B2A2E;">${BENEFITS.map((x) => `<li style="margin-bottom:4px;">${esc(x)}</li>`).join("")}</ul>`;
  const pitchHtml = `<p style="font-size:14px;line-height:1.6;margin:0 0 12px;color:#3A4B4F;">${esc(pitch)}</p>`;
  const accountHtml = !account ? "" : account.kind === "new"
    ? `<div style="${box}">
        <div style="font-size:17px;font-weight:700;margin-bottom:8px;">Let us handle this for you: your portal is ready</div>
        ${pitchHtml}
        ${benefits}
        <div style="background:#fff;border:1px solid #CFE6E3;border-radius:10px;padding:14px 16px;">
          <div style="font-size:13px;font-weight:700;color:#5C6E72;margin-bottom:6px;">How to sign in</div>
          <table role="presentation" style="font-size:14px;line-height:1.7;border-collapse:collapse;">
            <tr><td style="color:#5C6E72;padding-right:14px;">Username</td><td><strong>${esc(email)}</strong></td></tr>
            <tr><td style="color:#5C6E72;padding-right:14px;">Password</td><td><strong>${esc(account.password)}</strong> (the phone number you gave us)</td></tr>
          </table>
        </div>
        ${button}
        <p style="${small}">Your calendar is already there. Signing in is optional and free; you only pay for the filings you ask us to do. You can change the password in the portal at any time. ${esc(forgot)} If you did not ask for this calendar, you can ignore this email.</p>
      </div>`
    : `<div style="${box}">
        <div style="font-size:17px;font-weight:700;margin-bottom:8px;">Let us handle this for you</div>
        ${pitchHtml}
        ${benefits}
        <p style="font-size:14px;line-height:1.6;margin:0;color:#3A4B4F;">You already have a portal with us. Sign in the way you usually do and this calendar will be there.</p>
        ${button}
        <p style="${small}">${esc(forgot)}</p>
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
        user.initialPhone = password.replace(/\D/g, "");
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

module.exports = { deliverCalendar, sendCalendarEmail, buildEmail, samePhone, calendarRows, phonePassword, phonePasswordGuesses, MAX_EMAILS_PER_DAY };
