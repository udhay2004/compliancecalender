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
const ClientOrg = require("../models/ClientOrg");
const { requireAuth, requireClientRole } = require("../middleware/auth");
const { upload } = require("../middleware/upload");
const storage = require("../lib/storage");
const { getRequiredDocuments } = require("../lib/requiredDocuments");
const { getSuggestedFee } = require("../lib/complianceFees");
const { sendEmail } = require("../lib/mailer");

const router = express.Router();
router.use(requireAuth, requireClientRole);

// Attaches a `requiredDocuments` array to every item, PLUS a calendar-
// level `sharedDocumentIndex` (label -> where a matching upload already
// exists anywhere in this calendar). This is what makes reuse work: a
// document uploaded against "Franchise Tax" that happens to also satisfy
// "Annual Report" (both need "EIN Confirmation Letter", say) shows up as
// already-done on Annual Report's checklist too, without the client
// uploading it twice. Matching is purely by label text — same reasoning
// as requirementLabel itself (see models/Calendar.js): a stable, human-
// readable string, not a foreign key, so it's easy to reason about and
// easy to extend.
// Attaches a `requiredDocuments` array to every item, PLUS a calendar-
// level `sharedDocumentIndex` (label -> where a matching upload already
// exists anywhere in this calendar). This is what makes reuse work: a
// document uploaded against "Franchise Tax" that happens to also satisfy
// "Annual Report" (both need "EIN Confirmation Letter", say) shows up as
// already-done on Annual Report's checklist too, without the client
// uploading it twice. Matching is purely by label text — same reasoning
// as requirementLabel itself (see models/Calendar.js): a stable, human-
// readable string, not a foreign key, so it's easy to reason about and
// easy to extend. A REJECTED upload (see reviewStatus on the document
// sub-schema) is deliberately excluded here — staff said "this isn't
// valid", so it must not silently keep satisfying the checklist, on
// this item or any other one it happened to be shared with.
function withRequiredDocuments(calendar) {
  const obj = calendar.toObject ? calendar.toObject() : calendar;

  const sharedDocumentIndex = {};
  (obj.items || []).forEach((item, itemIndex) => {
    (item.documents || []).forEach((doc, docIndex) => {
      if (
        doc.type === "client_upload" &&
        doc.requirementLabel &&
        doc.reviewStatus !== "rejected" &&
        !sharedDocumentIndex[doc.requirementLabel]
      ) {
        sharedDocumentIndex[doc.requirementLabel] = {
          itemIndex,
          docIndex,
          fileName: doc.fileName,
          compliance_name: item.compliance_name,
        };
      }
    });
  });

  obj.items = (obj.items || []).map((item) => ({
    ...item,
    requiredDocuments: getRequiredDocuments(item),
    // For items with no fee set yet, pass through the price list's
    // client-facing line (lib/complianceFees.js) so the portal can say
    // something meaningful instead of leaving a blank space where a
    // price would go. Never exposes the internal `note` or the
    // suggested amount — those are staff-only.
    feeMessage: item.feeAmountCents ? null : (getSuggestedFee(item)?.customerMessage || null),
  }));
  obj.sharedDocumentIndex = sharedDocumentIndex;
  return obj;
}

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
  res.json({ calendars: calendars.map(withRequiredDocuments) });
});

// GET /api/portal/calendars/pending — READ-ONLY. A client whose calendar
// was just linked to their account (e.g. via the "Start Filing" Google
// login flow in routes/auth.routes.js) needs SOME signal that something
// is happening, rather than an empty portal that looks broken. This
// deliberately does NOT support upload/document routes — those still
// only work on approved calendars via findOwnApprovedCalendar below —
// so the staff-review gate stays exactly as strict as it was before.
router.get("/calendars/pending", async (req, res) => {
  const calendars = await Calendar.find({
    clientOrgId: req.user.clientOrgId,
    status: "pending_review",
  })
    .select("profile createdAt items")
    .sort({ createdAt: -1 });
  res.json({ calendars });
});

// GET /api/portal/calendars/:id
router.get("/calendars/:id", async (req, res) => {
  const calendar = await findOwnApprovedCalendar(req, req.params.id);
  if (!calendar) return res.status(404).json({ error: "Not found." });
  res.json({ calendar: withRequiredDocuments(calendar) });
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
    // requirementLabel is set by the portal UI to say WHICH checklist row
    // this upload satisfies (e.g. "Registered Agent Consent Letter" — see
    // lib/requiredDocuments.js). Not required/validated against the
    // lookup table server-side: it's a display/checklist-matching hint,
    // not an access-control value, so a stale or unrecognized label just
    // means that one row won't show a tick — it never blocks the upload
    // itself from succeeding.
    const requirementLabel = typeof req.body.requirementLabel === "string" ? req.body.requirementLabel.slice(0, 200) : "";
    item.documents.push({
      fileKey,
      fileUrl,
      fileName: req.file.originalname,
      uploadedBy: req.user.email,
      type: "client_upload",
      requirementLabel,
    });
    // Client uploading something is the "I've given you what you asked
    // for" signal — moves the item into staff's queue for review. Staff
    // can still set it back via PATCH /api/calendars/:id/items/:index/status.
    if (item.clientStatus === "Not Started" || item.clientStatus === "Awaiting Documents") {
      item.clientStatus = "Under Review";
    }
    await calendar.save();
    res.status(201).json({ calendar: withRequiredDocuments(calendar) });

    // Best-effort — never block the upload response on this. Tells
    // whoever is this client's point of contact (or the general ops
    // inbox if nobody's assigned yet) that something showed up to
    // review, the same "new lead" notification pattern already used in
    // routes/public.routes.js, just pointed at a different event.
    ClientOrg.findById(req.user.clientOrgId)
      .populate("assignedStaff", "email name")
      .then((org) => {
        const to = org?.assignedStaff?.email || process.env.ADMIN_EMAIL;
        if (!to) return;
        return sendEmail({
          to,
          subject: `New document uploaded: ${org?.name || "a client"} — ${item.compliance_name}`,
          text:
            `${req.user.name || req.user.email} uploaded "${req.file.originalname}" for ${item.compliance_name}` +
            (requirementLabel ? ` (${requirementLabel})` : "") +
            `.\n\nReview it here: ${process.env.APP_URL || ""}/calendar.html?id=${calendar._id}`,
          logPrefix: "[client upload]",
        });
      })
      .catch((err) => console.error("[client upload] staff notification failed (non-fatal):", err.message));
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

  const stream = await storage.getFileStream(doc.fileKey);
  if (!stream) return res.status(404).json({ error: "File is missing from storage." });
  res.setHeader("Content-Disposition", `attachment; filename="${doc.fileName}"`);
  stream.pipe(res);
});

// GET /api/portal/contact — who to reach for help: the staff member
// assigned to this client's org (see ClientOrg.assignedStaff), if any,
// plus ComplyGlobally's general contact details as an always-available
// fallback. Configure the fallback via SUPPORT_EMAIL / SUPPORT_PHONE in
// .env — see .env.example.
router.get("/contact", async (req, res) => {
  const org = await ClientOrg.findById(req.user.clientOrgId).populate("assignedStaff", "name email");
  res.json({
    yourContact: org?.assignedStaff ? { name: org.assignedStaff.name, email: org.assignedStaff.email } : null,
    company: {
      name: "ComplyGlobally",
      email: process.env.SUPPORT_EMAIL || "support@complyglobally.com",
      phone: process.env.SUPPORT_PHONE || "",
    },
  });
});

module.exports = router;
