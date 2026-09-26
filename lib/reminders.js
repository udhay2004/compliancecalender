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
//   6. DOCUMENT CHASING: for every service the client asked us to handle
//      where documents are still missing, reminds them automatically —
//      2, 5 and 10 days after they selected it, then weekly, and every
//      3 days once the deadline is within 14 days (at most 8 times).
//      After 3 reminders with no documents the team is told, so someone
//      can phone the client. Staff can pause it per filing, or press
//      "Chase now" (chaseNow below).
//   7. Clients who switched on WhatsApp get the digest there too (one
//      short message a day at most — lib/whatsapp.js).
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

// Document chasing settings (see point 6 above).
const numList = (raw, dflt) => {
  const v = String(raw || "").split(",").map((x) => parseInt(x, 10)).filter((n) => n >= 0);
  return v.length ? v.sort((a, b) => a - b) : dflt;
};
const CHASE = {
  enabled: () => (process.env.DOC_CHASING || "true").toLowerCase() !== "false",
  after: () => numList(process.env.DOC_CHASE_DAYS, [2, 5, 10]),
  repeat: () => Math.max(1, parseInt(process.env.DOC_CHASE_REPEAT_DAYS || "7", 10)),
  max: () => Math.max(1, parseInt(process.env.DOC_CHASE_MAX || "8", 10)),
  urgentWithin: 14, // days before the deadline when chasing speeds up
  urgentEvery: 3,
  minGap: 2, // never two chases for the same filing within 2 days
  tellTeamAfter: 3,
};
// Statuses where we're waiting on the client. If staff moved it on
// ("Under Review"), we don't chase.
const CHASEABLE = new Set(["Not Started", "Awaiting Documents", "Overdue"]);
const CHASE_PREFIX = "docs-chase:";

const isoDay = (d) => D.startOfDay(d).toISOString().slice(0, 10);

// ---------------------------------------------------------------------
// Periods
// ---------------------------------------------------------------------
const CARRY_FIELDS = ["category", "compliance_name", "due_date", "applicable_to", "description", "authority", "source_url", "confidence", "schedule", "assignedTo", "assignedToName"]; // the next period keeps its owner

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

// One checklist calculation per calendar per run, shared by everything below.
function viewCache(calendar) {
  let view = null;
  return (idx) => {
    if (!view) view = require("./calendarView").toView(calendar, { staff: false });
    return view.items[idx];
  };
}

/** Required documents still missing (or rejected) for one filing. */
function missingDocuments(v) {
  if (!v || !Array.isArray(v.checklist)) return [];
  return v.checklist
    .filter((r) => r.state === "missing" || r.state === "rejected")
    .map((r) => (r.state === "rejected" ? `${r.label} (please upload a new copy)` : r.label));
}

/** How many document reminders this filing has had, and when the last was. */
function chaseHistory(item) {
  const dates = (item.remindersSent || [])
    .filter((k) => k.startsWith(CHASE_PREFIX))
    .map((k) => new Date(`${k.slice(CHASE_PREFIX.length)}T00:00:00Z`))
    .filter((d) => !isNaN(d))
    .sort((a, b) => a - b);
  return { count: dates.length, last: dates.length ? dates[dates.length - 1] : null };
}

/** Is a document reminder due today? dueDays = days until the deadline, or null. */
function chaseIsDue(item, today, dueDays) {
  const { count, last } = chaseHistory(item);
  if (count >= CHASE.max()) return false;
  const sinceLast = last ? D.daysBetween(last, today) : Infinity;
  if (sinceLast < CHASE.minGap) return false;
  const sinceSelected = item.selectedAt ? D.daysBetween(item.selectedAt, today) : Infinity;
  if (sinceSelected < 1) return false; // give them a day
  if (dueDays !== null && dueDays <= CHASE.urgentWithin && sinceLast >= CHASE.urgentEvery) return true;
  const after = CHASE.after();
  if (count < after.length) {
    const gap = count === 0 ? 0 : after[count] - after[count - 1];
    return sinceSelected >= after[count] && sinceLast >= gap;
  }
  return sinceLast >= CHASE.repeat();
}

