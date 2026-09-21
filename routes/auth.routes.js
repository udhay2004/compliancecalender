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
const ClientOrg = require("../models/ClientOrg");
const Calendar = require("../models/Calendar");
const {
  setSessionCookie,
  setSetupCookie,
  clearSessionCookie,
  requireAuth,
  loadUserFromSetupToken,
  loadUserFromRequest,
} = require("../middleware/auth");
const { getAuthUrl, verifyCodeAndGetProfile } = require("../lib/google");
const otp = require("../lib/otp");
const { checkPassword, MIN_LENGTH } = require("../lib/passwordPolicy");
const { logActivity } = require("../lib/auditLog");

const router = express.Router();

// Login has no other guard (no CAPTCHA, no MFA), so a per-IP throttle is
// the only thing standing between this route and a password-guessing
// script. 10 attempts / 15 min is generous for a real person who mistypes
// a password a few times, tight for automated guessing. Keyed by IP, not
// by email, so this can't be used to lock a specific person's account out
// by repeatedly failing their email on purpose.
// Each limiter gets its own explicit store rather than the implicit
// default, so the counters can be inspected or cleared deliberately —
// by the test suite, and by anyone who has to unblock a colleague who
// locked themselves out on the office IP.
const rateLimitStores = {
  login: new rateLimit.MemoryStore(),
  otpRequest: new rateLimit.MemoryStore(),
  otpVerify: new rateLimit.MemoryStore(),
};

const loginLimiter = rateLimit({
  store: rateLimitStores.login,
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
  if (user.isLocked()) {
    return res.status(429).json({ error: "Too many failed attempts. Try again in a few minutes." });
  }
  // An account that hasn't chosen a password yet has no passwordHash at
  // all, so checkPassword would fail anyway — but say so explicitly,
  // otherwise a brand new staff member who tries to guess their way in
  // just sees "invalid password" forever with no idea what to do.
  if (user.mustSetPassword) {
    return res.status(409).json({
      error: "This account hasn't set a password yet. Sign in with an email code first.",
      needsOtp: true,
    });
  }
  const ok = await user.checkPassword(password);
  if (!ok) {
    return res.status(401).json({ error: "Invalid email or password." });
  }

  user.lastLoginAt = new Date();
  user.failedOtpAttempts = 0;
  await user.save();

  setSessionCookie(res, user);
  return res.json({ user: user.toSafeJSON(), redirect: destinationFor(user) });
});

// POST /api/auth/logout-everywhere — invalidate every session this
// account has open anywhere, including this one. The "I left myself
// logged in on a shared machine" button.
router.post("/logout-everywhere", requireAuth, async (req, res) => {
  req.user.tokenVersion = (req.user.tokenVersion || 0) + 1;
  await req.user.save();
  clearSessionCookie(res);
  return res.json({ ok: true });
});

router.post("/logout", (req, res) => {
  clearSessionCookie(res);
  return res.json({ ok: true });
});

router.get("/me", requireAuth, (req, res) => {
  return res.json({ user: req.user.toSafeJSON() });
});

// ---------------------------------------------------------------------
// Email-code (OTP) sign-in for internal accounts
//
// The flow, end to end:
//
//   1. POST /otp/request  { email, portal }   → a 6-digit code is mailed
//   2. POST /otp/verify   { email, code }     → either a full session, or
//                                               setupRequired:true plus a
//                                               15-minute setup cookie
//   3. POST /password/set { password }        → password stored, full session
//
// Design decisions worth keeping if this is edited later:
//
//   * Step 1 ALWAYS answers "if that address has an account, a code is
//     on its way", with the same status and shape whether or not it
//     does. Anything else turns this endpoint into a directory of who
//     works here.
//   * `portal` is checked against the account's real role. The UI has a
//     staff door and a super-admin door; a browser can obviously post
//     whichever it likes, so the server has to be the one that decides
//     a staff code can't be redeemed at the super-admin door.
//   * Client accounts can't use this at all — it exists for the
//     internal team. Clients keep Google sign-in and passwords.
// ---------------------------------------------------------------------

