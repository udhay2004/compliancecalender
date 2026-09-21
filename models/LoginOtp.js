// models/LoginOtp.js
//
// One short-lived, single-use email code. The code itself is NEVER
// stored — only an HMAC of it (see lib/otp.js), for the same reason
// passwords are only ever stored as bcrypt hashes: if this collection
// leaked tomorrow, the rows would be useless to whoever took them.
//
// Design notes that matter for security, not just tidiness:
//
//   * expiresAt has a TTL index, so MongoDB physically deletes expired
//     codes rather than leaving a growing pile of near-misses around.
//   * attempts is capped by the verify route. Six digits is only a
//     million possibilities, which a script clears in minutes if you
//     let it guess freely — the cap is what makes a 6-digit code safe.
//   * consumedAt makes a code single-use even inside its 10-minute
//     window, so a code read off a shoulder-surfed screen or a forwarded
//     email can't be replayed after the real person has used it.
//   * purpose is checked on verify, so a code minted for one flow can
//     never be redeemed in another.

const mongoose = require("mongoose");

const PURPOSES = ["login"];

const loginOtpSchema = new mongoose.Schema(
  {
    // Denormalized rather than a User ref: the request route must behave
    // identically for an address that has no account, otherwise the
    // response time and shape would quietly tell an attacker which of
    // our staff addresses are real.
    email: { type: String, required: true, lowercase: true, trim: true, index: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    codeHash: { type: String, required: true },
    purpose: { type: String, enum: PURPOSES, default: "login" },
    expiresAt: { type: Date, required: true },
    attempts: { type: Number, default: 0 },
    consumedAt: { type: Date, default: null },
    // Kept only for the audit trail on a suspicious login, and only the
    // address the request arrived from.
    requestIp: { type: String, default: "" },
  },
  { timestamps: true }
);

// MongoDB's TTL monitor deletes documents once expiresAt is in the past.
loginOtpSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
loginOtpSchema.index({ email: 1, createdAt: -1 });

loginOtpSchema.statics.PURPOSES = PURPOSES;

module.exports = mongoose.model("LoginOtp", loginOtpSchema);
