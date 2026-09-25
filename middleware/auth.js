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
// Separate cookie for the half-finished state between "proved you own
// the mailbox" and "chose a password". It must NOT be the session
// cookie: if it were, someone who only passed the OTP step would
// already hold a fully privileged session and could simply navigate
// away from the password screen and use the app.
const SETUP_COOKIE_NAME = "cc_setup";
// Short-lived "password OK, code still needed" cookie for staff with
// two-factor login switched on. Never grants access by itself.
const MFA_COOKIE_NAME = "cc_mfa";
const MFA_TTL = "10m";

// Two-factor is required for every internal account unless explicitly
// turned off (TWO_FACTOR_REQUIRED=false, e.g. local development).
function twoFactorRequired() {
  return (process.env.TWO_FACTOR_REQUIRED || "true").toLowerCase() !== "false";
}
const TOKEN_TTL = "30d";
const SETUP_TOKEN_TTL = "15m";

// Internal (staff/admin/super_admin) sessions are deliberately much
// shorter than the 30-day client session. These accounts can see every
// client's data, so a laptop left open in a cafe is a real exposure;
// a working day plus a margin is the right trade-off.
const STAFF_TOKEN_TTL = "12h";
const STAFF_MAX_AGE_MS = 12 * 60 * 60 * 1000;
const CLIENT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

function isInternal(user) {
  return user.role !== "client";
}

// Every token carries:
//   p — its purpose. A setup token must never be accepted as a session
//       token, and jwt.verify alone can't tell them apart because both
//       are signed with the same secret.
//   v — the account's tokenVersion at issue time. Bumped on every
//       password change, which is what makes "changing your password
//       signs out every other device" true rather than aspirational.
//   m — 1 if this session passed the two-factor code step.
function signToken(user, { mfaPassed = false } = {}) {
  return jwt.sign(
    { id: user._id.toString(), p: "session", v: user.tokenVersion || 0, m: mfaPassed ? 1 : 0 },
    process.env.JWT_SECRET,
    { expiresIn: isInternal(user) ? STAFF_TOKEN_TTL : TOKEN_TTL }
  );
}

function signSetupToken(user) {
  return jwt.sign(
    { id: user._id.toString(), p: "setup", v: user.tokenVersion || 0 },
    process.env.JWT_SECRET,
    { expiresIn: SETUP_TOKEN_TTL }
  );
}

function cookieOptions(maxAge) {
  return {
    httpOnly: true,            // unreadable from JavaScript, so an XSS bug can't steal the session
    sameSite: "lax",           // not sent on cross-site POSTs, which blocks basic CSRF
    secure: process.env.NODE_ENV === "production", // HTTPS only once deployed
    path: "/",
    maxAge,
  };
}

// EVERY way of signing in (password, emailed code, Google, first password)
// ends here, so this is where two-factor is enforced: a staff member with
// two-factor switched on gets only a 10-minute "code needed" cookie, and
// every staff page sends them to /two-factor.html until they enter a code.
// Returns "mfa" in that case, "session" otherwise.
function setSessionCookie(res, user, { mfaPassed = false } = {}) {
  res.clearCookie(SETUP_COOKIE_NAME, { path: "/" });
  if (isInternal(user) && user.totpEnabled && !mfaPassed) {
    res.clearCookie(COOKIE_NAME, { path: "/" });
    res.cookie(
      MFA_COOKIE_NAME,
      jwt.sign({ id: user._id.toString(), p: "mfa", v: user.tokenVersion || 0 }, process.env.JWT_SECRET, { expiresIn: MFA_TTL }),
      cookieOptions(10 * 60 * 1000)
    );
    return "mfa";
  }
  res.clearCookie(MFA_COOKIE_NAME, { path: "/" });
  res.cookie(
    COOKIE_NAME,
    signToken(user, { mfaPassed }),
    cookieOptions(isInternal(user) ? STAFF_MAX_AGE_MS : CLIENT_MAX_AGE_MS)
  );
  return "session";
}

// The user behind a "code needed" cookie (POST /api/auth/2fa/verify only).
async function loadUserFromMfaToken(req) {
  const token = req.cookies?.[MFA_COOKIE_NAME];
  if (!token) throw new Error("No two-factor sign-in in progress.");
  const payload = jwt.verify(token, process.env.JWT_SECRET);
  if (payload.p !== "mfa") throw new Error("Wrong token type.");
  const user = await User.findById(payload.id);
  if (!user || !user.active || !user.totpEnabled) throw new Error("Sign-in invalid.");
  if ((payload.v ?? 0) !== (user.tokenVersion || 0)) throw new Error("Sign-in superseded.");
  return user;
}

