// routes/dashboard.routes.js
//
// One endpoint, three genuinely different answers.
//
// The scoping here is server-side on purpose. It would be far less code
// to return everything and let public/dashboard.html hide the panels a
// given role shouldn't see — and it would also be fake security, since
// anyone can open the network tab and read the response the page chose
// not to draw. So finance's numbers are simply never assembled for a
// tech account, and the team/audit data is never assembled for anyone
// below super_admin.
//
//   tech (staff, department "tech")  - the review queue and delivery work
//   finance (staff, department "finance") - invoicing, receipts, overdue
//   admin / super_admin              - both of the above, and for
//                                      super_admin additionally the team
//                                      roster and the security log
//
// Everything is derived from data that already exists (Calendar,
// ClientOrg, User, AuditLog) — no new source of truth, so these numbers
// can never drift from the rest of the app.

const express = require("express");
const mongoose = require("mongoose");
const Calendar = require("../models/Calendar");
const ClientOrg = require("../models/ClientOrg");
const User = require("../models/User");
const AuditLog = require("../models/AuditLog");
const { requireAuth, requireRole } = require("../middleware/auth");

const router = express.Router();
router.use(requireAuth, requireRole("staff"));

// "Real client work", as opposed to the anonymous lead-gen calendars
// from the public tool, which would otherwise inflate every count on
// every dashboard.
// Includes calendars a client claimed from the public tool (they keep
// source:"public" but gain a clientOrgId) — those used to be invisible
// here. Superseded calendars are excluded so a regenerated calendar isn't
// counted twice.
const { REAL_WORK_MATCH, toView } = require("../lib/calendarView");
const REAL_WORK = { ...REAL_WORK_MATCH, supersededAt: null };

// Staff accounts created before departments existed have department ""
// — they fall through to the tech/delivery view, which is what the
// staff pages have always shown them. Only an explicit "finance" swaps
// them onto the money view. Admins and super_admins see both.
function canSeeTech(user) {
  return user.role !== "staff" || user.department !== "finance";
}
function canSeeFinance(user) {
  return user.role !== "staff" || user.department === "finance";
}

const money = (cents) => Math.round((cents || 0)) / 100;