// Which door on the login page maps to which roles.
const PORTALS = {
  staff: ["staff"],
  admin: ["admin"],
  super_admin: ["super_admin"],
};

// Where each account type lands after a successful sign-in.
function destinationFor(user) {
  if (user.role === "client") return "/portal.html";
  return "/dashboard.html";
}

// Deliberately tighter than the password limiter: each request here
// sends a real email, so an unthrottled endpoint is both a login oracle
// and a way to get our sending domain marked as spam.
const otpRequestLimiter = rateLimit({
  store: rateLimitStores.otpRequest,
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many code requests. Please wait a few minutes and try again." },
});

const otpVerifyLimiter = rateLimit({
  store: rateLimitStores.otpVerify,
  windowMs: 15 * 60 * 1000,
  max: 12,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many attempts. Please wait a few minutes and try again." },
});

// The one reply this endpoint is allowed to give, success or not.
const OTP_SENT_MESSAGE =
  "If that address has an account, a sign-in code is on its way. It expires in " +
  `${otp.TTL_MINUTES} minutes.`;

router.post("/otp/request", otpRequestLimiter, async (req, res) => {
  const { email, portal } = req.body || {};
  if (!email || typeof email !== "string") {
    return res.status(400).json({ error: "Email is required." });
  }
  const normalized = email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) {
    return res.status(400).json({ error: "That doesn't look like a valid email address." });
  }

  // Everything below either sends a code or doesn't, and says the same
  // thing regardless. Failures are logged server-side where only we can
  // see them.
  try {
    const user = await User.findOne({ email: normalized });

    if (!user) {
      console.warn(`[otp] Code requested for unknown address: ${normalized}`);
    } else if (!user.active) {
      console.warn(`[otp] Code requested for deactivated account: ${normalized}`);
    } else if (user.role === "client") {
      console.warn(`[otp] Client account tried the internal code login: ${normalized}`);
    } else if (portal && PORTALS[portal] && !PORTALS[portal].includes(user.role)) {
      // Right person, wrong door. Same silence as everything else —
      // telling them "you're staff, not a super admin" confirms both
      // that the account exists and what it can do.
      console.warn(`[otp] ${normalized} (${user.role}) requested a code at the "${portal}" door.`);
    } else if (user.isLocked()) {
      console.warn(`[otp] Code requested for locked account: ${normalized}`);
    } else if (await otp.isInCooldown(normalized)) {
      console.warn(`[otp] Code requested again within the cooldown for ${normalized}`);
    } else {
      const code = await otp.issueCode({
        email: normalized,
        user,
        requestIp: req.ip,
      });
      await otp.sendLoginCode({ to: normalized, code, name: user.name });
      console.log(`[otp] Sign-in code sent to ${normalized} (${user.role}).`);
    }
  } catch (err) {
    // A provider outage is the one case where staying silent would be
    // cruel: the person would sit watching an inbox that will never
    // get anything. Everything else stays indistinguishable.
    console.error("[otp] Failed to send sign-in code:", err.message);
    return res.status(502).json({
      error: "We couldn't send the code right now. Please try again in a minute, or contact your administrator.",
    });
  }

  return res.json({ ok: true, message: OTP_SENT_MESSAGE, expiresInMinutes: otp.TTL_MINUTES });
});

