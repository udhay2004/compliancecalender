// models/OdiCache.js
//
// Same idea as StateCache, but for the "Foreign Reporting (ODI/FEMA)"
// section: generic RBI/FEMA Overseas Direct Investment rules (Annual
// Performance Report, Foreign Liabilities & Assets Return, event-based
// reporting) are the SAME for every company with a given investor type —
// they don't depend on the US state, entity type, or fiscal year of the
// downstream US company. So instead of re-running a live web_search call
// for this section on every single "odiDone = Yes" generation (which is
// what used to happen), we research it once per investor type and reuse
// it, exactly like StateCache does for state/federal items.
//
// Keyed by investorType: "Indian Company" | "Resident Individual" |
// "Other Foreign Entity" — the three options offered in app.html.

const mongoose = require("mongoose");

const STALE_AFTER_DAYS = 120;

const odiCacheItemSchema = new mongoose.Schema(
  {
    compliance_name: { type: String, required: true },
    // Kept as a RULE (e.g. "Annually, by 31 December of the FY the
    // investment relates to") — same pattern as StateCache's
    // due_date_rule, so the finalize step can compute the specific date.
    due_date_rule: { type: String, required: true },
    applicable_to: { type: String, default: "" },
    description: { type: String, default: "" },
    authority: { type: String, default: "" },
    source_url: { type: String, default: "" },
    confidence: { type: String, enum: ["high", "medium", "low"], default: "medium" },
  },
  { _id: false }
);

const odiCacheSchema = new mongoose.Schema(
  {
    investorType: { type: String, required: true, trim: true },
    items: { type: [odiCacheItemSchema], default: [] },
    generatedAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

odiCacheSchema.index({ investorType: 1 }, { unique: true });

odiCacheSchema.statics.isFresh = function (doc) {
  if (!doc) return false;
  const ageMs = Date.now() - new Date(doc.generatedAt).getTime();
  return ageMs < STALE_AFTER_DAYS * 24 * 60 * 60 * 1000;
};

odiCacheSchema.statics.STALE_AFTER_DAYS = STALE_AFTER_DAYS;

module.exports = mongoose.model("OdiCache", odiCacheSchema);