// ---------------------------------------------------------------------
// Tech: what needs a human, and what's moving
// ---------------------------------------------------------------------
async function buildTechSection() {
  const [statusCounts, itemStatusCounts, pendingDocs, recentCalendars, orgCount] = await Promise.all([
    Calendar.aggregate([
      { $match: REAL_WORK },
      { $group: { _id: "$status", count: { $sum: 1 } } },
    ]),
    Calendar.aggregate([
      { $match: REAL_WORK },
      { $unwind: "$items" },
      { $group: { _id: "$items.clientStatus", count: { $sum: 1 } } },
    ]),
    // Client uploads still waiting on someone to accept or reject them.
    Calendar.aggregate([
      { $match: REAL_WORK },
      { $unwind: "$items" },
      { $unwind: "$items.documents" },
      {
        $match: {
          "items.documents.type": "client_upload",
          "items.documents.reviewStatus": "pending",
        },
      },
      { $count: "count" },
    ]),
    Calendar.find(REAL_WORK)
      .sort({ createdAt: -1 })
      .limit(8)
      .select("profile.companyName status createdBy createdAt clientOrgId")
      .lean(),
    ClientOrg.countDocuments(),
  ]);

  // The actual documents waiting on a human, oldest first, so the
  // dashboard is a work list and not just a number.
  const pendingDocList = await Calendar.aggregate([
    { $match: REAL_WORK },
    { $project: { profile: 1, clientOrgId: 1, items: { $map: { input: { $range: [0, { $size: "$items" }] }, as: "i", in: { idx: "$$i", it: { $arrayElemAt: ["$items", "$$i"] } } } } } },
    { $unwind: "$items" },
    { $project: { profile: 1, idx: "$items.idx", name: "$items.it.compliance_name", selected: "$items.it.selectedByClient", docs: "$items.it.documents" } },
    { $unwind: "$docs" },
    { $match: { "docs.type": "client_upload", "docs.reviewStatus": "pending" } },
    { $sort: { "docs.uploadedAt": 1 } },
    { $limit: 15 },
  ]);

  // Per client: what they picked and what's waiting on us. Sorted so the
  // clients who need something from the team come first.
  const clientCalendars = await Calendar.find({ status: "approved", clientOrgId: { $ne: null }, supersededAt: null })
    .sort({ updatedAt: -1 })
    .limit(60);
  const orgNames = Object.fromEntries(
    (await ClientOrg.find({ _id: { $in: clientCalendars.map((c) => c.clientOrgId) } }).select("name primaryContactPhone").lean())
      .map((o) => [String(o._id), o])
  );
  const clientWork = clientCalendars
    .map((c) => {
      const sm = toView(c, { staff: true }).summary;
      const org = orgNames[String(c.clientOrgId)] || {};
      return {
        calendarId: String(c._id),
        company: org.name || c.profile?.companyName || "(unnamed)",
        hasPhone: Boolean(org.primaryContactPhone),
        selected: sm.selected,
        total: sm.totalItems,
        toVerify: sm.documentsPendingReview,
        readyToQuote: sm.readyToQuote,
        awaitingPayment: sm.awaitingPayment,
        updatedAt: c.updatedAt,
      };
    })
    .sort((a, b) => (b.toVerify + b.readyToQuote) - (a.toVerify + a.readyToQuote) || new Date(b.updatedAt) - new Date(a.updatedAt))
    .slice(0, 20);

  const byStatus = Object.fromEntries(statusCounts.map((r) => [r._id, r.count]));
  const byItemStatus = Object.fromEntries(itemStatusCounts.map((r) => [r._id, r.count]));

  return {
    cards: [
      { label: "Awaiting review", value: byStatus.pending_review || 0, tone: "warn", hint: "Calendars a human hasn't signed off yet" },
      { label: "Documents to check", value: pendingDocs[0]?.count || 0, tone: "warn", hint: "Client uploads pending accept/reject" },
      { label: "Approved calendars", value: byStatus.approved || 0, tone: "good", hint: "Verified and visible to clients" },
      { label: "Client organisations", value: orgCount, tone: "neutral", hint: "Companies on the books" },
    ],
    filingStatus: [
      { label: "Not started", value: byItemStatus["Not Started"] || 0 },
      { label: "Awaiting documents", value: byItemStatus["Awaiting Documents"] || 0 },
      { label: "Under review", value: byItemStatus["Under Review"] || 0 },
      { label: "Filed", value: byItemStatus.Filed || 0 },
      { label: "Overdue", value: byItemStatus.Overdue || 0 },
    ],
    clientWork,
    pendingDocuments: pendingDocList.map((d) => ({
      calendarId: String(d._id),
      company: d.profile?.companyName || "(unnamed)",
      task: d.name,
      fileName: d.docs.fileName,
      requirement: d.docs.requirementLabel || "",
      uploadedAt: d.docs.uploadedAt,
    })),
    recentCalendars: recentCalendars.map((c) => ({
      id: String(c._id),
      company: c.profile?.companyName || "(unnamed)",
      status: c.status,
      createdBy: c.createdBy,
      createdAt: c.createdAt,
    })),
  };
}

// ---------------------------------------------------------------------
// Finance: money in, money owed
// ---------------------------------------------------------------------
async function buildFinanceSection() {
  const [payAgg, recentPaid, outstanding] = await Promise.all([
    Calendar.aggregate([
      { $match: REAL_WORK },
      { $unwind: "$items" },
      {
        $group: {
          _id: "$items.paymentStatus",
          count: { $sum: 1 },
          cents: { $sum: { $ifNull: ["$items.feeAmountCents", 0] } },
        },
      },
    ]),
    Calendar.aggregate([
      { $match: REAL_WORK },
      { $unwind: "$items" },
      { $match: { "items.paymentStatus": "Paid", "items.paidAt": { $ne: null } } },
      { $sort: { "items.paidAt": -1 } },
      { $limit: 8 },
      {
        $project: {
          company: "$profile.companyName",
          task: "$items.compliance_name",
          cents: { $ifNull: ["$items.feeAmountCents", 0] },
          paidAt: "$items.paidAt",
        },
      },
    ]),
    Calendar.aggregate([
      { $match: REAL_WORK },
      { $unwind: "$items" },
      { $match: { "items.paymentStatus": { $in: ["Invoiced", "Overdue"] } } },
      { $sort: { "items.dueDateActual": 1 } },
      { $limit: 10 },
      {
        $project: {
          company: "$profile.companyName",
          task: "$items.compliance_name",
          cents: { $ifNull: ["$items.feeAmountCents", 0] },
          paymentStatus: "$items.paymentStatus",
          dueDate: "$items.due_date",
        },
      },
    ]),
  ]);

  const by = Object.fromEntries(payAgg.map((r) => [r._id, r]));
  const paidCents = by.Paid?.cents || 0;
  const invoicedCents = by.Invoiced?.cents || 0;
  const overdueCents = by.Overdue?.cents || 0;

  return {
    currency: "USD",
    cards: [
      { label: "Collected", value: money(paidCents), money: true, tone: "good", hint: `${by.Paid?.count || 0} paid filings` },
      { label: "Outstanding", value: money(invoicedCents), money: true, tone: "warn", hint: `${by.Invoiced?.count || 0} invoiced, not yet paid` },
      { label: "Overdue", value: money(overdueCents), money: true, tone: "bad", hint: `${by.Overdue?.count || 0} past their due date` },
      { label: "Not invoiced", value: by["Not Invoiced"]?.count || 0, tone: "neutral", hint: "Filings with no fee raised yet" },
    ],
    recentPaid: recentPaid.map((r) => ({
      company: r.company || "(unnamed)",
      task: r.task,
      amount: money(r.cents),
      paidAt: r.paidAt,
    })),
    outstanding: outstanding.map((r) => ({
      company: r.company || "(unnamed)",
      task: r.task,
      amount: money(r.cents),
      paymentStatus: r.paymentStatus,
      dueDate: r.dueDate,
    })),
  };
}