function whatsMissing(item, calendar, viewOf = viewCache(calendar)) {
  const v = viewOf(calendar.items.indexOf(item));
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
 * @returns {{ changed: boolean, client: object[], staff: object[], overdueNew: object[], docsStuck: object[] }}
 */
function processCalendar(calendar, now = new Date()) {
  const today = D.startOfDay(now);
  let changed = D.ensureDueDates(calendar, now) > 0;
  const client = [];
  const staff = [];
  const overdueNew = [];
  const docsStuck = [];
  const viewOf = viewCache(calendar);

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
        client.push({ idx, item, days, due, group: days < 0 ? "overdue" : days <= 7 ? "soon" : "month", missing: whatsMissing(item, calendar, viewOf) });
        changed = true;
      }
    }
    if (days <= 7) staff.push({ idx, item, days, due });
  }

  // Document chasing — every selected, unfinished filing, dated or not.
  if (CHASE.enabled()) {
    for (let idx = 0; idx < count; idx++) {
      const item = calendar.items[idx];
      if (item.isHistory || !item.selectedByClient || item.docChasePaused || !CHASEABLE.has(item.clientStatus)) continue;
      const due = item.dueDateActual ? D.startOfDay(item.dueDateActual) : null;
      const days = due ? D.daysBetween(today, due) : null;
      if (!chaseIsDue(item, today, days)) continue;
      const docs = missingDocuments(viewOf(idx));
      if (!docs.length) continue;
      if (!Array.isArray(item.remindersSent)) item.remindersSent = [];
      item.remindersSent.push(CHASE_PREFIX + isoDay(today));
      changed = true;
      const existing = client.find((e) => e.idx === idx);
      if (existing) existing.docs = docs; // already in today's digest: add the list there
      else client.push({ idx, item, days, due, group: "docs", docs });
      const n = chaseHistory(item).count;
      if (n === CHASE.tellTeamAfter) docsStuck.push({ idx, item, count: n, docs, days, due });
    }
  }
  return { changed, client, staff, overdueNew, docsStuck };
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

const plural = (n, one, many = one + "s") => `${n} ${n === 1 ? one : many}`;
const docsLine = (e) => `• ${e.item.compliance_name}${e.due ? ` (due ${D.fmt(e.due)})` : ""}: ${e.docs.join("; ")}`;

function clientDigest(companyName, entries) {
  const g = (name) => entries.filter((e) => e.group === name);
  const withDocs = entries.filter((e) => e.docs && e.docs.length);
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
  if (withDocs.length) {
    sections.push(`Documents we still need from you — please upload them in your portal so we can file on time:\n${withDocs.map(docsLine).join("\n")}`);
  }
  const dated = entries.filter((e) => e.group !== "docs");
  const urgent = g("overdue").length ? "overdue" : g("soon").length ? "due this week" : "coming up";
  const n = dated.length;
  let title;
  if (g("overdue").length) title = `${g("overdue").length} filing${g("overdue").length === 1 ? " is" : "s are"} overdue for ${companyName}`;
  else if (n) title = `${n} filing${n === 1 ? "" : "s"} ${urgent} for ${companyName}`;
  else title = `Documents needed for ${plural(withDocs.length, "filing")} — ${companyName}`;
  return { title, body: sections.join("\n\n"), onlyDocs: n === 0 && withDocs.length > 0 };
}

/** The one WhatsApp message for today's digest, or false for none. */
function whatsappDigest(companyName, entries) {
  const count = (name) => entries.filter((e) => e.group === name).length;
  const docs = entries.filter((e) => e.docs && e.docs.length);
  const parts = [];
  if (count("overdue")) parts.push(`${plural(count("overdue"), "filing")} overdue`);
  if (count("soon")) parts.push(`${plural(count("soon"), "filing")} due within 7 days`);
  if (count("month")) parts.push(`${plural(count("month"), "filing")} due this month`);
  if (parts.length) {
    if (docs.length) parts.push(`documents needed for ${plural(docs.length, "filing")}`);
    return { kind: "deadline", params: [companyName, parts.join(", ")] };
  }
  if (docs.length) return chaseWhatsapp(docs[0], docs.length);
  return false; // heads-up only (filings they handle themselves): email + bell is enough
}

function chaseWhatsapp(e, total = 1) {
  const filing = e.item.compliance_name + (total > 1 ? ` and ${total - 1} more` : "");
  const detail = `${plural(e.docs.length, "document")}${e.due ? `, due ${D.fmt(e.due)}` : ""}`;
  return { kind: "documents", params: [filing, detail] };
}

/**
 * "Chase now" from the staff screen: send the client a reminder for one
 * filing's missing documents right away (email + bell + WhatsApp).
 * Returns { ok, error?, docs, sent }.
 */
async function chaseNow(calendar, idx, { now = new Date(), byName = "" } = {}) {
  const item = calendar.items[idx];
  if (!item) return { ok: false, status: 404, error: "Filing not found." };
  if (!item.selectedByClient) return { ok: false, status: 400, error: "The client hasn't asked us to handle this filing." };
  const docs = missingDocuments(viewCache(calendar)(idx));
  if (!docs.length) return { ok: false, status: 400, error: "Nothing to chase: every required document has been uploaded." };
  const today = D.startOfDay(now);
  const { last } = chaseHistory(item);
  if (last && D.daysBetween(last, today) < 1) return { ok: false, status: 429, error: "The client was already reminded about this today." };

  const org = await ClientOrg.findById(calendar.clientOrgId).catch(() => null);
  const company = org?.name || calendar.profile?.companyName || "your company";
  const due = item.dueDateActual ? D.startOfDay(item.dueDateActual) : null;
  const entry = { idx, item, due, docs };
  if (!Array.isArray(item.remindersSent)) item.remindersSent = [];
  item.remindersSent.push(CHASE_PREFIX + isoDay(today));
  await calendar.save();
  const sent = await notifyClient({
    clientOrgId: calendar.clientOrgId,
    calendarId: calendar._id,
    itemIndex: idx,
    type: "documents_requested",
    title: `Documents needed: ${item.compliance_name}`,
    body: `To file "${item.compliance_name}"${due ? ` (due ${D.fmt(due)})` : ""} for ${company}, we still need:\n${docs.map((d) => `• ${d}`).join("\n")}\n\nPlease upload them in your portal.`,
    link: `/portal.html?calendar=${calendar._id}`,
    actorName: byName,
    whatsapp: chaseWhatsapp(entry),
  });
  return { ok: true, docs, sent: sent || { email: false, whatsapp: false }, count: chaseHistory(item).count };
}

