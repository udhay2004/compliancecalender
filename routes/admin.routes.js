// routes/admin.routes.js
//
// Account and client-org management. Two different permission levels
// live in this one file on purpose, checked per-route rather than with
// one blanket router.use(), because "admin" (tech admin) and
// "super_admin" (the business owner) genuinely have different rights:
//
//   super_admin - can create/edit/deactivate ANY account, including
//                 other admins and super_admins.
//   admin       - can create/edit/deactivate staff and client accounts,
//                 and client orgs, but CANNOT touch admin/super_admin
//                 accounts (so a tech admin can't accidentally — or
//                 deliberately — lock out the business owner, and vice
//                 versa nobody can quietly demote the person meant to
//                 have final say).

const express = require("express");
const User = require("../models/User");
const { normalizePhone } = require("../lib/calendarView");
const ClientOrg = require("../models/ClientOrg");
const Calendar = require("../models/Calendar");
const AuditLog = require("../models/AuditLog");
const { logActivity } = require("../lib/auditLog");
const { requireAuth, requireRole } = require("../middleware/auth");

const router = express.Router();
router.use(requireAuth, requireRole("admin"));

// GET /api/admin/payments-health — "why can't clients pay?" in one click.
// Checks the settings, then asks Razorpay directly: are the keys accepted,
// and will it create an order in our currency? The test order is for the
// smallest amount and is never paid (unpaid orders cost nothing).
router.get("/payments-health", async (req, res) => {
  const { paymentCurrency, currencyProblems, chargeFor, formatCharge, explainRazorpayError } = require("../lib/paymentConfig");
  const keyId = process.env.RAZORPAY_KEY_ID || "";
  const report = {
    currency: paymentCurrency(),
    mode: keyId.startsWith("rzp_live_") ? "live" : keyId.startsWith("rzp_test_") ? "test" : keyId ? "unknown" : null,
    webhookUrl: `${process.env.APP_URL || "<APP_URL>"}/api/webhooks/razorpay`,
    webhookSecretSet: Boolean(process.env.RAZORPAY_WEBHOOK_SECRET),
    appUrlSet: Boolean(process.env.APP_URL),
    steps: [],
    ok: false,
  };
  const add = (name, ok, detail = "", fix = "") => report.steps.push({ name, ok, detail, fix });

  add("API keys are set", Boolean(keyId && process.env.RAZORPAY_KEY_SECRET), "",
    "Add RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET in your host's variables and redeploy.");
  const cp = currencyProblems();
  add(`Currency settings (${report.currency})`, cp.length === 0, cp.join(" "), cp.length ? "Fix the settings above and redeploy." : "");

  if (report.steps.every((s) => s.ok)) {
    const razorpay = require("../config/razorpay");
    try {
      await razorpay.orders.all({ count: 1 });
      add("Razorpay accepts the keys", true, report.mode === "test" ? "These are TEST keys: no real money is collected." : "");
      try {
        const c = chargeFor(100); // US$1.00 (or its rupee equivalent)
        const order = await razorpay.orders.create({ amount: Math.max(c.amount, 100), currency: c.currency, receipt: `healthcheck_${Date.now()}`.slice(0, 40), notes: { purpose: "admin payments check, never paid" } });
        add(`Razorpay can create a ${c.currency} payment`, true, `Test order ${order.id} for ${formatCharge(order.amount, order.currency)} created (never charged).`);
      } catch (err) {
        const why = explainRazorpayError(err);
        add(`Razorpay can create a ${report.currency} payment`, false, `${why.reason} (Razorpay said: ${why.description})`, why.fix);
      }
    } catch (err) {
      const why = explainRazorpayError(err);
      add("Razorpay accepts the keys", false, `${why.reason} (Razorpay said: ${why.description})`, why.fix);
    }
  }
  add("Webhook secret is set", report.webhookSecretSet, report.webhookSecretSet ? "" : "Without it, payments where the client closes the window early are never recorded.",
    `Razorpay → Webhooks → Add webhook: URL ${report.webhookUrl}, events payment.captured, payment.failed, order.paid. Put its secret in RAZORPAY_WEBHOOK_SECRET.`);
  if (!report.appUrlSet) add("APP_URL is set", false, "Needed for the webhook URL and links in emails.", "Set APP_URL to your site's address, e.g. https://yourapp.up.railway.app");

  report.ok = report.steps.every((s) => s.ok);
  res.json(report);
});

