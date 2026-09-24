// tests/deadlines.test.js — real due dates, business days, periods, reminders.
const test = require("node:test");
const assert = require("node:assert");
const D = require("../lib/deadlines");

const day = (s) => new Date(`${s}T00:00:00Z`);
const iso = (d) => d.toISOString().slice(0, 10);
const next = (text, from, profile = {}) => {
  const n = D.nextOccurrence(D.parseDueText(text), profile, day(from));
  return n ? iso(n.date) : null;
};

test("reads the kinds of due-date text the research produces", () => {
  assert.deepStrictEqual(D.parseDueText("1 March (Annually)"), { type: "annual", month: 3, day: 1 });
  assert.deepStrictEqual(D.parseDueText("April 15 (6-month extension available to October 15)"), { type: "annual", month: 4, day: 15 });
  assert.deepStrictEqual(D.parseDueText("15 April (Annually; extension to 15 October with Form 7004)"), { type: "annual", month: 4, day: 15 });
  assert.strictEqual(D.parseDueText("15th day of the 4th month after the end of the tax year").type, "fy_relative");
  assert.strictEqual(D.parseDueText("30 April, 31 July, 31 October and 31 January").dates.length, 4);
  assert.strictEqual(D.parseDueText("Last day of the month following each calendar quarter").type, "multiple");
  assert.strictEqual(D.parseDueText("Annually, on the anniversary of the company's incorporation date").type, "anniversary");
  assert.strictEqual(D.parseDueText("As Triggered").type, "event");
  assert.strictEqual(D.parseDueText("Within 30 days of any change in directors").type, "event");
  assert.deepStrictEqual(D.parseDueText("20th of each month"), { type: "monthly", day: 20 });
  assert.strictEqual(D.parseDueText("Due with the federal return").type, "unknown");
});

test("the AI's structured schedule is used when valid, ignored when not", () => {
  assert.deepStrictEqual(D.validSchedule({ type: "annual", month: 7, day: 15 }), { type: "annual", month: 7, day: 15 });
  assert.strictEqual(D.validSchedule({ type: "annual", month: 13, day: 1 }), null);
  assert.strictEqual(D.validSchedule({ type: "multiple", dates: [{ month: 4, day: 30 }] }), null);
  assert.deepStrictEqual(D.scheduleFor({ schedule: { type: "annual", month: 6, day: 1 }, due_date: "1 March" }), { type: "annual", month: 6, day: 1 });
  assert.deepStrictEqual(D.scheduleFor({ schedule: { type: "nonsense" }, due_date: "1 March" }), { type: "annual", month: 3, day: 1 });
});

test("next date on or after today, rolling to next year", () => {
  assert.strictEqual(next("1 March (Annually)", "2026-09-24"), "2027-03-01");
  assert.strictEqual(next("1 March (Annually)", "2027-03-01"), "2027-03-01", "due today still counts");
  assert.strictEqual(next("30 April, 31 July, 31 October and 31 January", "2026-08-01"), "2026-11-02", "31 Oct 2026 is a Saturday");
  assert.strictEqual(next("20th of each month", "2026-09-24"), "2026-10-20");
});

test("weekends and US federal holidays move the date to the next business day", () => {
  assert.strictEqual(next("15 April", "2028-01-01"), "2028-04-18", "15 Apr 2028 is Saturday and Emancipation Day is observed Mon 17th, so Tue 18th (as in 2017 and 2022)");
  assert.strictEqual(next("15 April", "2029-01-01"), "2029-04-17", "15 Apr 2029 is Sunday; 16 Apr is DC Emancipation Day");
  assert.strictEqual(next("4 July", "2027-01-01"), "2027-07-06", "4 Jul 2027 is Sunday, observed Monday 5th");
  assert.strictEqual(next("31 January", "2026-12-01"), "2027-02-01");
  const n = D.nextOccurrence({ type: "annual", month: 4, day: 15 }, {}, day("2028-01-01"));
  assert.match(n.moved, /weekend/);
  // Non-US filings keep their date.
  const rbi = D.nextOccurrence({ type: "annual", month: 4, day: 15 }, {}, day("2028-01-01"), { businessDays: false });
  assert.strictEqual(iso(rbi.date), "2028-04-15");
  assert.strictEqual(D.usesUsBusinessDays({ category: "Foreign Reporting (ODI/FEMA)" }), false);
});

