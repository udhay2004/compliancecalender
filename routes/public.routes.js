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

const MONTH_NAMES = [
  "january", "february", "march", "april", "may", "june",
  "july", "august", "september", "october", "november", "december",
];

// due_date here is NEVER a real parseable date string — it's a
// human-readable rule from lib/claude.js, e.g. "31 January (Annually)",
// "15th day of 4th month after FY end (15 July for this company)", or
// "As Triggered" for event-based items. Using JS's `new Date(...)`
// directly on these is wrong: tested directly, `new Date("31 January
// (Annually)")` silently defaults the missing year to 2001, which is
// why every recurring item was showing as wildly "Overdue" and no
// filter window ever matched anything. This extracts an actual day+
// month from the text ourselves and anchors it to the correct year.
function extractMonthDay(text) {
  if (!text) return null;
  const re =
    /\b(\d{1,2})(?:st|nd|rd|th)?\s+(january|february|march|april|may|june|july|august|september|october|november|december)\b|\b(january|february|march|april|may|june|july|august|september|october|november|december)\s+(\d{1,2})(?:st|nd|rd|th)?\b/i;
  const m = text.match(re);
  if (!m) return null;
  const day = m[1] ? parseInt(m[1], 10) : parseInt(m[4], 10);
  const monthName = (m[2] || m[3]).toLowerCase();
  const month = MONTH_NAMES.indexOf(monthName);
  if (month === -1 || !day || day < 1 || day > 31) return null;
  return { month, day };
}

function daysUntilOf(dueDateStr) {
  if (!dueDateStr) return null;

  const lower = dueDateStr.toLowerCase();
  if (lower.includes("as triggered") || lower.includes("per service agreement")) {
    return null; // genuinely event-based, no calendar date to compute
  }

  // Prefer a date embedded in parentheses — that's the already
  // company-specific computed date (e.g. "...(15 July for this
  // company)"), more precise than the general rule text before it.
  const parenMatch = dueDateStr.match(/\(([^)]+)\)/);
  const parsed = (parenMatch && extractMonthDay(parenMatch[1])) || extractMonthDay(dueDateStr);
  if (!parsed) return null; // e.g. "anniversary of incorporation date" — can't compute without more context

  const now = new Date();
  let candidate = new Date(now.getFullYear(), parsed.month, parsed.day);
  const diff = Math.ceil((candidate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));

  // Already passed this year (beyond a couple of days, to avoid "due
  // today" edge cases flipping early) — a recurring obligation's NEXT
  // occurrence is next year, not "overdue by 8 months".
  if (diff < -2) {
    candidate = new Date(now.getFullYear() + 1, parsed.month, parsed.day);
  }
  return Math.ceil((candidate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
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
