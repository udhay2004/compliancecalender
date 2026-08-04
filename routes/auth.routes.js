// routes/auth.routes.js
//
// Self-signup with email/password (per spec: "anyone can self-signup").
// Every logged-in user can generate AND review/approve calendars — there's
// no separate "reviewer" role right now, by design (small trusted team).

const express = require("express");
const User = require("../models/User");
const { setSessionCookie, clearSessionCookie, requireAuth } = require("../middleware/auth");

const router = express.Router();

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

router.post("/signup", async (req, res) => {
  try {
    const { email, password, name } = req.body || {};
    if (!email || !isValidEmail(email)) {
      return res.status(400).json({ error: "Valid email required." });
    }
    if (!password || password.length < 8) {
      return res.status(400).json({ error: "Password must be at least 8 characters." });
    }

    const existing = await User.findOne({ email: email.toLowerCase().trim() });
    if (existing) {
      return res.status(409).json({ error: "An account with that email already exists." });
    }

    const user = new User({ email: email.toLowerCase().trim(), name: (name || "").trim() });
    await user.setPassword(password);
    await user.save();

    setSessionCookie(res, user);
    return res.status(201).json({ user: user.toSafeJSON() });
  } catch (err) {
    console.error("Signup error:", err);
    return res.status(500).json({ error: "Signup failed. Try again." });
  }
});

router.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) {
      return res.status(400).json({ error: "Email and password required." });
    }
    const user = await User.findOne({ email: email.toLowerCase().trim() });
    if (!user) return res.status(401).json({ error: "Invalid email or password." });

    const ok = await user.checkPassword(password);
    if (!ok) return res.status(401).json({ error: "Invalid email or password." });

    setSessionCookie(res, user);
    return res.json({ user: user.toSafeJSON() });
  } catch (err) {
    console.error("Login error:", err);
    return res.status(500).json({ error: "Login failed. Try again." });
  }
});

router.post("/logout", (req, res) => {
  clearSessionCookie(res);
  return res.json({ ok: true });
});

router.get("/me", requireAuth, async (req, res) => {
  const user = await User.findById(req.user.sub);
  if (!user) return res.status(401).json({ error: "User not found." });
  return res.json({ user: user.toSafeJSON() });
});

module.exports = router;
