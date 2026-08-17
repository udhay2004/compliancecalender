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
const User = require("../models/User");
const { setSessionCookie, clearSessionCookie, requireAuth } = require("../middleware/auth");

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

module.exports = router;
