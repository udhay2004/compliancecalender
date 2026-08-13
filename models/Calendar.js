// models/Calendar.js
//
// A generated calendar is NEVER shown to anyone as "trusted" the moment
// Claude produces it. It's saved with status "pending_review". A human
// (any logged-in team member, per the current review model) has to open
// it, optionally edit items, and Approve or Reject it before it's treated
// as a real source of truth. This is the human-in-the-loop step that was
// missing before.

const mongoose = require("mongoose");

const itemSchema = new mongoose.Schema(
  {
    category: {
      type: String,
      enum: [
        "Mandatory Annual",
        "Conditional",
        "Transfer Pricing",
        "Foreign Reporting (ODI/FEMA)",
        "Event-Based",
      ],
      required: true,
    },
    compliance_name: { type: String, required: true },
    due_date: { type: String, required: true },
    applicable_to: { type: String, default: "" },
    description: { type: String, default: "" },
    authority: { type: String, default: "" },
    source_url: { type: String, default: "" },
    confidence: { type: String, enum: ["high", "medium", "low"], default: "medium" },
    // Set true once a reviewer edits this specific line item, so the diff
    // between "what Claude said" and "what a human corrected" isn't lost.
    editedByReviewer: { type: Boolean, default: false },
  },
  { _id: false }
);

const profileSchema = new mongoose.Schema(
  {
    companyName: String,
    state: String,
    entityType: String,
    taxStatus: String,
    incorpDate: String,
    fyStart: String,
    fyEnd: String,
    hasForeignParent: Boolean,
    odiDone: String,
    odiInvestorType: String,
    // States where the company has W-2 employees, OTHER than the state of
    // incorporation. Payroll withholding, state unemployment insurance
    // registration, and (in some states) paid-leave contributions are
    // governed by the EMPLOYEE's work state, not the company's home
    // state — a company incorporated in Texas with an employee working
    // from North Dakota still has to register and withhold in North
    // Dakota. Kept separate from `state` (state of incorporation) on
    // purpose so the two are never conflated.
    employeeStates: { type: [String], default: [] },
    // Average gross receipts per quarter, used to determine whether
    // certain state Gross Receipts Tax (GRT) filings are triggered.
    // Below the relevant state's small-business exemption threshold, the
    // company is generally exempt from the GRT FILING itself, but a
    // local business license is typically still required regardless of
    // revenue — see the GRT handling notes in lib/claude.js.
    quarterlyGrossReceipts: Number,
  },
  { _id: false }
);

const calendarSchema = new mongoose.Schema(
  {
    // Plain username string, not a User ref — the app now has a single
    // shared login for the whole team rather than per-person accounts.
    createdBy: { type: String, required: true },
    profile: { type: profileSchema, required: true },
    items: { type: [itemSchema], default: [] },

    status: {
      type: String,
      enum: ["pending_review", "approved", "rejected"],
      default: "pending_review",
      index: true,
    },
    reviewedBy: { type: String, default: null },
    reviewedAt: { type: Date, default: null },
    reviewNotes: { type: String, default: "" },

    // Where the item data came from, for transparency in the UI:
    // "cache" = fully from StateComplianceCache, no live research needed
    // "live"  = fresh Claude + web_search research was run
    // "mixed" = cache used for base items, live call for FY-specific/ODI parts
    sourceMode: { type: String, enum: ["cache", "live", "mixed"], default: "live" },
  },
  { timestamps: true }
);

calendarSchema.index({ createdBy: 1, createdAt: -1 });

module.exports = mongoose.model("Calendar", calendarSchema);