router.post("/otp/verify", otpVerifyLimiter, async (req, res) => {
  const { email, code } = req.body || {};
  if (!email || !code) {
    return res.status(400).json({ error: "Email and code are required." });
  }
  const normalized = String(email).trim().toLowerCase();
  const cleanedCode = String(code).replace(/\D/g, "");

  const user = await User.findOne({ email: normalized });
  // Same vague message for "no such account" and "wrong code", so this
  // endpoint can't be used to enumerate addresses either.
  const INVALID = "That code isn't right, or it has expired. Request a new one.";

  if (!user || !user.active || user.role === "client") {
    return res.status(401).json({ error: INVALID });
  }
  if (user.isLocked()) {
    return res.status(429).json({
      error: `Too many incorrect codes. This account is locked for ${otp.LOCK_MINUTES} minutes.`,
    });
  }

  const result = await otp.verifyCode({ email: normalized, code: cleanedCode });

  if (!result.ok) {
    user.failedOtpAttempts = (user.failedOtpAttempts || 0) + 1;
    if (user.failedOtpAttempts >= otp.MAX_ACCOUNT_FAILURES) {
      user.lockedUntil = new Date(Date.now() + otp.LOCK_MINUTES * 60 * 1000);
      user.failedOtpAttempts = 0;
      await user.save();
      console.warn(`[otp] Locked ${normalized} after repeated bad codes.`);
      return res.status(429).json({
        error: `Too many incorrect codes. This account is locked for ${otp.LOCK_MINUTES} minutes.`,
      });
    }
    await user.save();
    return res.status(401).json({ error: INVALID });
  }

  user.failedOtpAttempts = 0;
  user.lockedUntil = null;

  // First time in: hand out a setup token, NOT a session. Until a
  // password exists this account can't do anything else.
  if (user.mustSetPassword || !user.passwordHash) {
    await user.save();
    setSetupCookie(res, user);
    return res.json({
      ok: true,
      setupRequired: true,
      minPasswordLength: MIN_LENGTH,
      email: user.email,
    });
  }

  user.lastLoginAt = new Date();
  await user.save();
  setSessionCookie(res, user);
  return res.json({
    ok: true,
    setupRequired: false,
    user: user.toSafeJSON(),
    redirect: destinationFor(user),
  });
});

// POST /api/auth/password/set
//
// Accepts EITHER the 15-minute setup cookie (first-time setup, straight
// after an OTP) or a normal logged-in session (changing an existing
// password, which additionally requires the current one). It never
// accepts an email in the body — the account always comes from a signed
// token, so this can't be pointed at somebody else's account.
router.post("/password/set", async (req, res) => {
  const { password, confirmPassword, currentPassword } = req.body || {};

  if (confirmPassword !== undefined && password !== confirmPassword) {
    return res.status(400).json({ error: "The two passwords don't match." });
  }

  let user = null;
  let viaSetupToken = false;
  try {
    user = await loadUserFromSetupToken(req);
    viaSetupToken = true;
  } catch {
    try {
      // requireAuth isn't mounted on this route — the first-time setup
      // path has no session yet — so resolve the session by hand.
      user = await loadUserFromRequest(req);
    } catch {
      return res.status(401).json({
        error: "Your setup link has expired. Request a new sign-in code and try again.",
      });
    }
  }

  // Changing an existing password requires proving you know the old one
  // — otherwise a borrowed unlocked laptop is a permanent takeover.
  if (!viaSetupToken) {
    if (!currentPassword) {
      return res.status(400).json({ error: "Enter your current password." });
    }
    const ok = await user.checkPassword(currentPassword);
    if (!ok) {
      return res.status(401).json({ error: "Your current password isn't right." });
    }
  }

  const verdict = checkPassword(password, { email: user.email, name: user.name });
  if (!verdict.ok) {
    return res.status(400).json({ error: verdict.error });
  }

  // Bumps tokenVersion, which invalidates every session anywhere.
  await user.setPassword(password);
  user.lastLoginAt = new Date();
  await user.save();

  // Then immediately issue a fresh session so the person who just set
  // the password stays signed in on THIS device only.
  setSessionCookie(res, user);

  otp.sendPasswordChangedNotice({ to: user.email, name: user.name })
    .catch((err) => console.error("[otp] Password-change notice failed (non-fatal):", err.message));

  logActivity({
    action: viaSetupToken ? "password_set" : "password_changed",
    actor: user,
    summary: viaSetupToken
      ? `${user.email} set their password for the first time.`
      : `${user.email} changed their password.`,
  });

  return res.json({
    ok: true,
    user: user.toSafeJSON(),
    redirect: destinationFor(user),
  });
});


