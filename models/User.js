// models/User.js
//
// Real per-person accounts, replacing the old single-shared-login design
// (see the history of routes/auth.routes.js / middleware/auth.js — the
// app used to just compare against one hardcoded AUTH_USERNAME/PASSWORD
// pair in .env, with no roles at all). That doesn't work anymore now
// that there are four genuinely different levels of access:
//
//   super_admin - the business owner ("great admin"). Full access,
//                 INCLUDING managing other admins. There should only
//                 ever be one or two of these.
//   admin       - day-to-day operator ("tech admin"). Can manage staff
//                 accounts and client orgs, generate/review calendars,
//                 everything except managing other admins/super_admins.
//   staff       - internal team members. Generate calendars, review
//                 client uploads, upload certificates. Cannot manage
//                 user accounts.
//   client      - portal-only. Scoped to exactly ONE ClientOrg via
//                 clientOrgId below — every query on the client-facing
//                 routes must filter by this, never trust a client to
//                 supply their own org id.
//
// ROLE_RANK below gives a simple ordering so route guards can express
// "admin or higher" as one comparison instead of listing role strings
// everywhere and risking a typo silently opening a hole.

const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");

// "client" accounts created via Google sign-in each get their own
// auto-created ClientOrg workspace (see routes/auth.routes.js's
// /google/callback) — same instant-signup pattern as Slack/Notion.
const ROLES = ["client", "staff", "admin", "super_admin"];
const ROLE_RANK = { client: 0, staff: 1, admin: 2, super_admin: 3 };

const userSchema = new mongoose.Schema(
  {
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    // Optional now: a Google-only account never sets this. Enforced
    // instead by the pre-validate hook below, which requires EITHER a
    // passwordHash OR a googleId — never neither.
    passwordHash: { type: String, default: null },
    // Set once, on first successful Google sign-in — either on a brand
    // new auto-created client account, or on an existing account whose
    // email matched (see routes/auth.routes.js's /google/callback).
    // unique + sparse so many users can each have googleId: null
    // without tripping the unique index.
    // No `default: null` here on purpose: a sparse unique index only
    // skips documents where the field is genuinely ABSENT. Setting a
    // default of null means every non-Google account writes an explicit
    // null into this field, which defeats the sparse behavior — the
    // first such account claims the one allowed "null", and every
    // account created after it hits a duplicate-key error on this
    // index. Leaving the field unset for non-Google accounts is what
    // lets any number of them coexist.
    googleId: { type: String, unique: true, sparse: true },
    name: { type: String, trim: true, default: "" },
    role: { type: String, enum: ROLES, required: true },
    // Which internal team an operational account belongs to. Only
    // meaningful for role "staff" — this is what makes tech@ and
    // finance@ land on two genuinely different dashboards instead of
    // one shared staff screen. Left "" for admin/super_admin/client.
    department: { type: String, enum: ["", "tech", "finance"], default: "" },
    // True between "the account was created by an admin/seed script"
    // and "the person finished their first OTP login and chose a
    // password". While true the account has NO passwordHash at all, so
    // there is nothing to guess and POST /login can never succeed for
    // it — the only way in is an OTP to the mailbox that owns the
    // address (see routes/auth.routes.js).
    mustSetPassword: { type: Boolean, default: false },
    // Bumped on every password change and on "log out everywhere".
    // Embedded in the JWT and re-checked on every request, so changing
    // a password instantly kills every other session that account had
    // open — the thing a 30-day cookie would otherwise prevent, and
    // what Facebook/Instagram do when you reset a password.
    tokenVersion: { type: Number, default: 0 },
    // --- Two-factor login (staff; lib/totp.js, routes/auth.routes.js) ---
    // Secrets are stored encrypted. totpLastUsedStep stops a code being
    // used twice; failed attempts lock the code step for 15 minutes.
    totpEnabled: { type: Boolean, default: false },
    totpSecret: { type: String, default: null },
    totpPendingSecret: { type: String, default: null },
    totpLastUsedStep: { type: Number, default: -1 },
    totpRecoveryCodes: { type: [String], default: [] }, // hashed, one-time
    totpEnabledAt: { type: Date, default: null },
    totpFailedAttempts: { type: Number, default: 0 },
    totpLockedUntil: { type: Date, default: null },
    passwordUpdatedAt: { type: Date, default: null },
    lastLoginAt: { type: Date, default: null },
    // Brute-force brake for the OTP step, per account rather than per
    // IP — an attacker rotating IPs still burns the same counter.
    failedOtpAttempts: { type: Number, default: 0 },
    lockedUntil: { type: Date, default: null },
    // Required and ONLY meaningful for role "client" — every other role
    // must leave this null. Enforced in the pre-validate hook below so it's impossible to accidentally create
    // a staff/admin account that is also (incorrectly) scoped to a
    // client org.
    clientOrgId: { type: mongoose.Schema.Types.ObjectId, ref: "ClientOrg", default: null },
    active: { type: Boolean, default: true },
  },
  { timestamps: true }
);

