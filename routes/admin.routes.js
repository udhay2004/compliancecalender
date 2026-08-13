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
const ClientOrg = require("../models/ClientOrg");
const { requireAuth, requireRole } = require("../middleware/auth");

const router = express.Router();
router.use(requireAuth, requireRole("admin"));

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
  const { name, primaryContactEmail, primaryContactName, notes } = req.body || {};
  if (!name) return res.status(400).json({ error: "name is required." });
  try {
    const org = await ClientOrg.create({
      name,
      primaryContactEmail,
      primaryContactName,
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
  const orgs = await ClientOrg.find().sort({ name: 1 });
  res.json({ clientOrgs: orgs });
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
  if (!User.ROLES.includes(role)) {
    return res.status(400).json({ error: `role must be one of: ${User.ROLES.join(", ")}` });
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
  res.json({ user: target.toSafeJSON() });
});

module.exports = router;
