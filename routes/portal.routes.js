// routes/portal.routes.js
//
// Client-facing API. Every single route here MUST filter by
// req.user.clientOrgId — never trust a calendarId alone, or one client
// could view another client's documents by guessing/changing a URL.
// A client can:
//   - see every calendar ever generated for their company (current + history)
//   - keep their contact details up to date (email AND phone are required
//     before any work-creating action — see requireCompleteContact)
//   - pick which services they want ComplyGlobally to handle
//   - upload documents, see the price for each service, pay
//   - regenerate their calendar when their company details change
// No review, no approve, no visibility into other clients.

const express = require("express");
const mongoose = require("mongoose");
const Calendar = require("../models/Calendar");
const ClientOrg = require("../models/ClientOrg");
const { requireAuth, requireClientRole } = require("../middleware/auth");
const { upload } = require("../middleware/upload");
const storage = require("../lib/storage");
const { generateCompanyCalendar } = require("../lib/claude");
const { toView, missingContactFields, normalizePhone, missingKeysFor } = require("../lib/calendarView");
const { sendStoredFile } = require("../lib/download");
const { notifyStaff, notifyClient } = require("../lib/notify");
const { applyListPrice, removeListPrice, PRICE_LIST_ACTOR, formatUSD } = require("../lib/complianceFees");
const { logActivity } = require("../lib/auditLog");
const whatsapp = require("../lib/whatsapp");
const { orgIcs, feedLinksFor } = require("./feeds.routes");
const { sendIcs } = require("../lib/ics");

const router = express.Router();
router.use(requireAuth, requireClientRole);

// Async: a document whose file was lost shows as "please upload again".
const clientView = async (calendar) => toView(calendar, { staff: false, missingKeys: await missingKeysFor(calendar) });

function staffLink(calendarId) {
  return `/calendar.html?id=${calendarId}`;
}

// Every route below finds the calendar via this helper, which builds the
// ownership check directly into the query — so a route can never
// "forget" to check clientOrgId, the query simply returns nothing for
// a calendar that isn't theirs.
function findOwnApprovedCalendar(req, calendarId) {
  if (!mongoose.isValidObjectId(calendarId)) return Promise.resolve(null);
  return Calendar.findOne({
    _id: calendarId,
    clientOrgId: req.user.clientOrgId,
    status: "approved",
  });
}

function parseItemIndex(calendar, raw) {
  const idx = parseInt(raw, 10);
  if (isNaN(idx) || idx < 0 || idx >= calendar.items.length) return null;
  return idx;
}

// Blocks work-creating actions until the company has both an email and a
// phone number on file. The portal shows a "complete your details" form
// when it gets this error code, so the client is never stuck guessing.
async function requireCompleteContact(req, res, next) {
  const org = await ClientOrg.findById(req.user.clientOrgId);
  const missing = missingContactFields(org);
  if (missing.length) {
    return res.status(409).json({
      error: `Please add your ${missing.join(" and ")} before continuing.`,
      code: "CONTACT_INCOMPLETE",
      missing,
    });
  }
  req.clientOrg = org;
  next();
}

// ---------------------------------------------------------------------
// Profile / contact details
// ---------------------------------------------------------------------

function profilePayload(org, user) {
  return {
    companyName: org?.name || "",
    contactName: org?.primaryContactName || user.name || "",
    email: org?.primaryContactEmail || "",
    phone: org?.primaryContactPhone || "",
    billingAddress: org?.billingAddress || "",
    loginEmail: user.email,
    missing: missingContactFields(org),
    whatsapp: {
      // The portal only offers WhatsApp once it's actually set up.
      available: whatsapp.isConfigured(),
      on: Boolean(org?.whatsappOptIn),
      number: whatsapp.displayNumber(org?.whatsappNumber || ""),
      // What we'd use if they switch it on now.
      suggestedNumber: whatsapp.displayNumber(whatsapp.toWhatsAppNumber(org?.primaryContactPhone || "") || ""),
      problem: org?.whatsappOptIn ? org?.whatsappLastError || "" : "",
    },
  };
}

// GET /api/portal/profile
router.get("/profile", async (req, res) => {
  const org = await ClientOrg.findById(req.user.clientOrgId);
  res.json({ profile: profilePayload(org, req.user) });
});