test("fiscal-year and incorporation-anniversary rules use the company's details", () => {
  const rule = "15th day of the 4th month after the end of the fiscal year";
  assert.strictEqual(next(rule, "2026-09-24", { fyEnd: "Dec" }), "2027-04-15");
  assert.strictEqual(next(rule, "2026-09-24", { fyEnd: "Mar" }), "2027-07-15");
  assert.strictEqual(next(rule, "2026-09-24", { fyEnd: "June" }), "2026-10-15");
  const anniv = "Annually, on the anniversary of the company's incorporation date";
  assert.strictEqual(next(anniv, "2026-09-24", { incorpDate: "2023-11-10" }), "2026-11-10");
  assert.strictEqual(next(anniv, "2026-09-24", { incorpDate: "2024-02-29" }), "2027-03-01", "leap-day company: 28 Feb 2027 is a Sunday → Mon 1 Mar");
  assert.strictEqual(next(anniv, "2026-09-24", {}), null, "no incorporation date → needs a date");
});

test("ensureDueDates fills automatic dates, keeps staff dates, recomputes when text changes", () => {
  const cal = { profile: { fyEnd: "Dec" }, items: [
    { due_date: "1 March (Annually)" },
    { due_date: "1 March (Annually)", dueDateSource: "staff", dueDateActual: day("2027-02-20") },
    { due_date: "As Triggered" },
  ] };
  D.ensureDueDates(cal, day("2026-09-24"));
  assert.strictEqual(iso(cal.items[0].dueDateActual), "2027-03-01");
  assert.strictEqual(cal.items[0].dueDateSource, "auto");
  assert.strictEqual(iso(cal.items[1].dueDateActual), "2027-02-20");
  assert.strictEqual(cal.items[2].dueDateActual, null);
  assert.strictEqual(cal.items[2].recurrence, "event");
  cal.items[0].due_date = "15 April (Annually)";
  D.ensureDueDates(cal, day("2026-09-24"));
  assert.strictEqual(iso(cal.items[0].dueDateActual), "2027-04-15");
});

// ---------------------------------------------------------------------
// Daily routine and periods (lib/reminders.js, no database needed)
// ---------------------------------------------------------------------
const R = require("../lib/reminders");

function cal(items, profile = { fyEnd: "Dec" }) {
  return { profile, items: items.map((it) => ({
    category: "Mandatory Annual", compliance_name: "Delaware Annual Report & Franchise Tax", due_date: "1 March (Annually)",
    clientStatus: "Not Started", paymentStatus: "Not Invoiced", documents: [], paymentEvents: [], remindersSent: [], selectedByClient: false,
    ...it,
  })) };
}

test("each reminder stage is sent once per due date, tightest stage first", () => {
  const c = cal([{ selectedByClient: true, clientStatus: "Awaiting Documents" }]);
  D.ensureDueDates(c, day("2027-01-20"));
  assert.strictEqual(iso(c.items[0].dueDateActual), "2027-03-01");
  let r = R.processCalendar(c, day("2027-01-20")); // 40 days out: nothing yet
  assert.strictEqual(r.client.length, 0);
  r = R.processCalendar(c, day("2027-02-01")); // 28 days
  assert.strictEqual(r.client[0].group, "month");
  r = R.processCalendar(c, day("2027-02-02"));
  assert.strictEqual(r.client.length, 0, "not repeated the next day");
  r = R.processCalendar(c, day("2027-02-25")); // 4 days
  assert.strictEqual(r.client[0].group, "soon");
  assert.ok(r.staff.length === 1, "team digest includes it");
  r = R.processCalendar(c, day("2027-02-28")); // 1 day
  assert.strictEqual(r.client.length, 1);
  assert.deepStrictEqual(c.items[0].remindersSent, ["client-due-30:2027-03-01", "client-due-7:2027-03-01", "client-due-1:2027-03-01"]);
});

test("a missed deadline is marked overdue, reminded weekly, and cleared if the date moves", () => {
  const c = cal([{ selectedByClient: true, clientStatus: "Awaiting Documents" }]);
  D.ensureDueDates(c, day("2027-01-20"));
  let r = R.processCalendar(c, day("2027-03-02"));
  assert.strictEqual(c.items[0].clientStatus, "Overdue");
  assert.strictEqual(r.overdueNew.length, 1);
  assert.strictEqual(r.client[0].group, "overdue");
  r = R.processCalendar(c, day("2027-03-05"));
  assert.strictEqual(r.client.length, 0);
  r = R.processCalendar(c, day("2027-03-09"));
  assert.strictEqual(r.client.length, 1, "one week later");
  // Staff moves the date later → no longer overdue.
  c.items[0].dueDateActual = day("2027-04-30"); c.items[0].dueDateSource = "staff";
  R.processCalendar(c, day("2027-03-10"));
  assert.strictEqual(c.items[0].clientStatus, "Awaiting Documents");
});

test("an unselected filing gets one heads-up, then quietly moves to next year", () => {
  const c = cal([{}]);
  D.ensureDueDates(c, day("2027-01-20"));
  let r = R.processCalendar(c, day("2027-02-10"));
  assert.strictEqual(r.client[0].group, "headsUp");
  r = R.processCalendar(c, day("2027-02-25"));
  assert.strictEqual(r.client.length, 0, "only one heads-up");
  R.processCalendar(c, day("2027-03-02"));
  assert.strictEqual(iso(c.items[0].dueDateActual), "2028-03-01");
  assert.strictEqual(c.items[0].clientStatus, "Not Started", "never marked overdue");
  assert.strictEqual(c.items.length, 1, "no history item for work we weren't doing");
});