// Staff who must still set up two-factor may only reach these.
const MFA_SETUP_ALLOWED = /^\/api\/(auth|notifications)(\/|$)/;
function needsMfaSetup(user) {
  return isInternal(user) && twoFactorRequired() && !user.totpEnabled;
}

function setSetupCookie(res, user) {
  res.cookie(SETUP_COOKIE_NAME, signSetupToken(user), cookieOptions(15 * 60 * 1000));
}

function clearSessionCookie(res) {
  res.clearCookie(COOKIE_NAME, { path: "/" });
  res.clearCookie(SETUP_COOKIE_NAME, { path: "/" });
}

// Shared lookup used by both the API and page guards below. Throws on
// anything wrong (no cookie, bad signature, user deleted/deactivated)
// so callers can each decide how to respond (401 JSON vs redirect).
async function loadUserFromRequest(req) {
  const token = req.cookies?.[COOKIE_NAME];
  if (!token) throw new Error("Not logged in.");
  const payload = jwt.verify(token, process.env.JWT_SECRET);
  if (payload.p !== "session") throw new Error("Wrong token type.");
  const user = await User.findById(payload.id);
  if (!user || !user.active) throw new Error("Session invalid.");
  // Rejects tokens minted before the last password change / forced
  // sign-out, even though their signature and expiry are still valid.
  if ((payload.v ?? 0) !== (user.tokenVersion || 0)) throw new Error("Session superseded.");
  // An account that still owes us a password has no business holding a
  // working session — it can only have got here by finishing the OTP
  // step and then abandoning the password screen.
  if (user.mustSetPassword) throw new Error("Password setup incomplete.");
  // Two-factor is on but this session never passed the code step (e.g.
  // it was issued before two-factor was switched on): not valid.
  if (isInternal(user) && user.totpEnabled && payload.m !== 1) throw new Error("Two-factor code required.");
  return user;
}

// Mirror of the above for the short-lived setup token. Used by exactly
// one route (POST /api/auth/password/set) and nothing else.
async function loadUserFromSetupToken(req) {
  const token = req.cookies?.[SETUP_COOKIE_NAME];
  if (!token) throw new Error("No setup session.");
  const payload = jwt.verify(token, process.env.JWT_SECRET);
  if (payload.p !== "setup") throw new Error("Wrong token type.");
  const user = await User.findById(payload.id);
  if (!user || !user.active) throw new Error("Setup session invalid.");
  if ((payload.v ?? 0) !== (user.tokenVersion || 0)) throw new Error("Setup session superseded.");
  return user;
}

// For API routes: 401 JSON if not logged in. Sets req.user to the full
// Mongoose User document (not just the JWT payload) so route handlers
// always see current role/active/clientOrgId, not a stale snapshot.
function requireAuth(req, res, next) {
  loadUserFromRequest(req)
    .then((user) => {
      req.user = user;
      if (needsMfaSetup(user) && !MFA_SETUP_ALLOWED.test(req.originalUrl)) {
        return res.status(403).json({ error: "Set up two-factor login first.", code: "MFA_SETUP_REQUIRED" });
      }
      next();
    })
    .catch(() => {
      if (req.cookies?.[MFA_COOKIE_NAME]) {
        return res.status(401).json({ error: "Enter your two-factor code to finish signing in.", code: "MFA_REQUIRED" });
      }
      res.status(401).json({ error: "Not logged in or session expired." });
    });
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
      if (needsMfaSetup(user)) return res.redirect("/two-factor.html?setup=1");
      next();
    })
    .catch(() => {
      if (req.cookies?.[MFA_COOKIE_NAME]) return res.redirect(`/two-factor.html?next=${encodeURIComponent(req.originalUrl)}`);
      res.redirect("/login.html?reason=session_expired");
    });
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
  MFA_COOKIE_NAME,
  loadUserFromMfaToken,
  needsMfaSetup,
  twoFactorRequired,
  isInternal,
  COOKIE_NAME,
  SETUP_COOKIE_NAME,
  loadUserFromRequest,
  loadUserFromSetupToken,
  setSetupCookie,
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
