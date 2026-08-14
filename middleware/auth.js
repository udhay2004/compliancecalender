// middleware/auth.js
//
// Real per-person accounts with roles (see models/User.js), replacing
// the old single-shared-login design. The JWT payload carries {id, role}
// only — email/name/clientOrgId are looked up fresh from the database on
// every request via requireAuth, so deactivating a user or changing
// their role takes effect immediately instead of waiting for a 30-day
// token to expire.

const jwt = require("jsonwebtoken");
const User = require("../models/User");

const COOKIE_NAME = "cc_session";
const TOKEN_TTL = "30d";

function signToken(user) {
  return jwt.sign({ id: user._id.toString() }, process.env.JWT_SECRET, { expiresIn: TOKEN_TTL });
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

// Shared lookup used by both the API and page guards below. Throws on
// anything wrong (no cookie, bad signature, user deleted/deactivated)
// so callers can each decide how to respond (401 JSON vs redirect).
async function loadUserFromRequest(req) {
  const token = req.cookies?.[COOKIE_NAME];
  if (!token) throw new Error("Not logged in.");
  const payload = jwt.verify(token, process.env.JWT_SECRET);
  const user = await User.findById(payload.id);
  if (!user || !user.active) throw new Error("Session invalid.");
  return user;
}

// For API routes: 401 JSON if not logged in. Sets req.user to the full
// Mongoose User document (not just the JWT payload) so route handlers
// always see current role/active/clientOrgId, not a stale snapshot.
function requireAuth(req, res, next) {
  loadUserFromRequest(req)
    .then((user) => {
      req.user = user;
      next();
    })
    .catch(() => res.status(401).json({ error: "Not logged in or session expired." }));
}

// requireRole("admin") = "admin or more senior" (admin, super_admin).
// requireRole("staff") = "staff or more senior" (staff, admin, super_admin).
// Compose with requireAuth first: [requireAuth, requireRole("admin")].
function requireRole(minRole) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: "Not logged in." });
    if (!User.hasAtLeast(req.user.role, minRole)) {
      return res.status(403).json({ error: "You don't have permission to do that." });
    }
    next();
  };
}

// Client-portal routes need the OPPOSITE check from requireRole — a
// client account must never reach staff endpoints, and a staff/admin
// account isn't scoped to a clientOrgId at all, so "at least a client"
// doesn't mean anything useful there. Use this exact role instead.
function requireClientRole(req, res, next) {
  if (!req.user) return res.status(401).json({ error: "Not logged in." });
  if (req.user.role !== "client") {
    return res.status(403).json({ error: "This is a client-portal endpoint." });
  }
  next();
}

// For HTML pages: redirect instead of a raw 401/403.
function requirePageAuth(req, res, next) {
  loadUserFromRequest(req)
    .then((user) => {
      req.user = user;
      next();
    })
    .catch(() => res.redirect("/login.html?reason=session_expired"));
}

function requirePageRole(minRole) {
  return (req, res, next) => {
    if (!req.user || !User.hasAtLeast(req.user.role, minRole)) {
      return res.redirect("/login.html?reason=not_authorized");
    }
    next();
  };
}

// For pages that should work BOTH logged in and logged out (currently
// just "/" — see server.js). Never redirects or blocks; sets req.user
// if there's a valid session, leaves it undefined otherwise, and always
// calls next(). Route handlers using this must handle the undefined
// case themselves.
function tryPageAuth(req, res, next) {
  loadUserFromRequest(req)
    .then((user) => {
      req.user = user;
      next();
    })
    .catch(() => next());
}

// Portal pages need the exact role "client", not "at least client" —
// requirePageRole would let staff/admin through too (they outrank
// client), which is wrong for a client-only UI. Mirrors requireClientRole.
function requirePageClientRole(req, res, next) {
  if (!req.user || req.user.role !== "client") {
    return res.redirect("/login.html?reason=not_authorized");
  }
  next();
}

module.exports = {
  COOKIE_NAME,
  setSessionCookie,
  clearSessionCookie,
  requireAuth,
  requireRole,
  requireClientRole,
  requirePageAuth,
  requirePageRole,
  requirePageClientRole,
  tryPageAuth,
};
