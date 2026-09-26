// lib/reports.js
//
// The numbers behind the Reports page (routes/reports.routes.js). Pure
// functions over plain data so every figure can be tested and explained:
//
//   filings    completed in the period, on time or late, how long they took
//              (from the client choosing the service to it being filed),
//              how many were chosen, how many are open / overdue right now
//   workload   per team member: open filings they own, overdue, done
//   services   which services clients choose most, and finish
//   revenue    money collected (invoices) minus refunds (credit notes),
//              per month, per service and per client. Finance/admin only.
//
// Definitions (also shown on the page):
//   On time     filed on or before its due date (filings with no date are left out)
//   Turnaround  days from "client chose it" to "we uploaded proof it's done"

const DAY = 86400000;
const startOfDayUTC = (d) => { const x = new Date(d); x.setUTCHours(0, 0, 0, 0); return x; };
const inRange = (d, from, to) => d && new Date(d) >= from && new Date(d) < to;

/**
 * Turn ?range=30d|90d|12m|fy|custom&from=YYYY-MM-DD&to=YYYY-MM-DD into dates.
 * `to` is exclusive (start of the day after the last day shown).
 * "fy" is the Indian financial year (1 April – 31 March), matching invoices.
 */
function periodFrom(query = {}, now = new Date()) {
  const today = startOfDayUTC(now);
  const tomorrow = new Date(today.getTime() + DAY);
  const range = String(query.range || "90d");
  const parse = (s) => (/^\d{4}-\d{2}-\d{2}$/.test(String(s || "")) ? new Date(`${s}T00:00:00Z`) : null);
  const fmt = (d) => d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
  let from, to = tomorrow, label;
  if (range === "custom") {
    from = parse(query.from);
    const last = parse(query.to);
    if (!from || !last || last < from) return { error: "Choose a start and end date (the end can't be before the start)." };
    if ((last - from) / DAY > 366 * 5) return { error: "Choose a period of 5 years or less." };
    to = new Date(last.getTime() + DAY);
    label = `${fmt(from)} – ${fmt(last)}`;
  } else if (range === "fy") {
    const y = today.getUTCMonth() >= 3 ? today.getUTCFullYear() : today.getUTCFullYear() - 1;
    from = new Date(Date.UTC(y, 3, 1));
    label = `This financial year (Apr ${y} – Mar ${y + 1}), so far`;
  } else if (range === "12m") {
    from = new Date(Date.UTC(today.getUTCFullYear() - 1, today.getUTCMonth(), today.getUTCDate() + 1));
    label = "Last 12 months";
  } else {
    const days = range === "30d" ? 30 : 90;
    from = new Date(tomorrow.getTime() - days * DAY);
    label = `Last ${days} days`;
  }
  const iso = (d) => d.toISOString().slice(0, 10);
  return { range, from, to, label, fromDate: iso(from), toDate: iso(new Date(to.getTime() - DAY)) };
}

const median = (nums) => {
  if (!nums.length) return null;
  const s = [...nums].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : Math.round(((s[m - 1] + s[m]) / 2) * 10) / 10;
};
const average = (nums) => (nums.length ? Math.round((nums.reduce((a, b) => a + b, 0) / nums.length) * 10) / 10 : null);
const pct = (part, whole) => (whole ? Math.round((part / whole) * 100) : null);

function onTime(item) {
  if (!item.completedAt || !item.dueDateActual) return null;
  return new Date(item.completedAt) < new Date(startOfDayUTC(item.dueDateActual).getTime() + DAY);
}
function turnaroundDays(item) {
  if (!item.completedAt || !item.selectedAt) return null;
  return Math.max(0, Math.round((new Date(item.completedAt) - new Date(item.selectedAt)) / DAY * 10) / 10);
}

/**
 * rows: [{ item, company, calendarId, itemIndex }] for every SELECTED item
 * (current and past periods) of current client calendars.
 */
