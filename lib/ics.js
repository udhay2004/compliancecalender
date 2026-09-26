// lib/ics.js
//
// Calendar export in the standard iCalendar (.ics) format, which Google
// Calendar, Outlook and Apple Calendar all understand.
//
// Two ways it's used:
//   - a one-off download (portal "Download .ics", staff calendar page)
//   - a SUBSCRIPTION link (/feeds/<token>.ics). The client pastes it into
//     Google/Outlook once, and their calendar app re-reads it every few
//     hours, so new dates, rolled-over periods and status changes show up
//     by themselves.
//
// Every deadline is an all-day event on its due date. Filings we're
// handling get alerts 7 days and 1 day before (Outlook/Apple show these;
// Google ignores alerts in subscribed calendars and uses the user's own
// default instead).

const crypto = require("crypto");
const D = require("./deadlines");

const PRODID = "-//ComplyGlobally//Compliance Calendar//EN";

// RFC 5545 text escaping.
function esc(value) {
  return String(value == null ? "" : value)
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r?\n/g, "\\n");
}

// Lines longer than 75 bytes are folded (continuation lines start with a
// space). Splits on character boundaries so UTF-8 is never cut in half.
function fold(line) {
  const out = [];
  let current = "";
  let bytes = 0;
  for (const ch of line) {
    const b = Buffer.byteLength(ch);
    const limit = out.length === 0 ? 75 : 74; // continuation lines lose 1 byte to the leading space
    if (bytes + b > limit) {
      out.push(current);
      current = "";
      bytes = 0;
    }
    current += ch;
    bytes += b;
  }
  out.push(current);
  return out.join("\r\n ");
}

const ymd = (date) => D.startOfDay(date).toISOString().slice(0, 10).replace(/-/g, "");
const stamp = (date) => new Date(date).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");

/**
 * @param {{ name: string, description?: string, events: Array<{
 *   uid: string, date: Date, summary: string, description?: string, url?: string,
 *   alarms?: number[], done?: boolean, updated?: Date }> }} cal
 */
function buildIcs({ name, description = "", events }, now = new Date()) {
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    `PRODID:${PRODID}`,
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    `X-WR-CALNAME:${esc(name)}`,
    description ? `X-WR-CALDESC:${esc(description)}` : null,
    "REFRESH-INTERVAL;VALUE=DURATION:PT6H",
    "X-PUBLISHED-TTL:PT6H",
  ].filter(Boolean);

  for (const ev of events) {
    lines.push(
      "BEGIN:VEVENT",
      `UID:${ev.uid}`,
      `DTSTAMP:${stamp(now)}`,
      ev.updated ? `LAST-MODIFIED:${stamp(ev.updated)}` : null,
      `DTSTART;VALUE=DATE:${ymd(ev.date)}`,
      `DTEND;VALUE=DATE:${ymd(D.addDays(ev.date, 1))}`,
      `SUMMARY:${esc(ev.summary)}`,
      ev.description ? `DESCRIPTION:${esc(ev.description)}` : null,
      ev.url ? `URL:${ev.url}` : null,
      "TRANSP:TRANSPARENT", // don't show as "busy"
      "STATUS:CONFIRMED", // done filings stay visible, marked ✓ in the title
    );
    if (!ev.done) {
      (ev.alarms || []).forEach((days) => {
        lines.push(
          "BEGIN:VALARM",
          "ACTION:DISPLAY",
          `DESCRIPTION:${esc(ev.summary)}`,
          `TRIGGER:-P${days}D`,
          "END:VALARM",
        );
      });
    }
    lines.push("END:VEVENT");
  }
  lines.push("END:VCALENDAR");
  return lines.filter((l) => l !== null).map(fold).join("\r\n") + "\r\n";
}

const appUrl = (p) => `${(process.env.APP_URL || "").replace(/\/$/, "")}${p}`;

