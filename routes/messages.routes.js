// routes/messages.routes.js
//
// Chat between a client company and the ComplyGlobally team, one thread
// per ClientOrg (see models/Message.js for why it's org-scoped, not
// per-calendar). This single router serves BOTH sides — client accounts
// and staff/admin/super_admin accounts — because the access rule is
// symmetric ("can you see this org's thread?"), just checked
// differently per role, the same pattern documents.js/payments.js in
// this repo were reaching for before they were abandoned mid-build.
//
// Mounted at /api/messages in server.js.

const express = require("express");
const mongoose = require("mongoose");
const Message = require("../models/Message");
const ClientOrg = require("../models/ClientOrg");
const { requireAuth } = require("../middleware/auth");

const router = express.Router();
router.use(requireAuth);

// A client may only ever open their OWN org's thread. Staff/admin/
// super_admin may open any org's thread — this is internal tooling,
// same trust model as calendar.routes.js's staff-any-access endpoints.
// Returns the ClientOrg doc on success so callers don't have to look it
// up twice, or null with the response already sent on failure.
async function authorizeOrgAccess(req, res, clientOrgId) {
  if (!mongoose.Types.ObjectId.isValid(clientOrgId)) {
    res.status(400).json({ error: "Invalid client company id." });
    return null;
  }
  if (req.user.role === "client") {
    if (String(req.user.clientOrgId) !== String(clientOrgId)) {
      res.status(403).json({ error: "Not authorized for this conversation." });
      return null;
    }
  }
  const org = await ClientOrg.findById(clientOrgId);
  if (!org) {
    res.status(404).json({ error: "Client company not found." });
    return null;
  }
  return org;
}

// GET /api/messages/unread/summary
// Client: { count } — unread messages from the team.
// Staff/admin/super_admin: { byClientOrgId: { <id>: count, ... } } —
// unread-from-client counts across every org, for a badge in the
// client directory / calendar list without opening each thread.
// Registered before GET /:clientOrgId even though the two can't
// actually collide (this path has two segments, that route matches
// exactly one) — kept in this order anyway so a future param route
// change can't silently start swallowing this one.
router.get("/unread/summary", async (req, res) => {
  if (req.user.role === "client") {
    const count = await Message.countDocuments({
      clientOrgId: req.user.clientOrgId,
      senderRole: { $ne: "client" },
      readByClient: false,
    });
    return res.json({ count });
  }

  const rows = await Message.aggregate([
    { $match: { senderRole: "client", readByStaff: false } },
    { $group: { _id: "$clientOrgId", count: { $sum: 1 } } },
  ]);
  const byClientOrgId = {};
  rows.forEach((r) => { byClientOrgId[String(r._id)] = r.count; });
  res.json({ byClientOrgId });
});

// GET /api/messages/:clientOrgId — the full thread, oldest first.
// Marks every message from "the other side" as read by whoever is
// fetching, since opening the thread IS reading it.
router.get("/:clientOrgId", async (req, res) => {
  const org = await authorizeOrgAccess(req, res, req.params.clientOrgId);
  if (!org) return;

  const messages = await Message.find({ clientOrgId: org._id }).sort({ createdAt: 1 }).limit(500);

  if (req.user.role === "client") {
    await Message.updateMany(
      { clientOrgId: org._id, senderRole: { $ne: "client" }, readByClient: false },
      { $set: { readByClient: true } }
    );
  } else {
    await Message.updateMany(
      { clientOrgId: org._id, senderRole: "client", readByStaff: false },
      { $set: { readByStaff: true } }
    );
  }

  res.json({ messages, clientOrg: { id: org._id, name: org.name } });
});

// POST /api/messages/:clientOrgId — send one message into the thread.
// body: { body, calendarId?, itemIndex?, itemLabel? }
router.post("/:clientOrgId", async (req, res) => {
  const org = await authorizeOrgAccess(req, res, req.params.clientOrgId);
  if (!org) return;

  const text = (req.body?.body || "").trim();
  if (!text) return res.status(400).json({ error: "Message text is required." });
  if (text.length > 4000) return res.status(400).json({ error: "Message is too long (4000 characters max)." });

  const isClient = req.user.role === "client";
  try {
    const message = await Message.create({
      clientOrgId: org._id,
      senderId: req.user._id,
      senderName: req.user.name || req.user.email,
      senderRole: req.user.role,
      body: text,
      calendarId: req.body?.calendarId || null,
      itemIndex: req.body?.itemIndex !== undefined && req.body?.itemIndex !== null ? Number(req.body.itemIndex) : null,
      itemLabel: typeof req.body?.itemLabel === "string" ? req.body.itemLabel.slice(0, 200) : "",
      // The sender has, by definition, already "read" their own message.
      readByClient: isClient,
      readByStaff: !isClient,
    });
    res.status(201).json({ message });
  } catch (err) {
    console.error("[messages] send error:", err);
    res.status(500).json({ error: "Could not send message." });
  }
});

module.exports = router;
