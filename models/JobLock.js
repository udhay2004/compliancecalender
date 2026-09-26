// models/JobLock.js — see lib/jobLock.js.
const mongoose = require("mongoose");

const jobLockSchema = new mongoose.Schema({
  _id: { type: String, required: true }, // e.g. "reminders:2026-09-26"
  owner: { type: String, default: "" },  // which server copy holds it
  lockedUntil: { type: Date, required: true },
  finishedAt: { type: Date, default: null },
  // Old locks are removed by MongoDB automatically.
  expiresAt: { type: Date, required: true, index: { expireAfterSeconds: 0 } },
});

module.exports = mongoose.model("JobLock", jobLockSchema);
