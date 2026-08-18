// routes/auth.routes.js
//
// Real per-person login against the User collection (models/User.js),
// replacing the old single-shared-username/password design. There is
// still no public signup route here on purpose — every account (staff,
// admin, client) is created by an admin/super_admin via
// routes/admin.routes.js, or by the bootstrap script
// (scripts/createUser.js) for the very first super_admin.

const express = require("express");
const rateLimit = require("express-rate-limit");
const crypto = require("crypto");
const User = require("../models/User");
const { setSessionCookie, clearSessionCookie, requireAuth } = require("../middleware/auth");
const { getAuthUrl, verifyCodeAndGetProfile } = require("../lib/google");

const router = express.Router();

// Login has no other guard (no CAPTCHA, no MFA), so a per-IP throttle is
// the only thing standing between this route and a password-guessing
// script. 10 attempts / 15 min is generous for a real person who mistypes
// a password a few times, tight for automated guessing. Keyed by IP, not
// by email, so this can't be used to lock a specific person's account out
// by repeatedly failing their email on purpose.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many login attempts. Please wait a few minutes and try again." },
});

router.post("/login", loginLimiter, async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) {
    return res.status(400).json({ error: "Email and password required." });
  }

  const user = await User.findOne({ email: email.trim().toLowerCase() });
  if (!user || !user.active) {
    return res.status(401).json({ error: "Invalid email or password." });
  }
  const ok = await user.checkPassword(password);
  if (!ok) {
    return res.status(401).json({ error: "Invalid email or password." });
  }

  setSessionCookie(res, user);
  return res.json({ user: user.toSafeJSON() });
});

router.post("/logout", (req, res) => {
  clearSessionCookie(res);
  return res.json({ ok: true });
});

router.get("/me", requireAuth, (req, res) => {
  return res.json({ user: req.user.toSafeJSON() });
});

// ---------------------------------------------------------------------
// Google sign-in
//
// GET /google           — redirects the browser to Google's consent screen
// GET /google/callback  — Google redirects back here with ?code=...&state=...
//
// This app has no public self-serve signup (see the note at the top of
// this file) — every real role/clientOrgId assignment is deliberately
// an admin action. So a Google sign-in with no matching existing user
// does NOT get instant access: it creates a role:"pending" account
// (see models/User.js) that can log in but can't reach any real route
// (requireRole blocks it — "pending" ranks below every real role), and
// shows up in GET /api/admin/pending-users for an admin to approve.
//
// If the Google email DOES match an existing email/password account,
// that account is linked (googleId gets set on it) rather than creating
// a duplicate — same person, new login method.
// ---------------------------------------------------------------------

const GOOGLE_STATE_COOKIE = "cc_oauth_state";

router.get("/google", (req, res) => {
  // Random per-attempt state, checked on callback, to stop a
  // cross-site request from forging a callback hit against this
  // server (standard OAuth CSRF protection).
  const state = crypto.randomBytes(24).toString("hex");
  res.cookie(GOOGLE_STATE_COOKIE, state, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: 10 * 60 * 1000, // only needs to survive the round trip to Google and back
  });
  res.redirect(getAuthUrl(state));
});

router.get("/google/callback", async (req, res) => {
  const { code, state, error } = req.query;
  const expectedState = req.cookies?.[GOOGLE_STATE_COOKIE];
  res.clearCookie(GOOGLE_STATE_COOKIE);

  if (error) {
    return res.redirect("/login.html?reason=google_denied");
  }
  if (!code || !state || !expectedState || state !== expectedState) {
    return res.redirect("/login.html?reason=google_invalid_state");
  }

  let profile;
  try {
    profile = await verifyCodeAndGetProfile(code);
  } catch (err) {
    console.error("Google sign-in failed:", err.message);
    return res.redirect("/login.html?reason=google_failed");
  }

  let user = await User.findOne({ googleId: profile.googleId });

  if (!user) {
    // Not linked yet — check for an existing email/password account
    // with the same email and link it, rather than creating a duplicate.
    user = await User.findOne({ email: profile.email });
    if (user) {
      user.googleId = profile.googleId;
      if (!user.name && profile.name) user.name = profile.name;
      await user.save();
    }
  }

  if (!user) {
    // Genuinely new person — create a powerless pending account for an
    // admin to review and approve (see GET /api/admin/pending-users).
    user = await User.create({
      email: profile.email,
      name: profile.name,
      googleId: profile.googleId,
      role: "pending",
    });
  }

  if (!user.active) {
    return res.redirect("/login.html?reason=account_deactivated");
  }

  setSessionCookie(res, user);

  if (user.role === "pending") {
    return res.redirect("/login.html?reason=pending_approval");
  }
  return res.redirect("/");
});

module.exports = router;