function filingStats(rows, { from, to, now = new Date() }) {
  const today = startOfDayUTC(now);
  const completed = rows.filter((r) => r.item.clientStatus === "Filed" && inRange(r.item.completedAt, from, to));
  const dated = completed.filter((r) => onTime(r.item) !== null);
  const onTimeCount = dated.filter((r) => onTime(r.item)).length;
  const turn = completed.map((r) => turnaroundDays(r.item)).filter((n) => n !== null);
  const open = rows.filter((r) => !r.item.isHistory && r.item.clientStatus !== "Filed");
  const overdue = open.filter((r) => r.item.dueDateActual && startOfDayUTC(r.item.dueDateActual) < today);
  const late = dated.filter((r) => !onTime(r.item)).map((r) => ({
    company: r.company, task: r.item.compliance_name, calendarId: r.calendarId, itemIndex: r.itemIndex,
    dueDate: r.item.dueDateActual, completedAt: r.item.completedAt,
    daysLate: Math.round((startOfDayUTC(r.item.completedAt) - startOfDayUTC(r.item.dueDateActual)) / DAY),
  })).sort((a, b) => b.daysLate - a.daysLate);
  return {
    completed: completed.length,
    onTime: onTimeCount,
    late: dated.length - onTimeCount,
    noDueDate: completed.length - dated.length,
    onTimeRate: pct(onTimeCount, dated.length),
    turnaroundMedianDays: median(turn),
    turnaroundAverageDays: average(turn),
    chosen: rows.filter((r) => inRange(r.item.selectedAt, from, to)).length,
    openNow: open.length,
    overdueNow: overdue.length,
    lateList: late.slice(0, 20),
  };
}

/**
 * Per team member. cards: pipeline cards (lib/pipeline.js) for work that
 * is open now; rows: as filingStats; users: [{ id, name, email, active }].
 */
function workload(cards, rows, users, { from, to }) {
  const byId = new Map(users.map((u) => [String(u.id), { id: String(u.id), name: u.name || u.email, email: u.email, active: u.active !== false, open: 0, overdue: 0, waitingOnUs: 0, completed: 0, turnaround: [] }]));
  const none = { id: null, name: "Unassigned", email: "", active: true, open: 0, overdue: 0, waitingOnUs: 0, completed: 0, turnaround: [] };
  const slot = (id) => (id && byId.get(String(id))) || none;
  cards.filter((c) => c.stage !== "done").forEach((c) => {
    const s = slot(c.owner.id);
    s.open++;
    if (c.daysUntilDue !== null && c.daysUntilDue < 0) s.overdue++;
    if (["verify", "price", "work"].includes(c.stage)) s.waitingOnUs++;
  });
  const emailToId = new Map(users.map((u) => [String(u.email || "").toLowerCase(), String(u.id)]));
  rows.filter((r) => r.item.clientStatus === "Filed" && inRange(r.item.completedAt, from, to)).forEach((r) => {
    // Credit goes to whoever uploaded the proof.
    const id = emailToId.get(String(r.item.completedBy || "").toLowerCase());
    const s = id ? slot(id) : slot(r.item.assignedTo);
    s.completed++;
    const t = turnaroundDays(r.item);
    if (t !== null) s.turnaround.push(t);
  });
  return [...byId.values(), none]
    .filter((s) => s.open || s.completed || (s.id && s.active))
    .map(({ turnaround, ...s }) => ({ ...s, turnaroundMedianDays: median(turnaround) }))
    .sort((a, b) => (a.id === null) - (b.id === null) || b.open - a.open || b.completed - a.completed || a.name.localeCompare(b.name));
}

/** Which services clients choose and we finish, most chosen first. */
function services(rows, { from, to }) {
  const map = new Map();
  rows.forEach((r) => {
    const name = r.item.compliance_name || "(unnamed)";
    const s = map.get(name) || { name, chosen: 0, completed: 0, openNow: 0 };
    if (inRange(r.item.selectedAt, from, to)) s.chosen++;
    if (r.item.clientStatus === "Filed" && inRange(r.item.completedAt, from, to)) s.completed++;
    if (!r.item.isHistory && r.item.clientStatus !== "Filed") s.openNow++;
    map.set(name, s);
  });
  return [...map.values()].filter((s) => s.chosen || s.completed || s.openNow)
    .sort((a, b) => b.chosen - a.chosen || b.completed - a.completed || a.name.localeCompare(b.name));
}

