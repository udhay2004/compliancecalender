// lib/reminders.js
//
// The daily deadline routine (scheduled in server.js, 8am server time by
// default). For every current client calendar it:
//
//   1. Fills in real due dates (lib/deadlines.js) where missing.
//   2. Handles dates that have passed:
//        - selected by the client, not done  -> status "Overdue", team alerted
//        - done ("Filed")                    -> next period created (safety net;
//                                               normally created the moment
//                                               proof is uploaded)
//        - not selected by the client        -> date moves to the next period
//   3. Sends each client ONE digest (email + bell) listing what's newly
//      overdue / due within 7 days / due within 30 days, plus a one-time
//      heads-up for filings they haven't asked us to handle.
//   4. Sends the team ONE digest: overdue work and work due within 7 days.
//   5. Keeps the existing payment-overdue reminders.
//
// Every reminder is keyed by filing + due date + stage in `remindersSent`,
// so it goes out exactly once, however often the routine runs.

const Calendar = require("../models/Calendar");
const ClientOrg = require("../models/ClientOrg");
const { sendEmail } = require("./mailer");
const { notifyStaff, notifyClient } = require("./notify");
const D = require("./deadlines");
const { applyListPrice, formatUSD } = require("./complianceFees");

const REMIND_UNSELECTED = (process.env.REMIND_UNSELECTED || "true").toLowerCase() !== "false";
const PAYMENT_REMINDER_EVERY_DAYS = parseInt(process.env.REMINDER_COOLDOWN_DAYS || "7", 10);

const isoDay = (d) => D.startOfDay(d).toISOString().slice(0, 10);

// ---------------------------------------------------------------------
// Periods
// ---------------------------------------------------------------------
const CARRY_FIELDS = ["category", "compliance_name", "due_date", "applicable_to", "description", "authority", "source_url", "confidence", "schedule"];

/**
 * Create the next period of a recurring filing as a new item and move this
 * one to history. Returns the new item's index, or null if the filing
 * doesn't repeat (event-based / unknown schedule) or was already rolled.
 */
function spawnNextOccurrence(calendar, idx, now = new Date()) {
  const item = calendar.items[idx];
  if (!item || item.nextOccurrenceSpawned) return null;
  const schedule = D.scheduleFor(item);
  if (!["annual", "multiple", "monthly"].includes(D.recurrenceOf(schedule))) return null;

  const after = item.dueDateActual ? D.addDays(item.dueDateActual, 1) : D.startOfDay(now);
  const next = D.nextOccurrence(schedule, calendar.profile || {}, after, { businessDays: D.usesUsBusinessDays(item) });
  if (!next) return null;

  const fresh = {};
  CARRY_FIELDS.forEach((f) => { if (item[f] !== undefined) fresh[f] = item[f]; });
  Object.assign(fresh, {
    selectedByClient: Boolean(item.selectedByClient),
    selectedAt: item.selectedByClient ? now : null,
    clientStatus: item.selectedByClient ? "Awaiting Documents" : "Not Started",
    paymentStatus: "Not Invoiced",
    feeAmountCents: null,
    documents: [],
    paymentEvents: [],
    remindersSent: [],
    recurrence: D.recurrenceOf(schedule),
    dueDateActual: next.date,
    dueDateNote: next.moved ? `Moved to the next business day: ${next.moved}.` : "",
    dueDateSource: "auto",
    dueDateParsedFrom: item.due_date || "",
    previousDueDate: item.dueDateActual || null,
  });
  if (fresh.selectedByClient) applyListPrice(fresh);

  item.isHistory = true;
  item.nextOccurrenceSpawned = true;
  calendar.items.push(fresh);
  return calendar.items.length - 1;
}

/**
 * Call when a filing becomes "Filed" (proof uploaded or status changed).
 * Returns the next period's due date, if one was created.
 */
function onFiled(calendar, idx, now = new Date()) {
  const newIdx = spawnNextOccurrence(calendar, idx, now);
  return newIdx === null ? null : calendar.items[newIdx].dueDateActual;
}

/** Call when a filing stops being "Filed" (proof removed / status changed back). */
function onUnfiled(calendar, idx) {
  const item = calendar.items[idx];
  if (item && item.isHistory) item.isHistory = false; // back in the active list
}

// ---------------------------------------------------------------------
// Daily processing of one calendar (no I/O — returns what to send)
// ---------------------------------------------------------------------
function stageFor(days) {
  if (days < 0) return `overdue-${Math.min(Math.floor(-days / 7), 2)}`; // day after, +1 week, +2 weeks
  if (days <= 1) return "due-1";
  if (days <= 7) return "due-7";
  if (days <= 30) return "due-30";
  return null;
}

