// models/StateCache.js
//
// Company-agnostic compliance data, keyed by (state, entityType). Populated
// by scripts/seedStates.js in batches (default 15 states per run) so the
// first full pass over all 50 states + DC doesn't have to happen in one go
// and doesn't have to happen again for every new company.
//
// A "FEDERAL" pseudo-state document (entityType-specific, state-independent)
// covers IRS-level items that don't change per state.
//
// TTL: compliance rules do change (fee amounts, forms). Anything older than
// STALE_AFTER_DAYS is treated as a cache miss and re-researched live, so the
// data doesn't silently go stale forever.

const mongoose = require("mongoose");

const STALE_AFTER_DAYS = 120;

const cacheItemSchema = new mongoose.Schema(
  {
    category: {
      type: String,
      enum: ["Mandatory Annual", "Conditional", "Transfer Pricing", "Event-Based"],
      required: true,
    },
    compliance_name: { type: String, required: true },
    // Kept as a RULE, not a computed date, e.g. "15th day of 4th month
    // after FY end" or "1 March (Annually)" or "As Triggered" — the
    // company-specific computation happens at generation time, not here.
    due_date_rule: { type: String, required: true },
    applicable_to: { type: String, default: "" },
    description: { type: String, default: "" },
    authority: { type: String, default: "" },
    source_url: { type: String, default: "" },
    confidence: { type: String, enum: ["high", "medium", "low"], default: "medium" },
  },
  { _id: false }
);

const stateCacheSchema = new mongoose.Schema(
  {
    // Two-letter state code, or "FEDERAL" for the state-independent set.
    state: { type: String, required: true, uppercase: true, trim: true },
    entityType: { type: String, required: true, trim: true },
    items: { type: [cacheItemSchema], default: [] },
    generatedAt: { type: Date, default: Date.now },
    // Batch bookkeeping, so scripts/seedStates.js can report progress and
    // resume where it left off.
    batchNumber: { type: Number, default: null },
  },
  { timestamps: true }
);

stateCacheSchema.index({ state: 1, entityType: 1 }, { unique: true });

stateCacheSchema.statics.isFresh = function (doc) {
  if (!doc) return false;
  const ageMs = Date.now() - new Date(doc.generatedAt).getTime();
  return ageMs < STALE_AFTER_DAYS * 24 * 60 * 60 * 1000;
};

stateCacheSchema.statics.STALE_AFTER_DAYS = STALE_AFTER_DAYS;

// IMPORTANT: mongoose's schema-level `uppercase: true` setter only fires
// when SETTING a document field, not when casting query conditions. So
// every read/write path (seed script, generation orchestrator, this
// model) must normalize case itself before querying — this is the one
// shared place that does it, to avoid the two drifting apart.
stateCacheSchema.statics.normalizeState = function (state) {
  return (state || "").toUpperCase().trim();
};

module.exports = mongoose.model("StateCache", stateCacheSchema);
