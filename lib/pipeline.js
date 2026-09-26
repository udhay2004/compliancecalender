// lib/pipeline.js
//
// The staff work pipeline: every service a client asked us to handle,
// placed in the ONE stage that says what happens next, and who owns it.
//
//   docs     Waiting on the client for documents
//   verify   Documents uploaded, a staff member must check them
//   price    All documents in, needs a price (quote)
//   payment  Priced, waiting for the client to pay
//   work     Paid, ready for us to file
//   done     Filed (last 30 days, so the column doesn't grow forever)
//
// Stages are worked out from data that already exists (checklist,
// document review states, payment status, clientStatus), so they can never
// disagree with the calendar page. Nothing is stored except who a filing
// is assigned to (item.assignedTo on models/Calendar.js).
//
// Who owns a filing: the person it's assigned to; if nobody, the staff
// member assigned to that client company (Admin → Client companies);
// otherwise "unassigned".

const STAGES = [
  { key: "docs", label: "Waiting on client", hint: "Documents still missing" },
  { key: "verify", label: "Check documents", hint: "Uploads to accept or reject" },
  { key: "price", label: "Needs a price", hint: "All documents in, send a quote" },
  { key: "payment", label: "Awaiting payment", hint: "Priced, client hasn't paid" },
  { key: "work", label: "Ready to file", hint: "Paid, do the filing" },
  { key: "done", label: "Done", hint: "Filed in the last 30 days" },
];
const STAGE_KEYS = STAGES.map((s) => s.key);
const DONE_WINDOW_DAYS = 30;
const DAY = 86400000;

const paidStatuses = new Set(["Paid", "Partially Refunded"]);

/**
 * The stage of one decorated item (from lib/calendarView.js toView), or
 * null when it isn't pipeline work (not selected, past period, refunded…).
 */
function stageOf(v, now = new Date()) {
  if (!v || !v.selectedByClient) return null;
  if (v.clientStatus === "Filed") {
    if (v.isHistory && !v.completedAt) return null;
    const at = v.completedAt ? new Date(v.completedAt).getTime() : 0;
    return at && now.getTime() - at <= DONE_WINDOW_DAYS * DAY ? "done" : null;
  }
  if (v.isHistory) return null;
  if (v.paymentStatus === "Refunded") return null;
  const pendingReview = (v.documents || []).some((d) => d.type === "client_upload" && d.reviewStatus === "pending" && !d.fileMissing);
  if (pendingReview) return "verify";
  const allIn = v.checklistSummary ? v.checklistSummary.allProvided : false;
  if (paidStatuses.has(v.paymentStatus)) return "work";
  if (!allIn) return "docs";
  if (v.paymentStatus === "Invoiced" || v.paymentStatus === "Overdue") return "payment";
  return "price";
}

/** When the filing entered its current stage (best available timestamp). */
function stageSince(v, stage) {
  const uploads = (v.documents || []).filter((d) => d.type === "client_upload");
  const latest = (dates) => dates.filter(Boolean).map((d) => new Date(d)).sort((a, b) => b - a)[0] || null;
  switch (stage) {
    case "docs": return v.selectedAt ? new Date(v.selectedAt) : null;
    case "verify": {
      const pending = uploads.filter((d) => d.reviewStatus === "pending").map((d) => new Date(d.uploadedAt)).sort((a, b) => a - b);
      return pending[0] || null;
    }
    case "price": return latest(uploads.map((d) => d.reviewedAt || d.uploadedAt)) || (v.selectedAt ? new Date(v.selectedAt) : null);
    case "payment": return v.quotedAt ? new Date(v.quotedAt) : null;
    case "work": return v.paidAt ? new Date(v.paidAt) : null;
    case "done": return v.completedAt ? new Date(v.completedAt) : null;
    default: return null;
  }
}

/**
 * Who owns this filing. users: Map(id -> { id, name, email }).
 * Returns { id, name, via } where via is "filing" | "client" | null.
 */
function ownerOf(item, org, users) {
  const pick = (id, via) => {
    const u = id && users.get(String(id));
    return u ? { id: String(u.id), name: u.name || u.email, via } : null;
  };
  return pick(item.assignedTo, "filing") || pick(org && org.assignedStaff, "client") || { id: null, name: "", via: null };
}