// PATCH /api/portal/profile  { companyName?, contactName?, email?, phone? }
router.patch("/profile", async (req, res) => {
  const org = await ClientOrg.findById(req.user.clientOrgId);
  if (!org) return res.status(404).json({ error: "Company not found." });
  const { companyName, contactName, email, phone, billingAddress, whatsappOn, whatsappNumber } = req.body || {};
  const changed = [];
  let whatsappWelcome = false;

  if (companyName !== undefined) {
    const v = String(companyName).trim().slice(0, 200);
    if (!v) return res.status(400).json({ error: "Company name can't be empty." });
    if (v !== org.name) { org.name = v; changed.push("company name"); }
  }
  if (contactName !== undefined) {
    const v = String(contactName).trim().slice(0, 200);
    if (v !== org.primaryContactName) { org.primaryContactName = v; changed.push("contact name"); }
  }
  if (email !== undefined) {
    const v = String(email).trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) return res.status(400).json({ error: "Enter a valid email address." });
    if (v !== org.primaryContactEmail) { org.primaryContactEmail = v; changed.push("email"); }
  }
  if (phone !== undefined) {
    const v = normalizePhone(String(phone));
    if (!v) return res.status(400).json({ error: "Enter a valid phone number, including the country code (e.g. +1 415 555 0100)." });
    if (v !== org.primaryContactPhone) { org.primaryContactPhone = v; changed.push("phone"); }
  }
  if (billingAddress !== undefined) {
    const v = String(billingAddress).trim().slice(0, 500);
    if (v !== (org.billingAddress || "")) { org.billingAddress = v; changed.push("billing address"); }
  }
  // WhatsApp: only the client can switch it on (their consent), for a
  // number with a country code. Defaults to their contact phone.
  if (whatsappOn === false && org.whatsappOptIn) {
    org.whatsappOptIn = false;
    org.whatsappOptOutAt = new Date();
    changed.push("WhatsApp off");
    logActivity({ action: "whatsapp_opt_out", actor: req.user, clientOrgId: org._id, summary: `${org.name} switched off WhatsApp messages in the portal.` });
  } else if (whatsappOn === true) {
    if (!whatsapp.isConfigured()) return res.status(400).json({ error: "WhatsApp messages aren't available yet." });
    const raw = whatsappNumber !== undefined && String(whatsappNumber).trim() ? String(whatsappNumber) : org.primaryContactPhone;
    const digits = whatsapp.toWhatsAppNumber(raw || "");
    if (!digits) return res.status(400).json({ error: "Enter your WhatsApp number with the country code, starting with + (e.g. +1 415 555 0100)." });
    const clash = await ClientOrg.findOne({ whatsappNumber: digits, _id: { $ne: org._id } });
    if (clash) return res.status(409).json({ error: "That WhatsApp number is already used by another company account. Please use a different number or contact us." });
    if (!org.whatsappOptIn || org.whatsappNumber !== digits) {
      whatsappWelcome = true;
      changed.push("WhatsApp on");
      logActivity({ action: "whatsapp_opt_in", actor: req.user, clientOrgId: org._id, summary: `${org.name} switched on WhatsApp messages to +${digits} in the portal.`, meta: { number: digits } });
    }
    org.whatsappOptIn = true;
    org.whatsappNumber = digits;
    org.whatsappOptInAt = whatsappWelcome ? new Date() : org.whatsappOptInAt;
    org.whatsappLastError = whatsappWelcome ? "" : org.whatsappLastError;
  }

  // Belt and braces: never let an update leave the org without an email
  // or phone — this route is the only way a client can change them.
  const stillMissing = missingContactFields(org);
  if (stillMissing.length) {
    return res.status(400).json({ error: `Your ${stillMissing.join(" and ")} is required.`, missing: stillMissing });
  }

  await org.save();
  let whatsappTest = null;
  if (whatsappWelcome) {
    // A confirmation message, so they know it works (and we find out now
    // if it doesn't, rather than on the day of a deadline).
    whatsappTest = await whatsapp.sendToOrg(org, "update", [`WhatsApp reminders are now on for ${org.name}. Reply STOP at any time to turn them off`]);
  }
  if (changed.length) {
    notifyStaff({
      clientOrgId: org._id,
      type: "profile_updated",
      title: `${org.name} updated their contact details`,
      body: `Changed: ${changed.join(", ")}.`,
      link: "/admin.html",
      actorName: req.user.name || req.user.email,
      email: false,
    });
  }
  res.json({
    profile: profilePayload(org, req.user),
    ...(whatsappTest ? { whatsappTest: { ok: Boolean(whatsappTest.ok), error: whatsappTest.ok ? "" : whatsappTest.error || "" } } : {}),
  });
});

