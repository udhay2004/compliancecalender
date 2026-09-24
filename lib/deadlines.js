// lib/deadlines.js
//
// Turns a filing's due-date description into REAL calendar dates.
//
// The AI research produces human text like:
//   "1 March (Annually)"
//   "15th day of 4th month after FY end (15 July for this company)"
//   "30 April, 31 July, 31 October and 31 January"
//   "Annually, on the anniversary of the company's incorporation date"
//   "As Triggered"
// Before this file, only dates a staff member typed in by hand were real
// dates, so most reminders never fired and nothing rolled over to next year.
//
// Two layers:
//   1. A SCHEDULE — the repeating rule, e.g. { type: "annual", month: 4, day: 15 }.
//      Taken from the AI's structured `schedule` field when it's valid
//      (new calendars), otherwise parsed from the due-date text (existing
//      calendars, cached items).
//   2. nextOccurrence() — the next actual date on or after a given day,
//      moved to the next business day when it falls on a weekend or US
//      federal holiday (the IRS/state rule), except for non-US filings.
//
// All dates are handled as UTC midnight "calendar days" so server time
// zone never shifts a deadline by a day.

const MONTHS = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4, may: 5,
  jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9, september: 9,
  oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12,
};
const MONTH_NAMES = ["", "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MONTH_RE = "(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)";
const DAY_MS = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------
// Day helpers (UTC calendar days)
// ---------------------------------------------------------------------
const utc = (y, m, d) => new Date(Date.UTC(y, m - 1, d));
const lastDayOf = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();
function clampDay(y, m, d) {
  return utc(y, m, d === "last" ? lastDayOf(y, m) : Math.min(d, lastDayOf(y, m)));
}
function startOfDay(date) {
  const d = new Date(date);
  return utc(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
}
const addDays = (date, n) => new Date(startOfDay(date).getTime() + n * DAY_MS);
function daysBetween(from, to) {
  return Math.round((startOfDay(to) - startOfDay(from)) / DAY_MS);
}
function addMonths(y, m, n) {
  const idx = y * 12 + (m - 1) + n;
  return { y: Math.floor(idx / 12), m: (idx % 12) + 1 };
}

// ---------------------------------------------------------------------
// US federal holidays (with Saturday→Friday / Sunday→Monday observance)
// plus DC Emancipation Day, which moves IRS deadlines too.
// ---------------------------------------------------------------------
function nthWeekday(y, m, weekday, n) {
  const first = utc(y, m, 1).getUTCDay();
  return utc(y, m, 1 + ((weekday - first + 7) % 7) + (n - 1) * 7);
}
function lastWeekday(y, m, weekday) {
  const last = utc(y, m, lastDayOf(y, m));
  return addDays(last, -((last.getUTCDay() - weekday + 7) % 7));
}
function observed(date) {
  const wd = date.getUTCDay();
  return wd === 6 ? addDays(date, -1) : wd === 0 ? addDays(date, 1) : date;
}
const holidayCache = new Map();
function usHolidays(y) {
  if (holidayCache.has(y)) return holidayCache.get(y);
  const days = [
    observed(utc(y, 1, 1)), nthWeekday(y, 1, 1, 3), nthWeekday(y, 2, 1, 3), observed(utc(y, 4, 16)),
    lastWeekday(y, 5, 1), observed(utc(y, 6, 19)), observed(utc(y, 7, 4)), nthWeekday(y, 9, 1, 1),
    nthWeekday(y, 10, 1, 2), observed(utc(y, 11, 11)), nthWeekday(y, 11, 4, 4), observed(utc(y, 12, 25)),
    observed(utc(y + 1, 1, 1)), // next New Year observed on 31 Dec
  ];
  const set = new Set(days.map((d) => d.getTime()));
  holidayCache.set(y, set);
  return set;
}
function isBusinessDay(date) {
  const wd = date.getUTCDay();
  return wd !== 0 && wd !== 6 && !usHolidays(date.getUTCFullYear()).has(date.getTime());
}
/** Next business day on or after `date`, plus why it moved (or null). */
function toBusinessDay(date) {
  let d = startOfDay(date);
  const original = d;
  while (!isBusinessDay(d)) d = addDays(d, 1);
  if (d.getTime() === original.getTime()) return { date: d, moved: null };
  const why = original.getUTCDay() === 6 || original.getUTCDay() === 0 ? "weekend" : "US federal holiday";
  return { date: d, moved: `${fmt(original)} falls on a ${why}` };
}

function fmt(date) {
  const d = new Date(date);
  return `${d.getUTCDate()} ${MONTH_NAMES[d.getUTCMonth() + 1]} ${d.getUTCFullYear()}`;
}

// ---------------------------------------------------------------------
// Schedules
// ---------------------------------------------------------------------
//   { type: "annual", month, day }             day may be "last"
//   { type: "multiple", dates: [{month, day}] } several fixed dates a year
//   { type: "monthly", day }
//   { type: "fy_relative", monthsAfter, day }  Nth day of Mth month after FY end
//   { type: "anniversary" }                     incorporation anniversary
//   { type: "event" }                           only when something happens
//   { type: "unknown" }                         staff must set a date
const isDay = (d) => d === "last" || (Number.isInteger(d) && d >= 1 && d <= 31);
const isMonth = (m) => Number.isInteger(m) && m >= 1 && m <= 12;

/** Accepts the AI's structured schedule only if it's well-formed. */
function validSchedule(s) {
  if (!s || typeof s !== "object") return null;
  const type = String(s.type || "").toLowerCase();
  const num = (v) => (v === "last" ? "last" : Number(v));
  if (type === "annual" && isMonth(num(s.month)) && isDay(num(s.day))) return { type, month: num(s.month), day: num(s.day) };
  if (type === "monthly" && isDay(num(s.day))) return { type, day: num(s.day) };
  if ((type === "multiple" || type === "quarterly") && Array.isArray(s.dates) && s.dates.length >= 2 && s.dates.length <= 12) {
    const dates = s.dates.map((x) => ({ month: num(x && x.month), day: num(x && x.day) }));
    if (dates.every((x) => isMonth(x.month) && isDay(x.day))) return { type: "multiple", dates };
  }
  if (type === "anniversary") return { type };
  if (type === "event" || type === "as_triggered") return { type: "event" };
  return null;
}

function toDay(s) {
  return /last/i.test(s) ? "last" : parseInt(s, 10);
}

/** Every "15 April" / "April 15" / "Apr 15th" in a string, as {month, day}. */
function explicitDates(text) {
  const out = [];
  const seen = new Set();
  const push = (month, day) => {
    const key = `${month}-${day}`;
    if (isMonth(month) && isDay(day) && !seen.has(key)) { seen.add(key); out.push({ month, day }); }
  };
  const dayFirst = new RegExp(`\\b(\\d{1,2}|last day of)(?:st|nd|rd|th)?\\s+(?:of\\s+)?${MONTH_RE}\\b`, "gi");
  const monthFirst = new RegExp(`\\b${MONTH_RE}\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b(?!\\s*(?:months?|days?))`, "gi");
  let m;
  const spans = [];
  while ((m = dayFirst.exec(text))) { push(MONTHS[m[2].toLowerCase()], toDay(m[1])); spans.push([m.index, m.index + m[0].length]); }
  while ((m = monthFirst.exec(text))) {
    if (spans.some(([a, b]) => m.index >= a && m.index < b)) continue;
    push(MONTHS[m[1].toLowerCase()], parseInt(m[2], 10));
  }
  return out;
}

/**
 * Best-effort reading of a due-date description.
 * @returns {object} schedule (see above); never throws
 */
function parseDueText(text) {
  // Extension deadlines ("extension to 15 October with Form 7004") are not
  // the due date; drop them before looking for dates.
  const t = String(text || "").replace(/\s+/g, " ").trim()
    .replace(/[;,]?\s*(?:automatic |an? )?(?:\d+[- ]month )?extension[^;)]*/gi, "");
  const lower = t.toLowerCase();
  if (!t) return { type: "unknown" };

  if (/as triggered|event[- ]based|upon (?:any|a|the)|within \d+ days? (?:of|after)|when (?:a|the|any)|per service agreement/.test(lower)) {
    return { type: "event" };
  }
  if (/anniversar/.test(lower) && /incorporat|formation|registration/.test(lower)) return { type: "anniversary" };

  // US corporate estimated tax (Form 1120-W): 15th day of the 4th, 6th,
  // 9th and 12th months of the TAX YEAR — not evenly spaced quarters.
  if (/estimated (?:income )?tax|1120-w/.test(lower) && /quarter|install|estimat/.test(lower) && !/individual|1040/.test(lower)) {
    return { type: "estimated_tax" };
  }

  // Nth day of the Mth month after the end of the fiscal/tax year.
  const rel = lower.match(/(\d{1,2})(?:st|nd|rd|th)? day of (?:the )?(\d{1,2})(?:st|nd|rd|th)? month (?:after|following) (?:the )?(?:end of (?:the |its |each )?)?(?:company'?s? )?(?:fiscal|tax|financial|fy|accounting)/);
  if (rel) return { type: "fy_relative", monthsAfter: parseInt(rel[2], 10), day: parseInt(rel[1], 10) };

  // Last day of the month after each calendar quarter (Form 941 pattern).
  if (/last day of the (?:first )?month (?:after|following) (?:the end of )?(?:each|every|the)? ?(?:calendar )?quarter/.test(lower)) {
    return { type: "multiple", dates: [{ month: 4, day: 30 }, { month: 7, day: 31 }, { month: 10, day: 31 }, { month: 1, day: 31 }] };
  }

  // A single date outside brackets is the plainest statement of the due
  // date ("15 April (Annually)"). Otherwise prefer the company-specific
  // date in brackets: "15th day of the month… (15 July for this company)".
  const outside = explicitDates(t.replace(/\([^)]*\)/g, " "));
  if (outside.length === 1 && !/each|every|quarter|monthly|semi-?annual|twice a year|half-?year/i.test(t)) return { type: "annual", ...outside[0] };
  const bracket = t.match(/\(([^)]*)\)/g);
  if (bracket) {
    for (const b of bracket) {
      const d = explicitDates(b);
      if (d.length === 1 && !/every|each|quarter/i.test(t.replace(b, ""))) return { type: "annual", ...d[0] };
    }
  }

  const monthly = lower.match(/(?:by|on|before) the (\d{1,2})(?:st|nd|rd|th)? (?:day )?of (?:each|every|the following) month|(\d{1,2})(?:st|nd|rd|th)? of (?:each|every) month|\bmonthly\b/);
  const dates = explicitDates(t);
  if (monthly && dates.length === 0) {
    const day = parseInt(monthly[1] || monthly[2], 10);
    return isDay(day) ? { type: "monthly", day } : { type: "unknown" };
  }
  if (dates.length === 1) {
    // "30 April (Quarterly)": one example date + a frequency word.
    const { month, day } = dates[0];
    // 30 April is the LAST day of April → last day of each quarter-month
    // (31 July, 31 October), not the 30th.
    const isLast = day === "last" || (day === lastDayOf(2027, month) && month !== 2);
    const every = (step) => {
      const out = [];
      for (let k = 0; k < 12; k += step) {
        const m = ((month - 1 + k) % 12) + 1;
        out.push({ month: m, day: isLast ? "last" : day });
      }
      return { type: "multiple", dates: out };
    };
    if (/\bquarter(?:ly)?\b/.test(lower)) return every(3);
    if (/semi-?annual|twice a year|half-?year(?:ly)?|every six months/.test(lower)) return every(6);
    if (/\bmonthly\b|each month|every month/.test(lower)) return { type: "monthly", day: isLast ? "last" : day };
    return { type: "annual", ...dates[0] };
  }
  if (dates.length >= 2 && dates.length <= 12) return { type: "multiple", dates };
  return { type: "unknown" };
}

function fyEndMonth(profile) {
  const raw = String((profile && profile.fyEnd) || "").trim().toLowerCase();
  if (MONTHS[raw]) return MONTHS[raw];
  const three = raw.slice(0, 3);
  if (MONTHS[three]) return MONTHS[three];
  const n = parseInt(raw, 10);
  return isMonth(n) ? n : 12; // calendar year if unknown
}

function incorpMonthDay(profile) {
  const raw = profile && profile.incorpDate;
  if (!raw) return null;
  const d = new Date(raw);
  if (isNaN(d.getTime())) return null;
  return { month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

/** Raw (unadjusted) candidate dates around year y. */
function candidates(schedule, profile, y) {
  switch (schedule.type) {
    case "annual":
      return [clampDay(y, schedule.month, schedule.day)];
    case "multiple":
      return schedule.dates.map((x) => clampDay(y, x.month, x.day));
    case "monthly": {
      const out = [];
      for (let m = 1; m <= 12; m++) out.push(clampDay(y, m, schedule.day));
      return out;
    }
    case "fy_relative": {
      // FY ending in month E of year y → due in month E+monthsAfter.
      const { y: dy, m: dm } = addMonths(y, fyEndMonth(profile), schedule.monthsAfter);
      return [clampDay(dy, dm, schedule.day)];
    }
    case "estimated_tax": {
      // Tax year ending in month E of year y starts the month after E of y-1.
      const E = fyEndMonth(profile);
      const start = addMonths(y - 1, E, 1); // first month of the tax year
      return [3, 5, 8, 11].map((k) => { const t = addMonths(start.y, start.m, k); return clampDay(t.y, t.m, 15); });
    }
    case "anniversary": {
      const md = incorpMonthDay(profile);
      return md ? [clampDay(y, md.month, md.day)] : [];
    }
    default:
      return [];
  }
}

/**
 * Next due date on or after `from`.
 * @param {object} opts.businessDays  move weekend/holiday dates (default true)
 * @returns {{ date: Date, moved: string|null } | null}
 */
function nextOccurrence(schedule, profile, from = new Date(), { businessDays = true } = {}) {
  if (!schedule || ["event", "unknown"].includes(schedule.type)) return null;
  const start = startOfDay(from);
  const y = start.getUTCFullYear();
  const all = [];
  for (let yy = y - 1; yy <= y + 2; yy++) all.push(...candidates(schedule, profile, yy));
  // Compare using the ADJUSTED date: a Saturday deadline moved to Monday
  // is still upcoming on Sunday.
  const adjusted = all
    .map((raw) => (businessDays ? { raw, ...toBusinessDay(raw) } : { raw, date: raw, moved: null }))
    .filter((c) => c.date >= start)
    .sort((a, b) => a.date - b.date);
  if (!adjusted.length) return null;
  return { date: adjusted[0].date, moved: adjusted[0].moved };
}

/** "every year", "every quarter", … for display. */
function recurrenceLabel(schedule) {
  if (!schedule) return "";
  if (schedule.type === "multiple") {
    const n = schedule.dates.length;
    return n === 4 ? "every quarter" : n === 2 ? "twice a year" : n === 12 ? "every month" : `${n} times a year`;
  }
  return { annual: "every year", fy_relative: "every year", anniversary: "every year", monthly: "every month", estimated_tax: "4 times a year" }[schedule.type] || "";
}

function recurrenceOf(schedule) {
  return { annual: "annual", fy_relative: "annual", anniversary: "annual", multiple: "multiple", estimated_tax: "multiple", monthly: "monthly", event: "event" }[schedule && schedule.type] || "unknown";
}

// Non-US filings (e.g. RBI/FEMA) don't follow US business-day rules.
function usesUsBusinessDays(item) {
  return !/ODI|FEMA|RBI/i.test(`${item.category || ""} ${item.authority || ""}`);
}

function scheduleFor(item) {
  return validSchedule(item.schedule) || parseDueText(item.due_date || item.due_date_rule);
}

/**
 * Fill in dueDateActual for every current item whose date is automatic
 * and hasn't been computed from its current text yet. Staff-set dates are
 * never touched. Mutates the calendar's items; returns how many changed.
 */
function ensureDueDates(calendar, now = new Date()) {
  let changed = 0;
  const profile = calendar.profile || {};
  (calendar.items || []).forEach((item) => {
    if (item.isHistory || item.dueDateSource === "staff") return;
    const text = item.due_date || "";
    if (item.dueDateParsedFrom === text && item.dueDateSource) return; // already computed from this text
    const schedule = scheduleFor(item);
    const next = nextOccurrence(schedule, profile, now, { businessDays: usesUsBusinessDays(item) });
    item.recurrence = recurrenceOf(schedule);
    item.dueDateActual = next ? next.date : null;
    item.dueDateNote = next && next.moved ? `Moved to the next business day: ${next.moved}.` : "";
    item.dueDateSource = next ? "auto" : "none";
    item.dueDateParsedFrom = text;
    changed++;
  });
  return changed;
}

module.exports = {
  parseDueText,
  validSchedule,
  scheduleFor,
  nextOccurrence,
  ensureDueDates,
  recurrenceOf,
  recurrenceLabel,
  usesUsBusinessDays,
  toBusinessDay,
  isBusinessDay,
  usHolidays,
  startOfDay,
  addDays,
  daysBetween,
  fmt,
};
