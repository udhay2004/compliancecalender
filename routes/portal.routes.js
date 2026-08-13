// routes/portal.routes.js
//
// Client-facing API. Every single route here MUST filter by
// req.user.clientOrgId — never trust a calendarId alone, or one client
// could view another client's documents by guessing/changing a URL.
// This file is deliberately much narrower than calendar.routes.js: a
// client can view their own APPROVED calendar and upload documents
// against it, and that's it. No generate, no review, no approve, no
// visibility into other clients or pending_review calendars.

const express = require("express");
const Calendar = require("../models/Calendar");
const { requireAuth, requireClientRole } = require("../middleware/auth");
const { upload } = require("../middleware/upload");
const storage = require("../lib/storage");

const router = express.Router();
router.use(requireAuth, requireClientRole);

// Every route below finds the calendar via this helper, which builds the
// ownership check directly into the query — so a route can never
// "forget" to check clientOrgId, the query simply returns nothing for
// a calendar that isn't theirs.
function findOwnApprovedCalendar(req, calendarId) {
  return Calendar.findOne({
    _id: calendarId,
    clientOrgId: req.user.clientOrgId,
    status: "approved",
  });
}

// GET /api/portal/calendars — every approved calendar belonging to this
// client's org (usually one, but a client could have more than one
// entity under the same login in the future).
router.get("/calendars", async (req, res) => {
  const calendars = await Calendar.find({
    clientOrgId: req.user.clientOrgId,
    status: "approved",
  }).sort({ reviewedAt: -1 });
  res.json({ calendars });
});

// GET /api/portal/calendars/:id
router.get("/calendars/:id", async (req, res) => {
  const calendar = await findOwnApprovedCalendar(req, req.params.id);
  if (!calendar) return res.status(404).json({ error: "Not found." });
  res.json({ calendar });
});

// POST /api/portal/calendars/:id/items/:index/upload — client uploads a
// document as proof/support for one compliance item.
router.post("/calendars/:id/items/:index/upload", upload.single("file"), async (req, res) => {
  const calendar = await findOwnApprovedCalendar(req, req.params.id);
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
    const item = calendar.items[idx];
    item.documents.push({
      fileKey,
      fileUrl,
      fileName: req.file.originalname,
      uploadedBy: req.user.email,
      type: "client_upload",
    });
    // Client uploading something is the "I've given you what you asked
    // for" signal — moves the item into staff's queue for review. Staff
    // can still set it back via PATCH /api/calendars/:id/items/:index/status.
    if (item.clientStatus === "Not Started" || item.clientStatus === "Awaiting Documents") {
      item.clientStatus = "Under Review";
    }
    await calendar.save();
    res.status(201).json({ calendar });
  } catch (err) {
    console.error("Client upload error:", err);
    res.status(500).json({ error: "Could not save the uploaded file." });
  }
});

// GET /api/portal/calendars/:id/items/:index/documents/:docIndex/download
router.get("/calendars/:id/items/:index/documents/:docIndex/download", async (req, res) => {
  const calendar = await findOwnApprovedCalendar(req, req.params.id);
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

module.exports = router;