// GET /api/admin/storage-health — "is document storage actually working?"
// Uploads, reads back and deletes a tiny test file, then lists client
// documents whose files are missing (e.g. uploaded while files were still
// going to the server's disk) so the team knows whom to ask to re-upload.
router.get("/storage-health", async (req, res) => {
  const storage = require("../lib/storage");
  const Calendar = require("../models/Calendar");
  const report = await storage.healthCheck();

  const calendars = await Calendar.find({ clientOrgId: { $ne: null }, supersededAt: null })
    .select("profile items.compliance_name items.documents")
    .limit(300)
    .lean();
  const docs = [];
  calendars.forEach((c) => c.items.forEach((it, idx) => (it.documents || []).forEach((d) => {
    if (d.fileKey && d.reviewStatus !== "rejected") docs.push({ c, it, idx, d });
  })));
  let missing = new Set();
  if (report.ok) missing = await storage.findMissing(docs.map((x) => x.d.fileKey));
  report.documentsChecked = report.ok ? docs.length : 0;
  report.missingDocuments = docs
    .filter((x) => missing.has(x.d.fileKey))
    .slice(0, 100)
    .map((x) => ({
      calendarId: String(x.c._id),
      company: x.c.profile?.companyName || "(unnamed)",
      filing: x.it.compliance_name,
      fileName: x.d.fileName,
      type: x.d.type,
      uploadedAt: x.d.uploadedAt,
    }));
  res.json(report);
});

// A plain admin may only manage users at "staff" or "client" level.
// super_admin may manage anyone, including other admins/super_admins.
function canManageTargetRole(actingRole, targetRole) {
  if (actingRole === "super_admin") return true;
  return targetRole === "staff" || targetRole === "client";
}

// ---------------------------------------------------------------------
// Client orgs
// ---------------------------------------------------------------------

