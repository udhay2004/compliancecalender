// routes/public.routes.js
//
// The free/public tier (Phase 1 of the platform roadmap). No auth at
// all — this is deliberately reachable by anyone on the internet, which
// is exactly why it's kept narrow and separate from calendar.routes.js:
//
//   POST /api/public/generate         — profile in, REDACTED calendar out.
//                                        Saved to Mongo as source:"public"
//                                        so it's inert (never appears in
//                                        staff queues, client portals, or
//                                        counts toward anything real).
//   POST /api/public/:id/unlock       — visitor leaves name/email/phone
//                                        to see the full calendar. This
//                                        IS the lead — leadContact being
//                                        set is what makes it show up in
//                                        GET /api/admin/leads.
//
// Redaction happens server-side (redactItem below), not just hidden in
// the frontend — the whole point is that nothing sensitive is present
// in the network response before someone unlocks it, so there's nothing
// to find by opening devtools.
//
// Rate-limited by IP (see limiter below) since this calls the same
// Claude-backed research engine as the authenticated staff tool and an
// anonymous route is the obvious target for anyone trying to run up
// your Anthropic bill for free.

const express = require("express");
const rateLimit = require("express-rate-limit");
const Calendar = require("../models/Calendar");
const { generateCompanyCalendar } = require("../lib/claude");
const { sendEmail } = require("../lib/mailer");

const router = express.Router();

const generateLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 5, // 5 free calendar generations per IP per hour — generous for a
          // real visitor trying a couple of scenarios, tight for a script
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests. Please try again later." },
});

const unlockLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests. Please try again later." },
});

// Fields a visitor gets to see in the free preview. Everything else on
// an item (due_date, description, authority, source_url, confidence) is
// exactly what a real client is paying for, so it's withheld — not
// just visually hidden, entirely absent from the JSON.
function redactItem(item) {
  return {
    category: item.category,
    compliance_name: item.compliance_name,
    applicable_to: item.applicable_to,
    locked: true,
  };
}

// POST /api/public/generate
router.post("/generate", generateLimiter, async (req, res) => {
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
      createdBy: "public",
      source: "public",
      clientOrgId: null,
      profile,
      items,
      status: "pending_review",
      sourceMode,
    });

    return res.status(201).json({
      calendarId: calendar._id,
      itemCount: items.length,
      items: items.map(redactItem),
    });
  } catch (err) {
    console.error("Public generate error:", err);
    return res.status(502).json({ error: `Research request failed: ${err.message}` });
  }
});

// POST /api/public/:id/unlock
// Body: { name, email, phone }. Requires at minimum an email — that's
// the actual lead. Once unlocked, returns the SAME calendar unredacted
// so the visitor sees the value they were promised, and the record is
// now a real lead admin can see and follow up on.
router.post("/:id/unlock", unlockLimiter, async (req, res) => {
  const { name = "", email = "", phone = "" } = req.body || {};
  if (!email || !email.includes("@")) {
    return res.status(400).json({ error: "A valid email is required to unlock your full calendar." });
  }

  const calendar = await Calendar.findOne({ _id: req.params.id, source: "public" });
  if (!calendar) return res.status(404).json({ error: "Not found." });

  calendar.leadContact = { name, email, phone, unlockedAt: new Date() };
  await calendar.save();

  const notifyTo = process.env.ADMIN_EMAIL;
  if (notifyTo) {
    sendEmail({
      to: notifyTo,
      subject: `New compliance calendar lead: ${calendar.profile.companyName || calendar.profile.state}`,
      text:
        `A visitor unlocked their free compliance calendar preview.\n\n` +
        `Name: ${name || "(not given)"}\n` +
        `Email: ${email}\n` +
        `Phone: ${phone || "(not given)"}\n` +
        `Company: ${calendar.profile.companyName || "(not given)"}\n` +
        `State: ${calendar.profile.state}, Entity: ${calendar.profile.entityType}\n\n` +
        `View in admin: ${process.env.APP_URL || ""}/admin.html`,
      logPrefix: "[public-lead]",
    }).catch((err) => console.error("[public-lead] Notify email failed (non-fatal):", err.message));
  }

  return res.json({ calendar });
});

module.exports = router;
