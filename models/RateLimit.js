// models/RateLimit.js — request counters for lib/rateLimitStore.js.
const mongoose = require("mongoose");

const rateLimitSchema = new mongoose.Schema({
  _id: { type: String, required: true }, // "<limiter>:<ip or account>"
  hits: { type: Number, default: 0 },
  // MongoDB deletes the counter once its window is over.
  resetAt: { type: Date, required: true, index: { expireAfterSeconds: 0 } },
}, { versionKey: false });

module.exports = mongoose.model("RateLimit", rateLimitSchema);