// ---------------------------------------------------------------------
// Super admin: the team, and the security trail
// ---------------------------------------------------------------------
async function buildOwnerSection() {
  const [team, audit, leadCount] = await Promise.all([
    User.find({ role: { $in: ["staff", "admin", "super_admin"] } })
      .sort({ role: -1, email: 1 })
      .select("email name role department active mustSetPassword lastLoginAt createdAt")
      .lean(),
    AuditLog.find().sort({ createdAt: -1 }).limit(15).lean(),
    Calendar.countDocuments({ source: "public", leadContact: { $ne: null } }),
  ]);

  return {
    cards: [
      { label: "Team accounts", value: team.length, tone: "neutral", hint: "Staff, admins and owners" },
      { label: "Awaiting first login", value: team.filter((u) => u.mustSetPassword).length, tone: "warn", hint: "Invited but haven't set a password" },
      { label: "Deactivated", value: team.filter((u) => !u.active).length, tone: "neutral", hint: "Cannot sign in" },
      { label: "Leads captured", value: leadCount, tone: "good", hint: "From the public tool" },
    ],
    team: team.map((u) => ({
      id: String(u._id),
      email: u.email,
      name: u.name,
      role: u.role,
      department: u.department || "",
      active: u.active,
      mustSetPassword: u.mustSetPassword,
      lastLoginAt: u.lastLoginAt,
    })),
    audit: audit.map((a) => ({
      action: a.action,
      actor: a.actorName,
      summary: a.summary,
      at: a.createdAt,
    })),
  };
}

// GET /api/dashboard/summary
router.get("/summary", async (req, res) => {
  try {
    const user = req.user;
    const payload = {
      user: user.toSafeJSON(),
      // What the page is allowed to render. The page trusts this; the
      // point is that the data simply isn't here when the flag is false.
      sections: {
        tech: canSeeTech(user),
        finance: canSeeFinance(user),
        owner: user.role === "super_admin",
      },
      generatedAt: new Date(),
    };

    const jobs = [];
    if (payload.sections.tech) jobs.push(buildTechSection().then((d) => (payload.tech = d)));
    if (payload.sections.finance) jobs.push(buildFinanceSection().then((d) => (payload.finance = d)));
    if (payload.sections.owner) jobs.push(buildOwnerSection().then((d) => (payload.owner = d)));
    await Promise.all(jobs);

    res.json(payload);
  } catch (err) {
    console.error("[dashboard] Failed to build summary:", err);
    res.status(500).json({ error: "Couldn't load the dashboard right now." });
  }
});

// PATCH /api/dashboard/team/:id/reset — super_admin only. Clears the
// password so the person has to go back through the email-code flow and
// choose a new one, and invalidates every session they had open. This is
// the "someone left / someone's laptop was stolen" button.
router.patch("/team/:id/reset", requireRole("super_admin"), async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) {
    return res.status(400).json({ error: "Invalid account id." });
  }
  const target = await User.findById(req.params.id);
  if (!target) return res.status(404).json({ error: "Account not found." });
  if (String(target._id) === String(req.user._id)) {
    // Locking yourself out of the only super_admin account is an
    // unrecoverable mistake without database access.
    return res.status(400).json({ error: "Use the change-password screen for your own account." });
  }

  target.passwordHash = null;
  target.mustSetPassword = true;
  target.tokenVersion = (target.tokenVersion || 0) + 1;
  target.failedOtpAttempts = 0;
  target.lockedUntil = null;
  await target.save();

  res.json({ ok: true, message: `${target.email} must sign in with an email code and set a new password.` });
});

module.exports = router;