userSchema.pre("validate", function (next) {
  if (this.role === "client" && !this.clientOrgId) {
    return next(new Error("clientOrgId is required for role 'client'."));
  }
  if (this.role !== "client" && this.clientOrgId) {
    return next(new Error("clientOrgId must be null for any role other than 'client'."));
  }
  // An account awaiting its first OTP login legitimately has neither a
  // password nor a Google link yet — that's the whole point of
  // mustSetPassword. Every other account still needs one of the two.
  if (!this.passwordHash && !this.googleId && !this.mustSetPassword) {
    return next(new Error("A user needs either a passwordHash, a googleId, or mustSetPassword."));
  }
  if (this.role !== "staff" && this.department) {
    return next(new Error("department is only meaningful for role 'staff'."));
  }
  next();
});

userSchema.methods.setPassword = async function (plainPassword) {
  // Cost 12 rather than the old 10: ~4x slower to verify (still under
  // 250ms on a normal server, imperceptible on a login) but 4x more
  // expensive for anyone brute-forcing a stolen hash dump.
  this.passwordHash = await bcrypt.hash(plainPassword, 12);
  this.mustSetPassword = false;
  this.passwordUpdatedAt = new Date();
  this.tokenVersion = (this.tokenVersion || 0) + 1;
  this.failedOtpAttempts = 0;
  this.lockedUntil = null;
};

// True while this account is temporarily frozen after too many bad OTP
// codes. Read this before sending or checking a code.
userSchema.methods.isLocked = function () {
  return Boolean(this.lockedUntil && this.lockedUntil > new Date());
};

userSchema.methods.checkPassword = function (plainPassword) {
  // Google-only accounts have no passwordHash — fail closed rather than
  // letting bcrypt.compare throw on a null hash.
  if (!this.passwordHash) return Promise.resolve(false);
  return bcrypt.compare(plainPassword, this.passwordHash);
};

userSchema.methods.toSafeJSON = function () {
  return {
    id: this._id,
    email: this.email,
    name: this.name,
    role: this.role,
    department: this.department,
    twoFactorEnabled: Boolean(this.totpEnabled),
    clientOrgId: this.clientOrgId,
    active: this.active,
    mustSetPassword: this.mustSetPassword,
    lastLoginAt: this.lastLoginAt,
  };
};

userSchema.statics.ROLES = ROLES;
userSchema.statics.ROLE_RANK = ROLE_RANK;
// True if `role` is at least as senior as `minRole` — e.g.
// User.hasAtLeast("admin", "staff") === true, User.hasAtLeast("staff", "admin") === false.
userSchema.statics.hasAtLeast = function (role, minRole) {
  return (ROLE_RANK[role] ?? -1) >= (ROLE_RANK[minRole] ?? Infinity);
};

module.exports = mongoose.model("User", userSchema);