function whatsMissing(item, calendar) {
  const { toView } = require("./calendarView");
  // Cheap enough: one calendar's checklist.
  const view = toView(calendar, { staff: false });
  const v = view.items[calendar.items.indexOf(item)];
  const bits = [];
  if (v && v.checklistSummary && !v.checklistSummary.allProvided) {
    const missing = v.checklistSummary.total - v.checklistSummary.provided;
    bits.push(`${missing} document${missing === 1 ? "" : "s"} still to upload`);
  }
  if (item.paymentStatus === "Invoiced" || item.paymentStatus === "Overdue") bits.push(`payment of ${formatUSD(item.feeAmountCents || 0)} pending`);
  if (!bits.length && item.clientStatus !== "Filed") bits.push("we're working on it");
  return bits.join(", ");
}

/**
 * @returns {{ changed: boolean, client: object[], staff: object[], overdueNew: object[] }}
 */
function processCalendar(calendar, now = new Date()) {
  const today = D.startOfDay(now);
  let changed = D.ensureDueDates(calendar, now) > 0;
  const client = [];
  const staff = [];
  const overdueNew = [];

  const count = calendar.items.length; // spawned items are handled on the next run
  for (let idx = 0; idx < count; idx++) {
    const item = calendar.items[idx];
    if (item.isHistory || !item.dueDateActual) continue;
    const due = D.startOfDay(item.dueDateActual);
    const days = D.daysBetween(today, due);
    const dueKey = isoDay(due);
    const filed = item.clientStatus === "Filed";

    if (filed) {
      if (!item.nextOccurrenceSpawned && days < 0 && spawnNextOccurrence(calendar, idx, now) !== null) changed = true;
      continue;
    }

    if (!item.selectedByClient) {
      if (days < 0) {
        // Nobody is handling it here; keep the calendar current.
        const next = D.nextOccurrence(D.scheduleFor(item), calendar.profile || {}, D.addDays(due, 1), { businessDays: D.usesUsBusinessDays(item) });
        if (next && item.dueDateSource !== "staff") {
          item.previousDueDate = item.dueDateActual;
          item.dueDateActual = next.date;
          item.dueDateNote = next.moved ? `Moved to the next business day: ${next.moved}.` : "";
          item.remindersSent = [];
          changed = true;
        }
        continue;
      }
      if (REMIND_UNSELECTED && days <= 30) {
        const key = `client-heads-up:${dueKey}`;
        if (!item.remindersSent.includes(key)) {
          item.remindersSent.push(key);
          client.push({ idx, item, days, due, group: "headsUp" });
          changed = true;
        }
      }
      continue;
    }

    // Selected by the client and not done yet.
    if (days >= 0 && item.clientStatus === "Overdue") {
      // The date was moved later (e.g. staff set a new date): no longer overdue.
      item.clientStatus = "Awaiting Documents";
      changed = true;
    }
    if (days < 0 && item.clientStatus !== "Overdue") {
      item.clientStatus = "Overdue";
      overdueNew.push({ idx, item, days, due });
      changed = true;
    }
    const stage = stageFor(days);
    if (stage) {
      const key = `client-${stage}:${dueKey}`;
      if (!item.remindersSent.includes(key)) {
        item.remindersSent.push(key);
        client.push({ idx, item, days, due, group: days < 0 ? "overdue" : days <= 7 ? "soon" : "month", missing: whatsMissing(item, calendar) });
        changed = true;
      }
    }
    if (days <= 7) staff.push({ idx, item, days, due });
  }
  return { changed, client, staff, overdueNew };
}

// ---------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------
function whenText(days) {
  if (days < 0) return `${-days} day${days === -1 ? "" : "s"} overdue`;
  if (days === 0) return "due today";
  if (days === 1) return "due tomorrow";
  return `due in ${days} days`;
}

function clientDigest(companyName, entries) {
  const g = (name) => entries.filter((e) => e.group === name);
  const line = (e) => `• ${e.item.compliance_name}: ${D.fmt(e.due)} (${whenText(e.days)})${e.missing ? ` — ${e.missing}` : ""}`;
  const sections = [];
  if (g("overdue").length) sections.push(`OVERDUE — please act now:\n${g("overdue").map(line).join("\n")}`);
  if (g("soon").length) sections.push(`Due within 7 days:\n${g("soon").map(line).join("\n")}`);
  if (g("month").length) sections.push(`Coming up this month:\n${g("month").map(line).join("\n")}`);
  if (g("headsUp").length) {
    sections.push(
      `Also due soon (you haven't asked us to handle these — file them yourself, or add them to your services in the portal and we'll take care of it):\n` +
      g("headsUp").map((e) => `• ${e.item.compliance_name}: ${D.fmt(e.due)} (${whenText(e.days)})`).join("\n")
    );
  }
  const urgent = g("overdue").length ? "overdue" : g("soon").length ? "due this week" : "coming up";
  const n = entries.length;
  return {
    title: g("overdue").length
      ? `${g("overdue").length} filing${g("overdue").length === 1 ? " is" : "s are"} overdue for ${companyName}`
      : `${n} filing${n === 1 ? "" : "s"} ${urgent} for ${companyName}`,
    body: sections.join("\n\n"),
  };
}

