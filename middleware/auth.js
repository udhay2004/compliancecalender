// middleware/auth.js
//
// Simple httpOnly-cookie JWT auth. No API key, no page in this app works
// (including /api/generate, the thing that costs money) without a valid
// session — that's what closes the "anyone with the link can spend your
// API credits" hole.

const jwt = require("jsonwebtoken");

const COOKIE_NAME = "cc_session";
const TOKEN_TTL = "30d";

function signToken(user) {
  return jwt.sign(
    { sub: user._id.toString(), email: user.email, role: user.role },
    process.env.JWT_SECRET,
    { expiresIn: TOKEN_TTL }
  );
}

function setSessionCookie(res, user) {
  const token = signToken(user);
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: 30 * 24 * 60 * 60 * 1000,
  });
}

function clearSessionCookie(res) {
  res.clearCookie(COOKIE_NAME);
}

// For API routes: 401 JSON if not logged in.
function requireAuth(req, res, next) {
  const token = req.cookies?.[COOKIE_NAME];
  if (!token) return res.status(401).json({ error: "Not logged in." });
  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch (err) {
    return res.status(401).json({ error: "Session expired or invalid. Please log in again." });
  }
}

// For HTML pages: redirect to /login.html instead of a raw 401.
function requirePageAuth(req, res, next) {
  const token = req.cookies?.[COOKIE_NAME];
  if (!token) return res.redirect("/login.html");
  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch (err) {
    return res.redirect("/login.html");
  }
}

module.exports = {
  COOKIE_NAME,
  setSessionCookie,
  clearSessionCookie,
  requireAuth,
  requirePageAuth,
};
