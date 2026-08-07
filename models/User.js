// models/User.js
//
// Everyone who logs in can review/approve calendars (small trusted team
// model, per spec) — so "role" here is currently just member/admin, where
// admin is only used for account housekeeping (e.g. deactivating a user),
// NOT for gating the review step. If the team grows and you want to
// restrict reviewing later, add a `canReview` boolean and check it in
// routes/calendar.routes.js instead of loosening this model.

const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");
const crypto = require("crypto");

const userSchema = new mongoose.Schema(
  {
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    passwordHash: { type: String, required: true },
    name: { type: String, trim: true, default: "" },
    role: { type: String, enum: ["member", "admin"], default: "member" },
    // IMPORTANT: default is "approved", NOT "pending". Mongoose applies
    // schema defaults on hydration for any field missing from the stored
    // document — so if this defaulted to "pending", every user created
    // before this field existed would suddenly fail the login gate the
    // next time they're read from the DB. routes/auth.routes.js sets
    // status to "pending" explicitly at signup time instead, so only
    // brand-new signups go through the approval gate; anyone already in
    // the database is treated as already-approved.
    status: { type: String, enum: ["pending", "approved", "rejected"], default: "approved" },
    approvalToken: { type: String, default: null, select: false },
    approvalTokenExpires: { type: Date, default: null, select: false },
  },
  { timestamps: true }
);

// Generates a fresh, random, single-use token for the approve/reject email
// links and sets it (with a 7-day expiry) on the document. Caller is
// responsible for saving the document afterward.
userSchema.methods.generateApprovalToken = function () {
  const token = crypto.randomBytes(32).toString("hex");
  this.approvalToken = token;
  this.approvalTokenExpires = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  return token;
};

userSchema.methods.setPassword = async function (plainPassword) {
  this.passwordHash = await bcrypt.hash(plainPassword, 10);
};

userSchema.methods.checkPassword = function (plainPassword) {
  return bcrypt.compare(plainPassword, this.passwordHash);
};

userSchema.methods.toSafeJSON = function () {
  return { id: this._id, email: this.email, name: this.name, role: this.role };
};

module.exports = mongoose.model("User", userSchema);
