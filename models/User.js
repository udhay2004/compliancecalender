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

const ROLES = ["client", "staff", "admin", "super_admin"];
const ROLE_RANK = { client: 0, staff: 1, admin: 2, super_admin: 3 };

const userSchema = new mongoose.Schema(
  {
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    passwordHash: { type: String, required: true },
    name: { type: String, trim: true, default: "" },
    role: { type: String, enum: ROLES, required: true },
    // Required and ONLY meaningful for role "client" — every other role
    // must leave this null. Enforced in the pre-validate hook below so
    // it's impossible to accidentally create a staff/admin account that
    // is also (incorrectly) scoped to a client org.
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
  next();
});

userSchema.methods.setPassword = async function (plainPassword) {
  this.passwordHash = await bcrypt.hash(plainPassword, 10);
};

userSchema.methods.checkPassword = function (plainPassword) {
  return bcrypt.compare(plainPassword, this.passwordHash);
};

userSchema.methods.toSafeJSON = function () {
  return {
    id: this._id,
    email: this.email,
    name: this.name,
    role: this.role,
    clientOrgId: this.clientOrgId,
    active: this.active,
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
