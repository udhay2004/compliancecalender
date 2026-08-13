// models/EmployeeStateCache.js
//
// Company-agnostic payroll withholding / State Unemployment Insurance
// (SUI) registration rules, keyed by STATE ONLY (not entityType — these
// registrations don't meaningfully differ by entity type the way tax
// filings do). This exists so that "we have an employee working from
// [state]" is only ever sent to the live Claude + web_search API ONCE
// per state, the same way StateCache avoids re-researching a state of
// incorporation for every new company. Every company after the first
// that lists an employee in an already-cached, still-fresh state costs
// zero API credits for that state.
//
// Same TTL pattern as StateCache: anything older than STALE_AFTER_DAYS
// is treated as a miss and re-researched.

const mongoose = require("mongoose");

const STALE_AFTER_DAYS = 120;

const cacheItemSchema = new mongoose.Schema(
  {
    compliance_name: { type: String, required: true },
    due_date_rule: { type: String, required: true },
    applicable_to: { type: String, default: "" },
    description: { type: String, default: "" },
    authority: { type: String, default: "" },
    source_url: { type: String, default: "" },
    confidence: { type: String, enum: ["high", "medium", "low"], default: "medium" },
  },
  { _id: false }
);

const employeeStateCacheSchema = new mongoose.Schema(
  {
    state: { type: String, required: true, uppercase: true, trim: true, unique: true },
    items: { type: [cacheItemSchema], default: [] },
    generatedAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

employeeStateCacheSchema.statics.isFresh = function (doc) {
  if (!doc) return false;
  const ageMs = Date.now() - new Date(doc.generatedAt).getTime();
  return ageMs < STALE_AFTER_DAYS * 24 * 60 * 60 * 1000;
};

employeeStateCacheSchema.statics.STALE_AFTER_DAYS = STALE_AFTER_DAYS;

// Same normalization caveat as StateCache.normalizeState — schema-level
// uppercase only fires on set, not on query casting, so callers must
// normalize before querying too.
employeeStateCacheSchema.statics.normalizeState = function (state) {
  return (state || "").toUpperCase().trim();
};

module.exports = mongoose.model("EmployeeStateCache", employeeStateCacheSchema);
