// routes/leads.routes.js
//
// GET /api/leads — everyone who generated a calendar on the public page
// (routes/public.routes.js), newest first, for the whole internal team:
// super_admin, admin and every staff team (tech, finance, operations).
//
// A "lead" is a Calendar with source "public" and leadContact set. When
// the visitor's portal account is created the calendar is claimed into
// their company (clientOrgId set) but stays source "public", so the list
// covers both: people who never came back and people who are now clients.
//
// Read-only. The older GET /api/admin/leads (admin and up) is unchanged.

const express = require("express");
const Calendar = require("../models/Calendar");
const User = require("../models/User");
const { requireAuth, requireRole } = require("../middleware/auth");

const router = express.Router();
router.use(requireAuth, requireRole("staff"));

const MAX_ROWS = 500;
const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** One lead row from a calendar and (if any) its portal account. */
function leadRow(c, user) {
  const lead = c.leadContact || {};
  const items = c.items || [];
  return {
    calendarId: String(c._id),
    name: lead.name || "",
    email: lead.email || "",
    phone: lead.phone || "",
    company: c.profile?.companyName || "",
    country: c.profile?.country || "United States",
    state: c.profile?.state || "",
    entityType: c.profile?.entityType || "",
    filings: items.length,
    servicesChosen: items.filter((i) => i.selectedByClient).length,
    paid: items.filter((i) => i.paymentStatus === "Paid").length,
    generatedAt: lead.unlockedAt || c.createdAt,
    hasAccount: Boolean(user),
    signedInAt: user?.lastLoginAt || null,
    clientOrgId: c.clientOrgId ? String(c.clientOrgId) : null,
  };
}

router.get("/", async (req, res) => {
  const q = { source: "public", leadContact: { $ne: null } };
  const search = typeof req.query.q === "string" ? req.query.q.trim().slice(0, 100) : "";
  if (search) {
    const re = new RegExp(escapeRegex(search), "i");
    q.$or = [
      { "leadContact.name": re },
      { "leadContact.email": re },
      { "leadContact.phone": re },
      { "profile.companyName": re },
      { "profile.state": re },
    ];
  }

  const calendars = await Calendar.find(q)
    .sort({ createdAt: -1 })
    .select("profile leadContact createdAt clientOrgId items.selectedByClient items.paymentStatus")
    .limit(MAX_ROWS)
    .lean();

  const emails = [...new Set(calendars.map((c) => c.leadContact?.email).filter(Boolean))];
  const users = emails.length
    ? await User.find({ email: { $in: emails }, role: "client" }).select("email lastLoginAt").lean()
    : [];
  const byEmail = new Map(users.map((u) => [u.email, u]));

  const leads = calendars.map((c) => leadRow(c, byEmail.get(c.leadContact?.email)));
  const weekAgo = Date.now() - 7 * 86400000;
  res.json({
    leads,
    truncated: calendars.length === MAX_ROWS,
    counts: {
      total: leads.length,
      lastWeek: leads.filter((l) => new Date(l.generatedAt).getTime() >= weekAgo).length,
      signedIn: leads.filter((l) => l.signedInAt).length,
      choseServices: leads.filter((l) => l.servicesChosen > 0).length,
    },
  });
});

module.exports = router;
module.exports._internals = { leadRow };
