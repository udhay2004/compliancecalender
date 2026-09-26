// routes/pipeline.routes.js
//
// The staff work pipeline (public/pipeline.html, lib/pipeline.js):
//
//   GET   /api/pipeline?owner=all|me|unassigned|<userId>&due=|overdue|7|30&q=
//   PATCH /api/pipeline/:calendarId/items/:index/assign   { userId | null }
//
// Staff and above only. Assigning tells the new owner (bell + email).

const express = require("express");
const mongoose = require("mongoose");
const Calendar = require("../models/Calendar");
const ClientOrg = require("../models/ClientOrg");
const User = require("../models/User");
const Notification = require("../models/Notification");
const { requireAuth, requireRole } = require("../middleware/auth");
const { toView } = require("../lib/calendarView");
const { logActivity } = require("../lib/auditLog");
const { sendEmail } = require("../lib/mailer");
const P = require("../lib/pipeline");

const router = express.Router();
router.use(requireAuth, requireRole("staff"));

const TEAM_ROLES = ["staff", "admin", "super_admin"];

/** Everyone who can own work (active team accounts), for the pickers. */
async function teamMembers({ includeInactive = false } = {}) {
  const q = { role: { $in: TEAM_ROLES } };
  if (!includeInactive) q.active = { $ne: false };
  const users = await User.find(q).select("name email role department active").lean();
  return users.map((u) => ({ id: String(u._id), name: u.name || "", email: u.email, role: u.role, department: u.department || "", active: u.active !== false }))
    .sort((a, b) => (a.name || a.email).localeCompare(b.name || b.email));
}

/**
 * Current client calendars with their staff view, the client companies and
 * the team — everything the pipeline and the reports are built from.
 */
async function loadWork() {
  const calendars = await Calendar.find({ status: "approved", clientOrgId: { $ne: null }, supersededAt: null });
  const orgList = await ClientOrg.find({ _id: { $in: calendars.map((c) => c.clientOrgId) } }).select("name assignedStaff createdAt").lean();
  const team = await teamMembers({ includeInactive: true });
  return {
    calendars: calendars.map((calendar) => ({ calendar, view: toView(calendar, { staff: true }) })),
    orgs: new Map(orgList.map((o) => [String(o._id), o])),
    team,
    users: new Map(team.map((u) => [u.id, u])),
  };
}

// GET /api/pipeline/team — active team members, for "assign to" pickers.
router.get("/team", async (req, res) => {
  res.json({ team: await teamMembers(), me: String(req.user._id) });
});

// GET /api/pipeline
router.get("/", async (req, res) => {
  const { calendars, orgs, users, team } = await loadWork();
  const all = P.buildCards(calendars, orgs, users);
  const filters = {
    owner: String(req.query.owner || "all"),
    due: String(req.query.due || ""),
    q: String(req.query.q || "").slice(0, 100),
    me: String(req.user._id),
  };
  const shown = P.sortCards(P.filterCards(all, filters));
  const perStage = {};
  P.STAGE_KEYS.forEach((k) => { perStage[k] = shown.filter((c) => c.stage === k).slice(0, 150); });
  res.json({
    stages: P.STAGES,
    counts: P.countByStage(shown),
    totalOpen: shown.filter((c) => c.stage !== "done").length,
    cards: perStage,
    team: team.filter((u) => u.active),
    me: String(req.user._id),
    filters: { owner: filters.owner, due: filters.due, q: filters.q },
    generatedAt: new Date(),
  });
});

// PATCH /api/pipeline/:calendarId/items/:index/assign  { userId: "<id>" | null }
router.patch("/:calendarId/items/:index/assign", async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.calendarId)) return res.status(404).json({ error: "Calendar not found." });
  const calendar = await Calendar.findById(req.params.calendarId);
  if (!calendar || !calendar.clientOrgId) return res.status(404).json({ error: "Client calendar not found." });
  const idx = parseInt(req.params.index, 10);
  const item = calendar.items[idx];
  if (!item) return res.status(404).json({ error: "Filing not found." });

  const userId = req.body ? req.body.userId : undefined;
  if (userId === undefined) return res.status(400).json({ error: "Send { userId } (or null to unassign)." });
  let user = null;
  if (userId !== null && userId !== "") {
    if (!mongoose.isValidObjectId(userId)) return res.status(400).json({ error: "Unknown team member." });
    user = await User.findById(userId);
    if (!user || !TEAM_ROLES.includes(user.role) || user.active === false) {
      return res.status(400).json({ error: "You can only assign work to an active team member." });
    }
  }
  const before = item.assignedToName || "";
  item.assignedTo = user ? user._id : null;
  item.assignedToName = user ? user.name || user.email : "";
  item.assignedAt = user ? new Date() : null;
  await calendar.save();

  const org = await ClientOrg.findById(calendar.clientOrgId).catch(() => null);
  const company = org?.name || calendar.profile?.companyName || "a client";
  const byName = req.user.name || req.user.email;
  logActivity({
    action: "filing_assigned",
    actor: req.user,
    clientOrgId: calendar.clientOrgId,
    calendarId: calendar._id,
    itemIndex: idx,
    summary: user
      ? `Assigned "${item.compliance_name}" for ${company} to ${item.assignedToName}${before ? ` (was ${before})` : ""}.`
      : `Unassigned "${item.compliance_name}" for ${company}${before ? ` (was ${before})` : ""}.`,
  });

  // Tell the new owner, unless they assigned it to themselves.
  if (user && String(user._id) !== String(req.user._id)) {
    const link = `/calendar.html?id=${calendar._id}#item-${idx}`;
    Notification.create({
      audience: "staff", clientOrgId: calendar.clientOrgId, calendarId: calendar._id, itemIndex: idx,
      type: "filing_assigned", title: `${byName} assigned you: ${item.compliance_name} (${company})`.slice(0, 200),
      body: item.dueDateActual ? `Due ${new Date(item.dueDateActual).toDateString()}.` : "", link, actorName: byName,
    }).catch((err) => console.error("[pipeline] notification failed (non-fatal):", err.message));
    sendEmail({
      to: user.email,
      subject: `Assigned to you: ${item.compliance_name} — ${company}`,
      text: `${byName} assigned "${item.compliance_name}" for ${company} to you.${item.dueDateActual ? `\nDue: ${new Date(item.dueDateActual).toDateString()}` : ""}\n\nOpen: ${process.env.APP_URL || ""}${link}\nYour work: ${process.env.APP_URL || ""}/pipeline.html?owner=me`,
      logPrefix: "[pipeline]",
    }).catch((err) => console.error("[pipeline] email failed (non-fatal):", err.message));
  }

  res.json({ ok: true, assignedTo: user ? { id: String(user._id), name: item.assignedToName } : null });
});

module.exports = router;
module.exports.loadWork = loadWork;
module.exports.teamMembers = teamMembers;