// POST /api/admin/client-orgs
router.post("/client-orgs", async (req, res) => {
  const { name, primaryContactEmail, primaryContactName, primaryContactPhone, notes } = req.body || {};
  if (!name) return res.status(400).json({ error: "name is required." });
  // Email AND phone are both required for every client company — staff
  // need a way to reach them for document issues and quotes.
  if (!primaryContactEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(primaryContactEmail).trim())) {
    return res.status(400).json({ error: "A valid contact email is required." });
  }
  const phone = normalizePhone(String(primaryContactPhone || ""));
  if (!phone) return res.status(400).json({ error: "A valid contact phone number (with country code) is required." });
  try {
    const org = await ClientOrg.create({
      name,
      primaryContactEmail,
      primaryContactName,
      primaryContactPhone: phone,
      notes,
      createdBy: req.user.email,
    });
    res.status(201).json({ clientOrg: org });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// GET /api/admin/client-orgs
router.get("/client-orgs", async (req, res) => {
  const orgs = await ClientOrg.find().sort({ name: 1 }).populate("assignedStaff", "name email");
  res.json({ clientOrgs: orgs });
});

// PATCH /api/admin/client-orgs/:id — edit contact details and/or set
// which staff member is this client's point of contact (shown to the
// client in the portal — see routes/portal.routes.js's GET /contact).
router.patch("/client-orgs/:id", async (req, res) => {
  const org = await ClientOrg.findById(req.params.id);
  if (!org) return res.status(404).json({ error: "Not found." });

  const { primaryContactName, primaryContactEmail, primaryContactPhone, notes, assignedStaff } = req.body || {};
  if (primaryContactName !== undefined) org.primaryContactName = primaryContactName;
  if (primaryContactEmail !== undefined) org.primaryContactEmail = primaryContactEmail;
  if (primaryContactPhone !== undefined) {
    const phone = normalizePhone(String(primaryContactPhone || ""));
    if (!phone) return res.status(400).json({ error: "A valid contact phone number (with country code) is required." });
    org.primaryContactPhone = phone;
  }
  if (notes !== undefined) org.notes = notes;
  if (assignedStaff !== undefined) {
    if (assignedStaff) {
      const staffUser = await User.findById(assignedStaff);
      if (!staffUser || !User.hasAtLeast(staffUser.role, "staff")) {
        return res.status(400).json({ error: "assignedStaff must be an existing staff, admin, or super_admin account." });
      }
    }
    org.assignedStaff = assignedStaff || null;
  }

  await org.save();
  await org.populate("assignedStaff", "name email");
  res.json({ clientOrg: org });
});

// ---------------------------------------------------------------------
// Users (staff / admin / super_admin / client)
// ---------------------------------------------------------------------

// POST /api/admin/users — create a staff, admin, super_admin, or client account.
router.post("/users", async (req, res) => {
  const { email, password, name, role, clientOrgId } = req.body || {};
  if (!email || !password || !role) {
    return res.status(400).json({ error: "email, password, and role are required." });
  }
  if (!User.ROLES.includes(role) || role === "pending") {
    return res.status(400).json({ error: `role must be one of: client, staff, admin, super_admin` });
  }
  if (!canManageTargetRole(req.user.role, role)) {
    return res.status(403).json({ error: "Only a super_admin can create admin or super_admin accounts." });
  }
  if (role === "client" && !clientOrgId) {
    return res.status(400).json({ error: "clientOrgId is required when role is 'client'." });
  }

  try {
    const user = new User({
      email: email.trim().toLowerCase(),
      name: name || "",
      role,
      clientOrgId: role === "client" ? clientOrgId : null,
    });
    await user.setPassword(password);
    await user.save();
    res.status(201).json({ user: user.toSafeJSON() });
  } catch (err) {
    if (err.code === 11000) return res.status(409).json({ error: "A user with that email already exists." });
    res.status(400).json({ error: err.message });
  }
});

// GET /api/admin/users — optionally ?role=client&clientOrgId=... to filter
router.get("/users", async (req, res) => {
  const filter = {};
  if (req.query.role) filter.role = req.query.role;
  if (req.query.clientOrgId) filter.clientOrgId = req.query.clientOrgId;
  const users = await User.find(filter).sort({ createdAt: -1 });
  res.json({ users: users.map((u) => u.toSafeJSON()) });
});

// PATCH /api/admin/users/:id — deactivate/reactivate, change name, reset password.
// Role changes deliberately go through this same guard, so a plain admin
// still can't promote someone to admin/super_admin (or edit an existing
// admin/super_admin) by hitting this route instead of POST /users.
router.patch("/users/:id", async (req, res) => {
  const target = await User.findById(req.params.id);
  if (!target) return res.status(404).json({ error: "Not found." });
  if (!canManageTargetRole(req.user.role, target.role)) {
    return res.status(403).json({ error: "You don't have permission to modify this account." });
  }

  const { name, active, password, role } = req.body || {};
  const activeChanged = active !== undefined && !!active !== target.active;
  if (name !== undefined) target.name = name;
  if (active !== undefined) target.active = !!active;
  if (role !== undefined) {
    if (!canManageTargetRole(req.user.role, role)) {
      return res.status(403).json({ error: "Only a super_admin can grant admin or super_admin." });
    }
    target.role = role;
  }
  if (password) await target.setPassword(password);

  await target.save();

  if (activeChanged) {
    logActivity({
      action: target.active ? "user_reactivated" : "user_deactivated",
      actor: req.user,
      summary: `${target.active ? "Reactivated" : "Deactivated"} the account for ${target.name || target.email} (${target.role}).`,
      meta: { targetUserId: String(target._id), targetEmail: target.email },
    });
  }

  res.json({ user: target.toSafeJSON() });
});

// ---------------------------------------------------------------------
// Public-tier leads (routes/public.routes.js) — visitors who used the
// free calendar tool and left contact info to unlock the full result.
// Read-only: converting a lead into a real client/ClientOrg is a manual
// step (create the ClientOrg + client account via the routes above,
// same as any other new client) rather than automated, since that
// decision — and any sales conversation before it — should stay a human
// one.
// ---------------------------------------------------------------------

// GET /api/admin/leads — most recent first, only calendars where a
// visitor actually unlocked (leadContact set) — a generated-but-abandoned
// preview is not a lead and isn't included.
router.get("/leads", async (req, res) => {
  const leads = await Calendar.find({ source: "public", leadContact: { $ne: null } })
    .sort({ "leadContact.unlockedAt": -1 })
    .select("profile leadContact createdAt itemCount items")
    .lean();

  res.json({
    leads: leads.map((c) => ({
      id: c._id,
      companyName: c.profile?.companyName || "",
      state: c.profile?.state,
      entityType: c.profile?.entityType,
      itemCount: (c.items || []).length,
      leadContact: c.leadContact,
      generatedAt: c.createdAt,
    })),
  });
});

// ---------------------------------------------------------------------
// Activity log (models/AuditLog.js) — approvals, rejections, document
// reviews, payment events, account access changes. See lib/auditLog.js
// for what's deliberately NOT logged (every field edit would be noise).
// ---------------------------------------------------------------------

// GET /api/admin/activity — most recent first. Optional ?clientOrgId=
// filters to one client's history (used from calendar.html eventually;
// today the admin.html activity tab shows the unfiltered global feed).
router.get("/activity", async (req, res) => {
  const filter = {};
  if (req.query.clientOrgId) filter.clientOrgId = req.query.clientOrgId;
  const entries = await AuditLog.find(filter).sort({ createdAt: -1 }).limit(200);
  res.json({ entries });
});

module.exports = router;