// ---------------------------------------------------------------------
// Calendar export: .ics download and subscription link (lib/ics.js)
// ---------------------------------------------------------------------

// GET /api/portal/calendar.ics[?calendar=<id>] — download every deadline
// (or one entity's) as a file for Google/Outlook/Apple Calendar.
router.get("/calendar.ics", async (req, res) => {
  const org = await ClientOrg.findById(req.user.clientOrgId);
  if (!org) return res.status(404).json({ error: "Company not found." });
  const calendarId = req.query.calendar && mongoose.isValidObjectId(req.query.calendar) ? req.query.calendar : null;
  sendIcs(res, await orgIcs(org, { calendarId }), `${org.name}-deadlines`);
});

// GET /api/portal/calendar-feed — the private subscription link (created
// the first time it's asked for).
router.get("/calendar-feed", async (req, res) => {
  const org = await ClientOrg.findById(req.user.clientOrgId);
  if (!org) return res.status(404).json({ error: "Company not found." });
  res.json({ feed: await feedLinksFor(org, { kind: "client", name: `${org.name} deadlines` }) });
});

// POST /api/portal/calendar-feed/reset — new link; the old one stops working.
router.post("/calendar-feed/reset", async (req, res) => {
  const org = await ClientOrg.findById(req.user.clientOrgId);
  if (!org) return res.status(404).json({ error: "Company not found." });
  res.json({ feed: await feedLinksFor(org, { kind: "client", name: `${org.name} deadlines`, reset: true }) });
});

// ---------------------------------------------------------------------
// Calendars
// ---------------------------------------------------------------------

// GET /api/portal/calendars — every approved calendar belonging to this
// client's org, CURRENT first (not superseded), then history newest
// first. Nothing a client ever generated is dropped from here.
router.get("/calendars", async (req, res) => {
  const calendars = await Calendar.find({
    clientOrgId: req.user.clientOrgId,
    status: "approved",
  }).sort({ supersededAt: 1, createdAt: -1 });
  const views = await Promise.all(calendars.map(clientView));
  views.sort((a, b) => (a.supersededAt ? 1 : 0) - (b.supersededAt ? 1 : 0) || new Date(b.createdAt) - new Date(a.createdAt));
  res.json({ calendars: views });
});

// GET /api/portal/calendars/pending — READ-ONLY summary of calendars still
// under staff review, so the portal isn't blank while that happens.
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
  res.json({ calendar: await clientView(calendar) });
});

