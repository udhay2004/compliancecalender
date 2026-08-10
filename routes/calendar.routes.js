// routes/calendar.routes.js

const express = require("express");
const Calendar = require("../models/Calendar");
const { requireAuth } = require("../middleware/auth");
const { generateCompanyCalendar } = require("../lib/claude");
const { calendarToPdfBuffer } = require("../lib/pdf");

const router = express.Router();
router.use(requireAuth);

// Extremely basic in-memory rate limit, kept from the original app —
// still useful even with auth, so one account can't accidentally burn
// through the whole team's Anthropic budget.
const RATE_LIMIT = 20;
const hits = new Map(); // userId -> [timestamps]
function isRateLimited(userId) {
  const now = Date.now();
  const windowMs = 60 * 60 * 1000;
  const arr = (hits.get(userId) || []).filter((t) => now - t < windowMs);
  arr.push(now);
  hits.set(userId, arr);
  return arr.length > RATE_LIMIT;
}

// POST /api/calendars/generate
// Creates a new calendar in "pending_review" — it is NOT the source of
// truth until a reviewer approves it.
router.post("/generate", async (req, res) => {
  if (isRateLimited(req.user.username)) {
    return res.status(429).json({ error: "Rate limit reached. Try again later." });
  }

  const profile = req.body?.profile;
  if (!profile || !profile.state || !profile.entityType) {
    return res.status(400).json({ error: "Missing required profile fields (state, entityType)." });
  }

  try {
    const { items, sourceMode } = await generateCompanyCalendar(profile);
    if (!items.length) {
      return res.status(502).json({ error: "No calendar items returned — try again or refine the profile." });
    }

    const calendar = await Calendar.create({
      createdBy: req.user.username,
      profile,
      items,
      status: "pending_review",
      sourceMode,
    });

    return res.status(201).json({ calendar });
  } catch (err) {
    console.error("Generate error:", err);
    return res.status(502).json({ error: `Research request failed: ${err.message}` });
  }
});

// GET /api/calendars/mine — calendars the current user created
router.get("/mine", async (req, res) => {
  const calendars = await Calendar.find({ createdBy: req.user.username })
    .sort({ createdAt: -1 });
  res.json({ calendars });
});

// GET /api/calendars/queue — everything pending review (any teammate can review)
router.get("/queue", async (req, res) => {
  const calendars = await Calendar.find({ status: "pending_review" })
    .sort({ createdAt: 1 });
  res.json({ calendars });
});

// GET /api/calendars/approved — the trusted, approved library
router.get("/approved", async (req, res) => {
  const calendars = await Calendar.find({ status: "approved" })
    .sort({ reviewedAt: -1 });
  res.json({ calendars });
});

// GET /api/calendars/:id
router.get("/:id", async (req, res) => {
  const calendar = await Calendar.findById(req.params.id);
  if (!calendar) return res.status(404).json({ error: "Not found." });
  res.json({ calendar });
});

// PATCH /api/calendars/:id/items/:index — reviewer edits one line item
router.patch("/:id/items/:index", async (req, res) => {
  const calendar = await Calendar.findById(req.params.id);
  if (!calendar) return res.status(404).json({ error: "Not found." });
  if (calendar.status !== "pending_review") {
    return res.status(400).json({ error: "Only pending_review calendars can be edited." });
  }
  const idx = parseInt(req.params.index, 10);
  if (isNaN(idx) || idx < 0 || idx >= calendar.items.length) {
    return res.status(400).json({ error: "Invalid item index." });
  }

  const allowedFields = [
    "category",
    "compliance_name",
    "due_date",
    "applicable_to",
    "description",
    "authority",
    "source_url",
    "confidence",
  ];
  const updates = req.body || {};
  allowedFields.forEach((f) => {
    if (updates[f] !== undefined) calendar.items[idx][f] = updates[f];
  });
  calendar.items[idx].editedByReviewer = true;

  await calendar.save();
  res.json({ calendar });
});

// POST /api/calendars/:id/approve
router.post("/:id/approve", async (req, res) => {
  const calendar = await Calendar.findById(req.params.id);
  if (!calendar) return res.status(404).json({ error: "Not found." });
  if (calendar.status !== "pending_review") {
    return res.status(400).json({ error: "Only pending_review calendars can be approved." });
  }
  calendar.status = "approved";
  calendar.reviewedBy = req.user.username;
  calendar.reviewedAt = new Date();
  calendar.reviewNotes = req.body?.notes || "";
  await calendar.save();
  res.json({ calendar });
});

// POST /api/calendars/:id/reject
router.post("/:id/reject", async (req, res) => {
  const calendar = await Calendar.findById(req.params.id);
  if (!calendar) return res.status(404).json({ error: "Not found." });
  if (calendar.status !== "pending_review") {
    return res.status(400).json({ error: "Only pending_review calendars can be rejected." });
  }
  calendar.status = "rejected";
  calendar.reviewedBy = req.user.username;
  calendar.reviewedAt = new Date();
  calendar.reviewNotes = req.body?.notes || "";
  await calendar.save();
  res.json({ calendar });
});

// GET /api/calendars/:id/pdf — download, works for any status (draft PDFs
// are watermarked "NOT reviewed" inside lib/pdf.js)
router.get("/:id/pdf", async (req, res) => {
  const calendar = await Calendar.findById(req.params.id);
  if (!calendar) return res.status(404).json({ error: "Not found." });
  try {
    const buffer = await calendarToPdfBuffer(calendar);
    const safeName = (calendar.profile.companyName || "compliance-calendar").replace(/[^a-z0-9]+/gi, "-");
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${safeName}.pdf"`);
    res.send(buffer);
  } catch (err) {
    console.error("PDF generation error:", err);
    res.status(500).json({ error: "Could not generate PDF." });
  }
});

module.exports = router;