const daysBetween = (a, b) => Math.round((new Date(b).setUTCHours(0, 0, 0, 0) - new Date(a).setUTCHours(0, 0, 0, 0)) / DAY);

/**
 * All pipeline cards.
 * @param calendars  [{ calendar, view }] — view from toView(calendar, { staff: true })
 * @param orgs       Map(orgId -> org)
 * @param users      Map(userId -> user)
 */
function buildCards(calendars, orgs, users, now = new Date()) {
  const cards = [];
  calendars.forEach(({ calendar, view }) => {
    const org = orgs.get(String(calendar.clientOrgId)) || null;
    view.items.forEach((v, idx) => {
      const stage = stageOf(v, now);
      if (!stage) return;
      const since = stageSince(v, stage);
      const owner = ownerOf(calendar.items[idx] || v, org, users);
      const missing = (v.checklist || []).filter((r) => r.state === "missing" || r.state === "rejected").length;
      cards.push({
        calendarId: String(calendar._id),
        itemIndex: idx,
        company: (org && org.name) || calendar.profile?.companyName || "(unnamed)",
        clientOrgId: calendar.clientOrgId ? String(calendar.clientOrgId) : null,
        task: v.compliance_name,
        stage,
        since,
        daysInStage: since ? Math.max(0, daysBetween(since, now)) : null,
        dueDate: v.dueDateActual || null,
        daysUntilDue: v.dueDateActual ? daysBetween(now, v.dueDateActual) : null,
        clientStatus: v.clientStatus,
        paymentStatus: v.paymentStatus,
        feeCents: v.feeAmountCents || null,
        docs: v.checklistSummary ? { provided: v.checklistSummary.provided, total: v.checklistSummary.total, missing } : null,
        toVerify: (v.documents || []).filter((d) => d.type === "client_upload" && d.reviewStatus === "pending").length,
        remindersSent: v.docChase?.count || 0,
        owner,
        completedAt: v.completedAt || null,
      });
    });
  });
  return cards;
}

/** Most urgent first: overdue, then nearest deadline, then waiting longest. */
function sortCards(cards) {
  const due = (c) => (c.daysUntilDue === null ? 9999 : c.daysUntilDue);
  return cards.sort((a, b) =>
    a.stage === "done" && b.stage === "done"
      ? new Date(b.completedAt || 0) - new Date(a.completedAt || 0)
      : due(a) - due(b) || (b.daysInStage || 0) - (a.daysInStage || 0) || a.company.localeCompare(b.company)
  );
}

/**
 * Filters from the pipeline page.
 *   owner: "all" | "me" | "unassigned" | <userId>
 *   due:   "" | "overdue" | "7" | "30"
 *   q:     text in company or filing name
 */
function filterCards(cards, { owner = "all", due = "", q = "", me = null } = {}) {
  const text = String(q || "").trim().toLowerCase();
  return cards.filter((c) => {
    if (owner === "me" && c.owner.id !== String(me)) return false;
    if (owner === "unassigned" && c.owner.id) return false;
    if (owner && !["all", "me", "unassigned"].includes(owner) && c.owner.id !== String(owner)) return false;
    if (due === "overdue" && !(c.daysUntilDue !== null && c.daysUntilDue < 0 && c.stage !== "done")) return false;
    if ((due === "7" || due === "30") && !(c.daysUntilDue !== null && c.daysUntilDue <= Number(due) && c.stage !== "done")) return false;
    if (text && !`${c.company} ${c.task}`.toLowerCase().includes(text)) return false;
    return true;
  });
}

function countByStage(cards) {
  const counts = Object.fromEntries(STAGE_KEYS.map((k) => [k, 0]));
  cards.forEach((c) => { counts[c.stage] = (counts[c.stage] || 0) + 1; });
  return counts;
}

module.exports = { STAGES, STAGE_KEYS, stageOf, stageSince, ownerOf, buildCards, sortCards, filterCards, countByStage, daysBetween, DONE_WINDOW_DAYS };
