// routes/calendar.routes.js

const express = require("express");
const Calendar = require("../models/Calendar");
const { requireAuth, requireRole } = require("../middleware/auth");
const { generateCompanyCalendar } = require("../lib/claude");
const { calendarToPdfBuffer } = require("../lib/pdf");
const { upload } = require("../middleware/upload");
const storage = require("../lib/storage");

const router = express.Router();
// Everything in this file is internal tooling (generate/review/approve/
// reject) — staff or more senior only. Client accounts have their own
// separate, much narrower route file (routes/portal.routes.js) and must
// never reach these endpoints even if they guess a URL.
router.use(requireAuth, requireRole("staff"));

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
  if (isRateLimited(req.user.email)) {
    return res.status(429).json({ error: "Rate limit reached. Try again later." });
  }

  const profile = req.body?.profile;
  if (!profile || !profile.state || !profile.entityType) {
    return res.status(400).json({ error: "Missing required profile fields (state, entityType)." });
  }
  // Optional — links this calendar to a client company (models/ClientOrg.js)
  // so it can later appear in that client's portal once approved. Left
  // null for internal/test calendars with no client attached yet.
  const clientOrgId = req.body?.clientOrgId || null;

  try {
    const { items, sourceMode } = await generateCompanyCalendar(profile);
    if (!items.length) {
      return res.status(502).json({ error: "No calendar items returned — try again or refine the profile." });
    }

    const calendar = await Calendar.create({
      createdBy: req.user.email,
      clientOrgId,
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
  const calendars = await Calendar.find({ createdBy: req.user.email })
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
  calendar.reviewedBy = req.user.email;
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
  calendar.reviewedBy = req.user.email;
  calendar.reviewedAt = new Date();
  calendar.reviewNotes = req.body?.notes || "";
  await calendar.save();
  res.json({ calendar });
});

// PATCH /api/calendars/:id/items/:index/status — update the ongoing
// client-facing status of ONE item. Deliberately separate from the
// generic PATCH /items/:index above, which only works pre-approval —
// this one works on APPROVED calendars too, since clientStatus keeps
// changing long after a calendar has been approved (that's the whole
// point of the client portal).
router.patch("/:id/items/:index/status", async (req, res) => {
  const calendar = await Calendar.findById(req.params.id);
  if (!calendar) return res.status(404).json({ error: "Not found." });
  const idx = parseInt(req.params.index, 10);
  if (isNaN(idx) || idx < 0 || idx >= calendar.items.length) {
    return res.status(400).json({ error: "Invalid item index." });
  }

  const { clientStatus, paymentStatus, dueDateActual } = req.body || {};
  const item = calendar.items[idx];
  if (clientStatus !== undefined) {
    if (!Calendar.schema.path("items").schema.path("clientStatus").enumValues.includes(clientStatus)) {
      return res.status(400).json({ error: "Invalid clientStatus value." });
    }
    item.clientStatus = clientStatus;
  }
  if (paymentStatus !== undefined) {
    if (!Calendar.schema.path("items").schema.path("paymentStatus").enumValues.includes(paymentStatus)) {
      return res.status(400).json({ error: "Invalid paymentStatus value." });
    }
    item.paymentStatus = paymentStatus;
  }
  if (dueDateActual !== undefined) {
    const parsed = dueDateActual ? new Date(dueDateActual) : null;
    if (dueDateActual && isNaN(parsed.getTime())) {
      return res.status(400).json({ error: "dueDateActual must be a valid date." });
    }
    item.dueDateActual = parsed;
  }

  await calendar.save();
  res.json({ calendar });
});

// POST /api/calendars/:id/items/:index/certificate — staff uploads the
// filed certificate/acknowledgment for one item, which immediately
// becomes visible to the client in the portal. This is the "status
// shared with them" loop closing on the staff side.
router.post("/:id/items/:index/certificate", upload.single("file"), async (req, res) => {
  const calendar = await Calendar.findById(req.params.id);
  if (!calendar) return res.status(404).json({ error: "Not found." });
  const idx = parseInt(req.params.index, 10);
  if (isNaN(idx) || idx < 0 || idx >= calendar.items.length) {
    return res.status(400).json({ error: "Invalid item index." });
  }
  if (!req.file) return res.status(400).json({ error: "No file uploaded (field name must be 'file')." });

  try {
    const { fileKey, fileUrl } = await storage.saveFile({
      buffer: req.file.buffer,
      fileName: req.file.originalname,
    });
    calendar.items[idx].documents.push({
      fileKey,
      fileUrl,
      fileName: req.file.originalname,
      uploadedBy: req.user.email,
      type: "certificate",
    });
    // Uploading the certificate is the natural "this is done" signal —
    // auto-advance status, but staff can still override it manually via
    // PATCH .../status if that's wrong for a given item.
    calendar.items[idx].clientStatus = "Filed";
    await calendar.save();
    res.status(201).json({ calendar });
  } catch (err) {
    console.error("Certificate upload error:", err);
    res.status(500).json({ error: "Could not save the uploaded file." });
  }
});

// GET /api/calendars/:id/items/:index/documents/:docIndex/download — any
// staff member can download any document on any calendar (internal
// tooling, no per-client scoping needed here — that scoping lives in
// routes/portal.routes.js instead, for client accounts).
router.get("/:id/items/:index/documents/:docIndex/download", async (req, res) => {
  const calendar = await Calendar.findById(req.params.id);
  if (!calendar) return res.status(404).json({ error: "Not found." });
  const idx = parseInt(req.params.index, 10);
  const docIdx = parseInt(req.params.docIndex, 10);
  const item = calendar.items[idx];
  const doc = item && item.documents[docIdx];
  if (!doc) return res.status(404).json({ error: "Document not found." });

  const stream = storage.getFileStream(doc.fileKey);
  if (!stream) return res.status(404).json({ error: "File is missing from storage." });
  res.setHeader("Content-Disposition", `attachment; filename="${doc.fileName}"`);
  stream.pipe(res);
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
