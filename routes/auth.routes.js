// routes/auth.routes.js
//
// One shared login for the whole team — no signup, no per-person
// accounts, no email/approval flow. Credentials live in .env as
// AUTH_USERNAME / AUTH_PASSWORD (defaults below match what was
// requested, but override them in .env for anything beyond local
// testing — that file is gitignored and never committed).

const express = require("express");
const { setSessionCookie, clearSessionCookie, requireAuth } = require("../middleware/auth");

const router = express.Router();

const AUTH_USERNAME = process.env.AUTH_USERNAME || "complyglobglob";
const AUTH_PASSWORD = process.env.AUTH_PASSWORD || "GGchil1999!";

router.post("/login", (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ error: "Username and password required." });
  }

  if (username.trim() !== AUTH_USERNAME || password !== AUTH_PASSWORD) {
    return res.status(401).json({ error: "Invalid username or password." });
  }

  setSessionCookie(res, AUTH_USERNAME);
  return res.json({ user: { username: AUTH_USERNAME } });
});

router.post("/logout", (req, res) => {
  clearSessionCookie(res);
  return res.json({ ok: true });
});

router.get("/me", requireAuth, (req, res) => {
  return res.json({ user: { username: req.user.username } });
});

module.exports = router;