// POST /api/portal/calendars/:id/items/:index/select  { selected: true|false }
// The client choosing which services they want us to handle.
router.post("/calendars/:id/items/:index/select", requireCompleteContact, async (req, res) => {
  const calendar = await findOwnApprovedCalendar(req, req.params.id);
  if (!calendar) return res.status(404).json({ error: "Not found." });
  if (calendar.supersededAt) return res.status(400).json({ error: "This is an older calendar. Make changes on your current one." });
  const idx = parseItemIndex(calendar, req.params.index);
  if (idx === null) return res.status(400).json({ error: "Invalid item index." });
  const item = calendar.items[idx];
  if (item.isHistory) return res.status(400).json({ error: "This is a past period of this filing. Choose the current one instead." });
  const selected = req.body?.selected !== false;

  if (!selected) {
    if (item.paymentStatus === "Paid" || item.clientStatus === "Filed") {
      return res.status(400).json({ error: "This service is already paid for or filed, so it can't be removed. Message us if something's wrong." });
    }
    // A price that came automatically from the price list can be undone
    // with the selection; a price staff sent personally can't.
    if ((item.paymentStatus === "Invoiced" || item.paymentStatus === "Overdue") && item.quotedBy !== PRICE_LIST_ACTOR) {
      return res.status(400).json({ error: "We've already sent you a price for this service. Message us if you'd like to cancel it." });
    }
  }
  if (item.selectedByClient === selected) return res.json({ calendar: await clientView(calendar) });

  item.selectedByClient = selected;
  item.selectedAt = selected ? new Date() : null;
  if (selected && item.clientStatus === "Not Started") item.clientStatus = "Awaiting Documents";
  if (!selected && item.clientStatus === "Awaiting Documents") item.clientStatus = "Not Started";
  const priced = selected ? applyListPrice(item) : (removeListPrice(item), false);
  await calendar.save();

  res.json({ calendar: await clientView(calendar) });

  notifyStaff({
    clientOrgId: calendar.clientOrgId,
    calendarId: calendar._id,
    itemIndex: idx,
    type: selected ? "service_selected" : "service_deselected",
    title: `${req.clientOrg.name} ${selected ? "selected" : "removed"} ${item.compliance_name}`,
    body: selected
      ? (priced
          ? `They want ComplyGlobally to handle this filing. The list price of ${formatUSD(item.feeAmountCents)} was applied automatically.`
          : "They want ComplyGlobally to handle this filing. It has no fixed list price, so send them a price once their documents are in.")
      : "They no longer want this filing handled.",
    link: staffLink(calendar._id),
    actorName: req.user.name || req.user.email,
    email: false, // selections are frequent; the bell is enough, uploads/payments still email
  });
});

// POST /api/portal/calendars/:id/items/:index/upload — client uploads a
// document as proof/support for one compliance item.
router.post("/calendars/:id/items/:index/upload", requireCompleteContact, upload.single("file"), async (req, res) => {
  const calendar = await findOwnApprovedCalendar(req, req.params.id);
  if (!calendar) return res.status(404).json({ error: "Not found." });
  if (calendar.supersededAt) return res.status(400).json({ error: "This is an older calendar. Upload on your current one." });
  const idx = parseItemIndex(calendar, req.params.index);
  if (idx === null) return res.status(400).json({ error: "Invalid item index." });
  if (!req.file) return res.status(400).json({ error: "No file uploaded (field name must be 'file')." });

  try {
    const { fileKey, fileUrl } = await storage.saveFile({
      buffer: req.file.buffer,
      fileName: req.file.originalname,
      contentType: req.file.mimetype,
    });
    const item = calendar.items[idx];
    // requirementLabel says WHICH checklist row this upload satisfies (see
    // lib/requiredDocuments.js). A display/matching hint, not an access-
    // control value, so an unknown label never blocks the upload.
    const requirementLabel = typeof req.body.requirementLabel === "string" ? req.body.requirementLabel.slice(0, 200) : "";
    item.documents.push({
      fileKey,
      fileUrl,
      fileName: req.file.originalname,
      uploadedBy: req.user.email,
      type: "client_upload",
      requirementLabel,
      reviewStatus: "pending",
    });
    // Nobody uploads paperwork for a filing they don't want done.
    if (!item.selectedByClient) {
      item.selectedByClient = true;
      item.selectedAt = new Date();
    }
    applyListPrice(item);
    if (item.clientStatus === "Not Started" || item.clientStatus === "Awaiting Documents") {
      item.clientStatus = "Under Review";
    }
    await calendar.save();
    res.status(201).json({ calendar: await clientView(calendar) });

    logActivity({
      action: "document_uploaded",
      actor: req.user,
      clientOrgId: calendar.clientOrgId,
      calendarId: calendar._id,
      itemIndex: idx,
      summary: `Uploaded "${req.file.originalname}" for ${item.compliance_name}.`,
    });
    notifyStaff({
      clientOrgId: calendar.clientOrgId,
      calendarId: calendar._id,
      itemIndex: idx,
      type: "document_uploaded",
      title: `New document for ${item.compliance_name}`,
      body:
        `${req.user.name || req.user.email} uploaded "${req.file.originalname}"` +
        (requirementLabel ? ` (${requirementLabel})` : "") +
        `. It's waiting for someone to verify it.` +
        (item.feeAmountCents ? "" : " This filing has no fixed price yet; send the client a price once everything is in."),
      link: staffLink(calendar._id),
      actorName: req.user.name || req.user.email,
    });
  } catch (err) {
    console.error("Client upload error:", err);
    res.status(500).json({ error: "Could not save the uploaded file." });
  }
});