function statusText(item) {
  if (item.clientStatus === "Filed") return "Done";
  return item.clientStatus || "Not Started";
}

/**
 * Events for one client calendar.
 * audience "client": every dated filing; ones we handle are marked so.
 * audience "staff": only filings the client asked us to handle, prefixed
 *                   with the company name (for the team feed).
 */
function calendarEvents(calendar, { audience = "client", company = "" } = {}) {
  const events = [];
  const items = calendar.items || [];
  const name = company || calendar.profile?.companyName || "";
  items.forEach((item, idx) => {
    if (!item.dueDateActual) return;
    if (audience === "staff" && !item.selectedByClient) return;
    // Past periods: keep them only if they were ours (a record of what was filed).
    if (item.isHistory && !item.selectedByClient) return;
    const done = item.clientStatus === "Filed";
    const ours = Boolean(item.selectedByClient);
    let summary;
    if (audience === "staff") summary = `${name}: ${item.compliance_name}${done ? " ✓" : ""}`;
    else summary = `${item.compliance_name}${done ? " ✓ done" : ours ? "" : " (you file)"}`;

    const desc = [];
    if (audience === "client") {
      desc.push(ours ? "ComplyGlobally is handling this for you." : "You haven't asked ComplyGlobally to handle this one. File it yourself, or add it to your services in the portal.");
    }
    desc.push(`Status: ${statusText(item)}`);
    if (item.due_date) desc.push(`Rule: ${item.due_date}`);
    if (item.dueDateNote) desc.push(item.dueDateNote);
    if (item.authority) desc.push(`Authority: ${item.authority}`);
    if (item.description) desc.push("", item.description);
    const link = audience === "staff" ? `/calendar.html?id=${calendar._id}` : `/portal.html?calendar=${calendar._id}`;
    if (process.env.APP_URL) desc.push("", `Open: ${appUrl(link)}`);

    events.push({
      uid: `${calendar._id}-${idx}@complyglobally`,
      date: item.dueDateActual,
      summary,
      description: desc.join("\n"),
      url: process.env.APP_URL ? appUrl(link) : "",
      alarms: ours ? [7, 1] : [],
      done,
      updated: calendar.updatedAt,
    });
  });
  return events;
}

function sortEvents(events) {
  return events.sort((a, b) => new Date(a.date) - new Date(b.date) || a.summary.localeCompare(b.summary));
}

/** A new secret for a subscription link (40 hex characters). */
const newFeedToken = () => crypto.randomBytes(20).toString("hex");
const isFeedToken = (t) => typeof t === "string" && /^[a-f0-9]{40}$/.test(t);

/** Links for "Add to Google / Outlook / Apple" buttons. */
function subscribeLinks(path, name) {
  const https = appUrl(path);
  const webcal = https.replace(/^https?:\/\//, "webcal://");
  return {
    url: https,
    webcal,
    google: `https://calendar.google.com/calendar/r?cid=${encodeURIComponent(webcal)}`,
    outlook: `https://outlook.live.com/calendar/0/addfromweb?url=${encodeURIComponent(https)}&name=${encodeURIComponent(name)}`,
    office365: `https://outlook.office.com/calendar/0/addfromweb?url=${encodeURIComponent(https)}&name=${encodeURIComponent(name)}`,
  };
}

function sendIcs(res, text, fileName, { download = true } = {}) {
  res.setHeader("Content-Type", "text/calendar; charset=utf-8");
  const safe = String(fileName || "calendar").replace(/[^a-z0-9._-]+/gi, "-").slice(0, 80) || "calendar";
  res.setHeader("Content-Disposition", `${download ? "attachment" : "inline"}; filename="${safe}.ics"`);
  res.setHeader("Cache-Control", "private, max-age=900");
  res.send(text);
}

module.exports = { buildIcs, calendarEvents, sortEvents, newFeedToken, isFeedToken, subscribeLinks, sendIcs, esc, fold };