// ---------------------------------------------------------------------
// Google sign-in
//
// GET /google           — redirects the browser to Google's consent screen
// GET /google/callback  — Google redirects back here with ?code=...&state=...
//
// Instant access, no admin approval step — this app has no public
// self-serve signup form otherwise, so Google sign-in IS the signup
// flow. A brand-new Google email gets its own ClientOrg (company
// workspace) created automatically and lands as role:"client" scoped
// to it, same pattern as "sign up with Google" on Slack/Notion/etc:
// each new person gets their own workspace, not shared access to
// someone else's data.
//
// If the Google email matches an EXISTING account (any role — client,
// staff, admin), that account is linked (googleId set on it) rather
// than creating a duplicate — same person, new login method, existing
// role/permissions untouched.
// ---------------------------------------------------------------------

const GOOGLE_STATE_COOKIE = "cc_oauth_state";
const PENDING_CALENDAR_COOKIE = "cc_pending_calendar";

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

  // "Start Filing" links here as /auth/google?calendarId=<id>&flow=start_filing
  // so the calendar they just generated anonymously can be attached to
  // the account they're about to create/log into, on the other side of
  // the OAuth round trip.
  if (req.query.calendarId) {
    res.cookie(PENDING_CALENDAR_COOKIE, String(req.query.calendarId), {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      maxAge: 10 * 60 * 1000,
    });
  }

  res.redirect(getAuthUrl(state));
});

router.get("/google/callback", async (req, res) => {
  const { code, state, error } = req.query;
  const expectedState = req.cookies?.[GOOGLE_STATE_COOKIE];
  const pendingCalendarId = req.cookies?.[PENDING_CALENDAR_COOKIE];
  res.clearCookie(GOOGLE_STATE_COOKIE);
  res.clearCookie(PENDING_CALENDAR_COOKIE);

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
    // with the same email and link it, rather than creating a duplicate
    // or a second account for the same person.
    user = await User.findOne({ email: profile.email });
    if (user) {
      user.googleId = profile.googleId;
      if (!user.name && profile.name) user.name = profile.name;
      await user.save();
    }
  }

  if (!user) {
    // Genuinely new person, instant signup: give them their own
    // ClientOrg workspace and a client account scoped to it. Name the
    // org from their email domain as a reasonable default — they can
    // rename it later from the portal, same as any SaaS "workspace
    // name" you're free to change after signup.
    const domain = profile.email.split("@")[1] || "";
    const orgName = profile.name ? `${profile.name}'s Company` : domain || profile.email;

    const org = await ClientOrg.create({
      name: orgName,
      primaryContactEmail: profile.email,
      primaryContactName: profile.name,
      createdBy: "google-signup",
    });

    user = await User.create({
      email: profile.email,
      name: profile.name,
      googleId: profile.googleId,
      role: "client",
      clientOrgId: org._id,
    });
  }

  if (!user.active) {
    return res.redirect("/login.html?reason=account_deactivated");
  }

  setSessionCookie(res, user);

  // Link the calendar they generated anonymously (before this login) to
  // the account they just created/signed into. Only ever touches a
  // calendar that's still unclaimed public data (source:"public",
  // clientOrgId: null) — never overwrites a calendar that already
  // belongs to someone. Auto-approved on link: no staff review step
  // here, it goes straight from "generated" to "visible in the portal"
  // the moment the lead logs in.
  let linkedCalendarId = null;
  if (pendingCalendarId && user.role === "client" && user.clientOrgId) {
    try {
      const linked = await Calendar.findOneAndUpdate(
        { _id: pendingCalendarId, source: "public", clientOrgId: null },
        {
          $set: {
            clientOrgId: user.clientOrgId,
            status: "approved",
            reviewedBy: "auto",
            reviewedAt: new Date(),
          },
        },
        { new: true }
      );
      if (linked) linkedCalendarId = linked._id.toString();
    } catch (err) {
      console.error("[google-callback] Failed to link pending calendar (non-fatal):", err.message);
    }
  }

  const portalUrl = linkedCalendarId ? `/portal.html?calendar=${linkedCalendarId}` : "/portal.html";
  res.redirect(user.role === "client" ? portalUrl : "/");
});

module.exports = router;
// Exposed for the test suite and for operational use; clearing a store
// resets the per-IP counters for that endpoint.
module.exports.rateLimitStores = rateLimitStores;