// GET /api/portal/calendars/:id/items/:index/documents/:docIndex/download
router.get("/calendars/:id/items/:index/documents/:docIndex/download", async (req, res) => {
  const calendar = await findOwnApprovedCalendar(req, req.params.id);
  if (!calendar) return res.status(404).json({ error: "Not found." });
  const idx = parseItemIndex(calendar, req.params.index);
  const docIdx = parseInt(req.params.docIndex, 10);
  const doc = idx !== null ? calendar.items[idx].documents[docIdx] : null;
  if (!doc) return res.status(404).json({ error: "Document not found." });

  await sendStoredFile(req, res, doc, { audience: "client", backHref: `/portal.html?calendar=${calendar._id}` });
});

// ---------------------------------------------------------------------
// Regenerate
// ---------------------------------------------------------------------

// Research calls cost real money (Claude + web search), so a client can
// regenerate a few times a day, not in a loop. Per org, in memory — the
// same trade-off as the staff limiter in calendar.routes.js.
const REGEN_LIMIT_PER_DAY = 3;
const regenHits = new Map();
function regenRateLimited(orgId) {
  const now = Date.now();
  const arr = (regenHits.get(orgId) || []).filter((t) => now - t < 24 * 60 * 60 * 1000);
  if (arr.length >= REGEN_LIMIT_PER_DAY) return true;
  arr.push(now);
  regenHits.set(orgId, arr);
  return false;
}

const EDITABLE_PROFILE_FIELDS = [
  "companyName", "entityType", "taxStatus", "incorpDate", "fyStart", "fyEnd",
  "hasForeignParent", "odiDone", "odiInvestorType", "employeeStates", "quarterlyGrossReceipts",
];