const monthKey = (d) => new Date(d).toISOString().slice(0, 7);
function lastMonths(to, n = 12) {
  const end = new Date(to.getTime() - DAY);
  const out = [];
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() - i, 1));
    out.push({ key: monthKey(d), label: d.toLocaleDateString("en-GB", { month: "short", year: "2-digit", timeZone: "UTC" }) });
  }
  return out;
}

/**
 * docs: Invoice documents (models/Invoice.js), plain objects.
 * Invoices count when issued (= paid); refunds count when the credit note
 * was issued. Void credit notes (refund failed) are ignored.
 */
function revenue(docs, { from, to }) {
  const live = docs.filter((d) => !(d.kind === "credit_note" && d.status === "void"));
  const currencies = [...new Set(live.map((d) => d.currency || "USD"))];
  const main = currencies.includes("USD") || !currencies.length ? "USD" : currencies[0];
  const sign = (d) => (d.kind === "credit_note" ? -1 : 1);
  const byCurrency = {};
  currencies.forEach((c) => {
    const inP = live.filter((d) => (d.currency || "USD") === c && inRange(d.issuedAt, from, to));
    const collected = inP.filter((d) => d.kind === "invoice").reduce((n, d) => n + d.amountMinor, 0);
    const refunded = inP.filter((d) => d.kind === "credit_note").reduce((n, d) => n + d.amountMinor, 0);
    const count = inP.filter((d) => d.kind === "invoice").length;
    byCurrency[c] = { collected, refunded, net: collected - refunded, invoices: count, refunds: inP.length - count, averageInvoice: count ? Math.round(collected / count) : 0 };
  });

  const mainDocs = live.filter((d) => (d.currency || "USD") === main);
  const months = lastMonths(to).map((m) => ({ ...m, net: 0, collected: 0, refunded: 0 }));
  const idx = new Map(months.map((m, i) => [m.key, i]));
  mainDocs.forEach((d) => {
    const i = idx.get(monthKey(d.issuedAt));
    if (i === undefined) return;
    if (d.kind === "invoice") months[i].collected += d.amountMinor; else months[i].refunded += d.amountMinor;
    months[i].net += sign(d) * d.amountMinor;
  });

  const group = (keyFn) => {
    const m = new Map();
    mainDocs.filter((d) => inRange(d.issuedAt, from, to)).forEach((d) => {
      const k = keyFn(d) || "(not recorded)";
      const g = m.get(k) || { name: k, net: 0, invoices: 0 };
      g.net += sign(d) * d.amountMinor;
      if (d.kind === "invoice") g.invoices++;
      m.set(k, g);
    });
    return [...m.values()].sort((a, b) => b.net - a.net).slice(0, 10);
  };

  return {
    currency: main,
    totals: byCurrency[main] || { collected: 0, refunded: 0, net: 0, invoices: 0, refunds: 0, averageInvoice: 0 },
    otherCurrencies: Object.entries(byCurrency).filter(([c]) => c !== main).map(([currency, t]) => ({ currency, ...t })),
    byMonth: months,
    byService: group((d) => d.description),
    byClient: group((d) => d.customer && d.customer.name),
  };
}

// ---------------------------------------------------------------------
// CSV (opens in Excel / Google Sheets)
// ---------------------------------------------------------------------
function csvCell(v) {
  if (v === null || v === undefined) return "";
  let s = v instanceof Date ? v.toISOString().slice(0, 10) : String(v);
  // Stop spreadsheet apps treating text as a formula.
  if (typeof v !== "number" && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
function toCsv(headers, rows) {
  // Byte-order mark so Excel reads UTF-8 (₹, é …) correctly.
  return "﻿" + [headers.map(csvCell).join(","), ...rows.map((r) => r.map(csvCell).join(","))].join("\r\n") + "\r\n";
}

module.exports = { periodFrom, filingStats, workload, services, revenue, toCsv, csvCell, onTime, turnaroundDays, median, lastMonths };