// ---------------------------------------------------------------------
// The daily run
// ---------------------------------------------------------------------
async function runReminderSweep({ now = new Date() } = {}) {
  const calendars = await Calendar.find({ status: "approved", clientOrgId: { $ne: null }, supersededAt: null });
  const teamLines = { overdue: [], soon: [] };
  let clientDigests = 0;
  let paymentReminders = 0;

  for (const calendar of calendars) {
    const { changed, client, staff, overdueNew } = processCalendar(calendar, now);
    const org = await ClientOrg.findById(calendar.clientOrgId).catch(() => null);
    const company = org?.name || calendar.profile?.companyName || "your company";

    // Payment reminders (unchanged behaviour), at most once a week per item.
    let payChanged = false;
    for (const item of calendar.items) {
      if (item.paymentStatus !== "Overdue" || !org?.primaryContactEmail) continue;
      const last = item.lastReminderSentAt ? new Date(item.lastReminderSentAt).getTime() : 0;
      if (Date.now() - last < PAYMENT_REMINDER_EVERY_DAYS * 86400000) continue;
      await sendEmail({
        to: org.primaryContactEmail,
        subject: `Payment overdue: ${item.compliance_name} — ${company}`,
        text: `This is a reminder that payment for "${item.compliance_name}" is overdue.\n\nPlease log in to the ComplyGlobally client portal to settle it: ${process.env.APP_URL || ""}/portal.html`,
        logPrefix: "[reminders]",
      });
      item.lastReminderSentAt = new Date();
      payChanged = true;
      paymentReminders++;
    }

    if (changed || payChanged) await calendar.save();

    if (client.length) {
      const d = clientDigest(company, client);
      await notifyClient({
        clientOrgId: calendar.clientOrgId,
        calendarId: calendar._id,
        type: "status_changed",
        title: d.title,
        body: d.body,
        link: `/portal.html?calendar=${calendar._id}`,
      });
      clientDigests++;
    }
    overdueNew.forEach((e) => teamLines.overdue.push(`• ${company}: ${e.item.compliance_name} — was due ${D.fmt(e.due)}`));
    staff
      .filter((e) => e.days >= 0)
      .forEach((e) => teamLines.soon.push(`• ${company}: ${e.item.compliance_name} — ${D.fmt(e.due)} (${whenText(e.days)}), status ${e.item.clientStatus}`));
    // Still-overdue items appear in the team digest every day until done.
    staff
      .filter((e) => e.days < 0 && !overdueNew.some((o) => o.idx === e.idx))
      .forEach((e) => teamLines.overdue.push(`• ${company}: ${e.item.compliance_name} — ${whenText(e.days)}`));
  }

  if (teamLines.overdue.length || teamLines.soon.length) {
    const parts = [];
    if (teamLines.overdue.length) parts.push(`OVERDUE (${teamLines.overdue.length}):\n${teamLines.overdue.join("\n")}`);
    if (teamLines.soon.length) parts.push(`Due within 7 days (${teamLines.soon.length}):\n${teamLines.soon.join("\n")}`);
    await notifyStaff({
      type: "status_changed",
      title: `Deadlines: ${teamLines.overdue.length} overdue, ${teamLines.soon.length} due this week`,
      body: parts.join("\n\n"),
      link: "/dashboard.html",
    });
  }

  console.log(`[reminders] Done: ${calendars.length} calendars, ${clientDigests} client digests, ${teamLines.overdue.length} overdue, ${teamLines.soon.length} due this week, ${paymentReminders} payment reminders.`);
  return { calendars: calendars.length, clientDigests, overdue: teamLines.overdue.length, dueSoon: teamLines.soon.length, paymentReminders };
}

/** Fill in due dates on existing calendars once, at startup (no reminders sent). */
async function backfillDueDates() {
  const calendars = await Calendar.find({ status: { $in: ["approved", "pending_review"] }, supersededAt: null });
  let updated = 0;
  for (const c of calendars) {
    if (D.ensureDueDates(c) > 0) { await c.save(); updated++; }
  }
  if (updated) console.log(`[deadlines] Calculated due dates for ${updated} existing calendar(s).`);
  return updated;
}

module.exports = { runReminderSweep, backfillDueDates, processCalendar, spawnNextOccurrence, onFiled, onUnfiled, clientDigest, stageFor };
