// routes/notifications.routes.js
//
// The bell. Same endpoints for both sides; what you get back is decided
// entirely server-side from req.user — a client can never ask for staff
// notifications or another org's notifications by changing a parameter.

const express = require("express");
const mongoose = require("mongoose");
const Notification = require("../models/Notification");
const { requireAuth } = require("../middleware/auth");

const router = express.Router();
router.use(requireAuth);

function scopeFor(user) {
  if (user.role === "client") {
    return { audience: "client", clientOrgId: user.clientOrgId };
  }
  return { audience: "staff" };
}

// GET /api/notifications?limit=20
router.get("/", async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 20, 100);
  const scope = scopeFor(req.user);
  const [rows, unread] = await Promise.all([
    Notification.find(scope).sort({ createdAt: -1 }).limit(limit).lean(),
    Notification.countDocuments({ ...scope, readBy: { $ne: req.user._id } }),
  ]);
  const me = String(req.user._id);
  res.json({
    unread,
    notifications: rows.map((n) => ({
      id: String(n._id),
      type: n.type,
      title: n.title,
      body: n.body,
      link: n.link,
      actorName: n.actorName,
      createdAt: n.createdAt,
      read: (n.readBy || []).some((id) => String(id) === me),
    })),
  });
});

// POST /api/notifications/read-all
router.post("/read-all", async (req, res) => {
  await Notification.updateMany(
    { ...scopeFor(req.user), readBy: { $ne: req.user._id } },
    { $addToSet: { readBy: req.user._id } }
  );
  res.json({ ok: true });
});

// POST /api/notifications/:id/read
router.post("/:id/read", async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: "Invalid id." });
  await Notification.updateOne(
    { _id: req.params.id, ...scopeFor(req.user) },
    { $addToSet: { readBy: req.user._id } }
  );
  res.json({ ok: true });
});

module.exports = router;
