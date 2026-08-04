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

const userSchema = new mongoose.Schema(
  {
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    passwordHash: { type: String, required: true },
    name: { type: String, trim: true, default: "" },
    role: { type: String, enum: ["member", "admin"], default: "member" },
  },
  { timestamps: true }
);

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
