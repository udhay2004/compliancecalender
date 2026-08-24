// routes/public.routes.js
//
// The free/public tier. UPDATED per the new product requirement:
//
//   - Contact info (name + email, required) is now captured BEFORE a
//     calendar is generated at all, not after via a separate "unlock"
//     step. Every submission through this route is a real lead the
//     moment it's created.
//
//   - Reveal policy: the two nearest upcoming deadlines come back in
//     full detail. Everything else is redacted down to just its category
//     and how many days until it's due — no compliance_name, no
//     description, nothing identifying. There's no self-serve "enter
//     your email to unlock the rest" anymore; getting the full calendar
//     is a conversation with ComplyGlobally now (see /request-review).
//
//   - Rate-limited by IP, same reasoning as before: this calls the same
//     Claude-backed research engine as the authenticated staff tool, so
//     it's the obvious target for anyone trying to run up your Anthropic
//     bill for free.

const express = require("express");
const rateLimit = require("express-rate-limit");
const Calendar = require("../models/Calendar");
const { generateCompanyCalendar } = require("../lib/claude");
const { sendEmail } = require("../lib/mailer");

const router = express.Router();

const generateLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests. Please try again later." },
});

const reviewLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests. Please try again later." },
});

// How much of the calendar comes back fully detailed. You said "hide
// roughly 30%, not everything" — so this locks the FARTHEST-OUT ~30% of
// items (by due date) rather than a fixed count. With a 28-item
// calendar that's ~20 shown, ~8 locked — enough to be genuinely useful
// on its own, with a real reason to talk to your team for the rest.
const UNLOCK_RATIO = 0.7;

// Best-effort date parse. Returns null for anything unparseable, so a
// vague due_date never gets mistaken for something urgent or overdue.
//
// IMPORTANT FIX: many compliance items are annual/recurring (e.g. "Form
// 940 due 31 January of the following year"). If the date Claude/the
// cache returns doesn't carry a year that's actually in the future, a
// naive `new Date(dueDateStr)` parses it as a past date and the item
// shows as "Overdue" even though the real next occurrence hasn't
// happened yet. Rolling forward by whole years until non-negative fixes
// this for the common recurring case. This is a display-layer patch —
// the real fix belongs in lib/claude.js's date generation so due_date
// carries the correct year to begin with; flagging that as a follow-up.
function daysUntilOf(dueDateStr) {
  const d = new Date(dueDateStr);
  if (isNaN(d.getTime())) return null;

  let ms = d.getTime() - Date.now();
  let days = Math.ceil(ms / (1000 * 60 * 60 * 24));

  // Roll forward by whole years while it's meaningfully in the past
  // (more than a week ago — small negative values are left alone, since
  // that's more likely a genuinely overdue one-time item than a
  // recurring date needing a year bump).
  let guardYears = 0;
  while (days < -7 && guardYears < 5) {
    d.setFullYear(d.getFullYear() + 1);
    ms = d.getTime() - Date.now();
    days = Math.ceil(ms / (1000 * 60 * 60 * 24));
    guardYears++;
  }

  return days;
}

// Sorts nearest-due first, unlocks the nearest UNLOCK_RATIO of items in
// full, and reduces the farthest-out remainder to { locked, category,
// daysUntil } — no name, no description.
function applyRevealPolicy(items) {
  const withDays = items
    .map((it) => ({ ...it, daysUntil: daysUntilOf(it.due_date) }))
    .sort((a, b) => (a.daysUntil ?? Infinity) - (b.daysUntil ?? Infinity));

  const unlockedCount = Math.max(2, Math.round(withDays.length * UNLOCK_RATIO));

  return withDays.map((it, idx) => {
    if (idx < unlockedCount) {
      return { ...it, locked: false };
    }
    return {
      locked: true,
      category: it.category,
      daysUntil: it.daysUntil,
    };
  });
}

function notifyAdminOfLead(calendar, contact, { isReviewRequest = false } = {}) {
  const notifyTo = process.env.ADMIN_EMAIL;
  if (!notifyTo) return;
  sendEmail({
    to: notifyTo,
    subject: isReviewRequest
      ? `Lead requested full review: ${calendar.profile.companyName || calendar.profile.state}`
      : `New compliance calendar lead: ${calendar.profile.companyName || calendar.profile.state}`,
    text:
      (isReviewRequest
        ? `A lead clicked "Talk to ComplyGlobally" to request their full calendar.\n\n`
        : `A visitor generated a compliance calendar.\n\n`) +
      `Name: ${contact.name || "(not given)"}\n` +
      `Email: ${contact.email}\n` +
      `Phone: ${contact.phone || "(not given)"}\n` +
      `Company: ${calendar.profile.companyName || "(not given)"}\n` +
      `Country: ${calendar.profile.country || "United States"}\n` +
      `State/Region: ${calendar.profile.state}, Entity: ${calendar.profile.entityType}\n\n` +
      `View in admin: ${process.env.APP_URL || ""}/admin.html`,
    logPrefix: "[public-lead]",
  }).catch((err) => console.error("[public-lead] Notify email failed (non-fatal):", err.message));
}

// POST /api/public/generate
// Body: { profile, contact: { name, email, phone } }
// contact.email is REQUIRED — this is the lead capture, now the FIRST
// step instead of something requested after seeing a locked preview.
router.post("/generate", generateLimiter, async (req, res) => {
  const profile = req.body?.profile;
  const contact = req.body?.contact || {};

  if (!profile || !profile.state || !profile.entityType) {
    return res.status(400).json({ error: "Missing required profile fields (state, entityType)." });
  }
  if (!contact.email || !contact.email.includes("@")) {
    return res.status(400).json({ error: "A valid email is required to generate your compliance calendar." });
  }

  try {
    const { items, sourceMode } = await generateCompanyCalendar(profile);
    if (!items.length) {
      return res.status(502).json({ error: "No calendar items returned — try again or refine the profile." });
    }

    const calendar = await Calendar.create({
      createdBy: "public",
      source: "public",
      clientOrgId: null,
      profile,
      items,
      status: "pending_review",
      sourceMode,
      leadContact: {
        name: contact.name || "",
        email: contact.email,
        phone: contact.phone || "",
        unlockedAt: new Date(),
      },
    });

    notifyAdminOfLead(calendar, contact);

    return res.status(201).json({
      calendarId: calendar._id,
      itemCount: items.length,
      items: applyRevealPolicy(items),
    });
  } catch (err) {
    console.error("Public generate error:", err);
    return res.status(502).json({ error: `Research request failed: ${err.message}` });
  }
});

// POST /api/public/:id/request-review
// The "Talk to ComplyGlobally" button. We already have this lead's
// contact info from /generate, so this doesn't collect anything new —
// it just re-notifies your team that this specific lead wants the full
// calendar walked through with them, which is a stronger signal than
// the original generation.
router.post("/:id/request-review", reviewLimiter, async (req, res) => {
  const calendar = await Calendar.findOne({ _id: req.params.id, source: "public" });
  if (!calendar) return res.status(404).json({ error: "Not found." });
  if (!calendar.leadContact?.email) {
    return res.status(400).json({ error: "No contact info on file for this calendar." });
  }

  notifyAdminOfLead(calendar, calendar.leadContact, { isReviewRequest: true });
  return res.json({ ok: true });
});

module.exports = router;