test("finishing a recurring filing creates next period with a fresh checklist and list price", () => {
  const c = cal([{ compliance_name: "Registered Agent Renewal", due_date: "Annually, on the anniversary of the company's incorporation date",
    selectedByClient: true, clientStatus: "Filed", paymentStatus: "Paid", feeAmountCents: 12500,
    documents: [{ type: "certificate", fileName: "rcpt.pdf" }] }], { incorpDate: "2024-05-20" });
  D.ensureDueDates(c, day("2027-01-01"));
  const nextDue = R.onFiled(c, 0, day("2027-05-10"));
  assert.strictEqual(iso(nextDue), "2028-05-22", "20 May 2028 is a Saturday");
  assert.strictEqual(c.items.length, 2);
  assert.strictEqual(c.items[0].isHistory, true);
  const n = c.items[1];
  assert.strictEqual(n.selectedByClient, true);
  assert.strictEqual(n.clientStatus, "Awaiting Documents");
  assert.strictEqual(n.documents.length, 0);
  assert.strictEqual(n.feeAmountCents, 12500, "fixed list price applied");
  assert.strictEqual(n.paymentStatus, "Invoiced");
  assert.strictEqual(iso(n.previousDueDate), "2027-05-20");
  assert.strictEqual(R.onFiled(c, 0), null, "never creates a second next period");
  // Un-doing "done" brings the old period back to the active list.
  R.onUnfiled(c, 0);
  assert.strictEqual(c.items[0].isHistory, false);
});

test("event-based filings don't repeat", () => {
  const c = cal([{ compliance_name: "Change of Registered Agent", due_date: "As Triggered", clientStatus: "Filed", selectedByClient: true }]);
  D.ensureDueDates(c, day("2027-01-01"));
  assert.strictEqual(R.onFiled(c, 0), null);
  assert.strictEqual(c.items.length, 1);
});

test("the client digest groups by urgency in plain words", () => {
  const d = R.clientDigest("Acme Inc", [
    { item: { compliance_name: "Form 1120" }, due: day("2027-04-15"), days: -2, group: "overdue", missing: "1 document still to upload" },
    { item: { compliance_name: "Form 941" }, due: day("2027-04-30"), days: 5, group: "soon" },
    { item: { compliance_name: "Form 940" }, due: day("2027-02-01"), days: 20, group: "headsUp" },
  ]);
  assert.match(d.title, /1 filing is overdue for Acme Inc/);
  assert.match(d.body, /OVERDUE[\s\S]*Form 1120: 15 Apr 2027 \(2 days overdue\) — 1 document still to upload/);
  assert.match(d.body, /Due within 7 days:\n• Form 941/);
  assert.match(d.body, /haven't asked us to handle[\s\S]*Form 940/);
});

test("corporate estimated tax follows the 4th/6th/9th/12th-month rule of the tax year", () => {
  const t = "15 April (Quarterly estimated tax, Form 1120-W)";
  assert.strictEqual(D.parseDueText(t).type, "estimated_tax");
  // Calendar-year company: 15 Apr, 15 Jun, 15 Sep, 15 Dec.
  assert.strictEqual(next(t, "2026-09-24", { fyEnd: "Dec" }), "2026-12-15");
  assert.strictEqual(next(t, "2026-12-16", { fyEnd: "Dec" }), "2027-04-15");
  assert.strictEqual(next(t, "2027-04-16", { fyEnd: "Dec" }), "2027-06-15");
  // April–March year: 15 Jul, 15 Sep, 15 Dec, 15 Mar.
  assert.strictEqual(next(t, "2026-09-24", { fyEnd: "Mar" }), "2026-12-15");
  assert.strictEqual(next(t, "2026-12-16", { fyEnd: "Mar" }), "2027-03-15");
  assert.strictEqual(next(t, "2027-03-16", { fyEnd: "Mar" }), "2027-07-15");
});

test("a single example date with a frequency word repeats at that frequency", () => {
  assert.strictEqual(next("30 April (Quarterly)", "2026-08-01"), "2026-11-02", "31 Oct is last-of-month, a Saturday");
  assert.strictEqual(next("30 April (Quarterly)", "2026-05-01"), "2026-07-31");
  assert.strictEqual(D.recurrenceLabel(D.parseDueText("30 April (Quarterly)")), "every quarter");
  assert.strictEqual(next("20 September (Monthly)", "2026-09-24"), "2026-10-20");
  assert.strictEqual(D.recurrenceLabel(D.parseDueText("31 March (Semi-annually)")), "twice a year");
});