function nameKey(name) {
  return String(name || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

// Carry the client's work over from the calendar being replaced: for any
// filing that still exists in the new calendar (same name), keep what they
// selected, what they uploaded, and anything already paid or filed. The
// old calendar itself is left untouched in history.
function carryOverProgress(oldCalendar, newItems) {
  const byName = new Map();
  // Current periods only (history items of the same name are older).
  oldCalendar.items.filter((it) => !it.isHistory).forEach((it) => byName.set(nameKey(it.compliance_name), it));
  let carried = 0;
  const items = newItems.map((it) => {
    const prev = byName.get(nameKey(it.compliance_name));
    if (!prev) return it;
    carried++;
    const p = prev.toObject ? prev.toObject() : prev;
    return {
      ...it,
      selectedByClient: p.selectedByClient,
      selectedAt: p.selectedAt,
      clientStatus: p.clientStatus,
      documents: p.documents || [],
      feeAmountCents: p.feeAmountCents,
      quoteNote: p.quoteNote,
      quotedBy: p.quotedBy,
      quotedAt: p.quotedAt,
      paymentStatus: p.paymentStatus,
      paidAt: p.paidAt,
      razorpayPaymentId: p.paymentStatus === "Paid" ? p.razorpayPaymentId : null,
      // An unpaid Razorpay order stays attached to the OLD item so the
      // webhook can still find it; the client gets a fresh order here.
      razorpayOrderId: null,
      paymentEvents: p.paymentEvents || [],
      // A date staff typed in is kept; automatic dates are recomputed for
      // the new calendar's details.
      ...(p.dueDateSource === "staff" ? { dueDateActual: p.dueDateActual, dueDateSource: "staff" } : {}),
      remindersSent: p.remindersSent || [],
    };
  });
  return { items, carried };
}

// POST /api/portal/calendars/regenerate  { calendarId, profile: { ...changes } }
router.post("/calendars/regenerate", requireCompleteContact, async (req, res) => {
  const base = await findOwnApprovedCalendar(req, req.body?.calendarId);
  if (!base) return res.status(404).json({ error: "Calendar not found." });
  if (base.supersededAt) return res.status(400).json({ error: "Regenerate from your current calendar." });
  if (regenRateLimited(String(req.user.clientOrgId))) {
    return res.status(429).json({ error: `You can regenerate up to ${REGEN_LIMIT_PER_DAY} times a day. Try again tomorrow, or message us.` });
  }

  const baseProfile = base.profile.toObject ? base.profile.toObject() : { ...base.profile };
  const changes = req.body?.profile || {};
  const profile = { ...baseProfile };
  EDITABLE_PROFILE_FIELDS.forEach((f) => {
    if (changes[f] !== undefined) profile[f] = changes[f];
  });
  // Country / state define a different legal entity — that's a new
  // calendar from the public tool, not a regeneration of this one.

  try {
    const { items, sourceMode } = await generateCompanyCalendar(profile);
    if (!items.length) {
      return res.status(502).json({ error: "The research came back empty. Try again in a few minutes." });
    }
    const { items: mergedItems, carried } = carryOverProgress(base, items);

    // Auto-approved, the same way a calendar claimed through "Start
    // filing" is (routes/auth.routes.js) — the client keeps working
    // without a gap. Staff are notified and can still edit or reject it.
    const calendar = await Calendar.create({
      createdBy: req.user.email,
      source: "client",
      clientOrgId: req.user.clientOrgId,
      profile,
      items: mergedItems,
      status: "approved",
      reviewedBy: "auto",
      reviewedAt: new Date(),
      sourceMode,
      supersedes: base._id,
    });
    base.supersededAt = new Date();
    await base.save();

    res.status(201).json({ calendar: await clientView(calendar), carried });

    const who = req.user.name || req.user.email;
    logActivity({
      action: "calendar_regenerated",
      actor: req.user,
      clientOrgId: calendar.clientOrgId,
      calendarId: calendar._id,
      summary: `Regenerated the compliance calendar for ${profile.companyName || "their company"} (${items.length} items, ${carried} carried over).`,
    });
    notifyStaff({
      clientOrgId: calendar.clientOrgId,
      calendarId: calendar._id,
      type: "calendar_regenerated",
      title: `${req.clientOrg.name} regenerated their calendar`,
      body: `${who} regenerated the calendar: ${items.length} items, ${carried} carried over from the previous version. Please give it a quick check.`,
      link: staffLink(calendar._id),
      actorName: who,
    });
    notifyClient({
      clientOrgId: calendar.clientOrgId,
      calendarId: calendar._id,
      type: "calendar_regenerated",
      title: "Your compliance calendar was regenerated",
      body: `Your new calendar has ${items.length} items. We kept your selections, documents and payments for the ${carried} filings that are still on it. Your previous calendar is still available under "Calendar history".`,
      link: `/portal.html?calendar=${calendar._id}`,
      actorName: who,
    });
  } catch (err) {
    console.error("Client regenerate error:", err);
    res.status(502).json({ error: "We couldn't finish the research just now. Please try again in a few minutes." });
  }
});

// ---------------------------------------------------------------------
// Invoices, receipts and credit notes (this company's only)
// ---------------------------------------------------------------------
// GET /api/portal/invoices
router.get("/invoices", async (req, res) => {
  const Invoice = require("../models/Invoice");
  const { money } = require("../lib/invoices");
  const rows = await Invoice.find({ clientOrgId: req.user.clientOrgId, status: { $ne: "void" } }).sort({ issuedAt: -1 }).limit(200);
  res.json({
    invoices: rows.map((inv) => ({
      id: String(inv._id), kind: inv.kind, number: inv.number, issuedAt: inv.issuedAt, status: inv.status,
      amount: money(inv.amountMinor, inv.currency), refunded: inv.refundedMinor ? money(inv.refundedMinor, inv.currency) : "",
      description: inv.description, calendarId: inv.calendarId ? String(inv.calendarId) : null, itemIndex: inv.itemIndex,
      invoiceNumber: inv.invoiceNumber || "", pdf: `/api/portal/invoices/${inv._id}/pdf`,
    })),
  });
});

// GET /api/portal/invoices/:id/pdf — ownership is part of the query.
router.get("/invoices/:id/pdf", async (req, res) => {
  const Invoice = require("../models/Invoice");
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ error: "Not found." });
  const inv = await Invoice.findOne({ _id: req.params.id, clientOrgId: req.user.clientOrgId });
  if (!inv) return res.status(404).json({ error: "Not found." });
  await require("./invoices.routes").sendPdf(res, inv);
});

// GET /api/portal/contact — who to reach for help.
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
module.exports.carryOverProgress = carryOverProgress;
