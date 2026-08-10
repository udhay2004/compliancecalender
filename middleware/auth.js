// middleware/auth.js
//
// Single shared-login gate. The whole team uses ONE username/password
// (set in .env — see AUTH_USERNAME / AUTH_PASSWORD). No per-person
// accounts, no signup, no database lookups here. Once someone logs in
// they get a signed, httpOnly cookie and every page/route below trusts
// it until it expires or they log out.

const jwt = require("jsonwebtoken");

const COOKIE_NAME = "cc_session";
const TOKEN_TTL = "30d";

function signToken(username) {
  return jwt.sign({ username }, process.env.JWT_SECRET, { expiresIn: TOKEN_TTL });
}

function setSessionCookie(res, username) {
  const token = signToken(username);
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
    return res.redirect("/login.html?reason=session_expired");
  }
}

module.exports = {
  COOKIE_NAME,
  setSessionCookie,
  clearSessionCookie,
  requireAuth,
  requirePageAuth,
};