// ---------------------------------------------------------------------
// The daily run
// ---------------------------------------------------------------------
/**
 * Current client calendars one at a time (a database cursor), so the daily
 * run uses the same small amount of memory with 50 clients or 50,000.
 */
async function* eachCurrentCalendar() {
  const q = Calendar.find({ status: "approved", clientOrgId: { $ne: null }, supersededAt: null });
  if (q && typeof q.cursor === "function") {
    for await (const c of q.cursor({ batchSize: 100 })) yield c;
  } else {
    for (const c of await q) yield c; // test stand-ins
  }
}

async function runReminderSweep({ now = new Date() } = {}) {
  const teamLines = { overdue: [], soon: [], docs: [] };
  let clientDigests = 0;
  let paymentReminders = 0;
  let calendarCount = 0;

  for await (const calendar of eachCurrentCalendar()) {
    calendarCount++;
    try {
      const { changed, client, staff, overdueNew, docsStuck } = processCalendar(calendar, now);
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
          type: d.onlyDocs ? "documents_requested" : "status_changed",
          title: d.title,
          body: d.body,
          link: `/portal.html?calendar=${calendar._id}`,
          whatsapp: whatsappDigest(company, client),
        });
        clientDigests++;
      }
      (docsStuck || []).forEach((e) =>
        teamLines.docs.push(`• ${company}: ${e.item.compliance_name} — ${e.count} reminders sent, still missing: ${e.docs.join("; ")}${org?.primaryContactPhone ? ` (phone ${org.primaryContactPhone})` : ""}`)
      );
      overdueNew.forEach((e) => teamLines.overdue.push(`• ${company}: ${e.item.compliance_name} — was due ${D.fmt(e.due)}`));
      staff
        .filter((e) => e.days >= 0)
        .forEach((e) => teamLines.soon.push(`• ${company}: ${e.item.compliance_name} — ${D.fmt(e.due)} (${whenText(e.days)}), status ${e.item.clientStatus}`));
      // Still-overdue items appear in the team digest every day until done.
      staff
        .filter((e) => e.days < 0 && !overdueNew.some((o) => o.idx === e.idx))
        .forEach((e) => teamLines.overdue.push(`• ${company}: ${e.item.compliance_name} — ${whenText(e.days)}`));
    } catch (err) {
      // One broken calendar must not stop everyone else's reminders.
      console.error(`[reminders] Calendar ${calendar._id} skipped:`, err.message);
      require("./monitoring").captureError(err, { job: "reminders", calendarId: calendar._id });
    }
  }

  if (teamLines.overdue.length || teamLines.soon.length || teamLines.docs.length) {
    const parts = [];
    if (teamLines.overdue.length) parts.push(`OVERDUE (${teamLines.overdue.length}):\n${teamLines.overdue.join("\n")}`);
    if (teamLines.soon.length) parts.push(`Due within 7 days (${teamLines.soon.length}):\n${teamLines.soon.join("\n")}`);
    if (teamLines.docs.length) parts.push(`Clients not sending documents — worth a phone call (${teamLines.docs.length}):\n${teamLines.docs.join("\n")}`);
    await notifyStaff({
      type: "status_changed",
      title: `Deadlines: ${teamLines.overdue.length} overdue, ${teamLines.soon.length} due this week${teamLines.docs.length ? `, ${teamLines.docs.length} waiting on documents` : ""}`,
      body: parts.join("\n\n"),
      link: "/dashboard.html",
    });
  }

  console.log(`[reminders] Done: ${calendarCount} calendars, ${clientDigests} client digests, ${teamLines.overdue.length} overdue, ${teamLines.soon.length} due this week, ${teamLines.docs.length} newly stuck on documents, ${paymentReminders} payment reminders.`);
  return { calendars: calendarCount, clientDigests, overdue: teamLines.overdue.length, dueSoon: teamLines.soon.length, docsStuck: teamLines.docs.length, paymentReminders };
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

module.exports = {
  runReminderSweep, backfillDueDates, processCalendar, spawnNextOccurrence, onFiled, onUnfiled, clientDigest, stageFor,
  chaseNow, chaseHistory, chaseIsDue, missingDocuments, whatsappDigest, CHASEABLE,
};
