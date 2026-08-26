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

    // --- Client-facing lifecycle (added for the portal) ---------------
    // Independent from the calendar-level `status` above on purpose: the
    // calendar-level status is "has a human verified this AI output at
    // all" (pending_review/approved/rejected), a one-time gate. This is
    // "where is THIS specific filing right now" — an ongoing, per-item
    // state that keeps changing long after the calendar was approved.
    clientStatus: {
      type: String,
      enum: ["Not Started", "Awaiting Documents", "Under Review", "Filed", "Overdue"],
      default: "Not Started",
    },
    paymentStatus: {
      type: String,
      enum: ["Not Invoiced", "Invoiced", "Paid", "Overdue"],
      default: "Not Invoiced",
    },
    // Fee for THIS item, set by staff (see PATCH /:id/items/:index/status
    // in calendar.routes.js) when they move paymentStatus to "Invoiced".
    // In paise, matching Razorpay's own unit. The client-facing payment
    // routes (routes/payments.routes.js) ALWAYS read the amount to
    // charge from here — never from anything the browser sends.
    feeAmountPaise: { type: Number, default: null },
    // Razorpay order/payment identifiers for the CURRENT payment attempt.
    razorpayOrderId: { type: String, default: null },
    razorpayPaymentId: { type: String, default: null },
    paidAt: { type: Date, default: null },
    // Append-only audit trail for support/dispute investigation.
    paymentEvents: {
      type: [
        {
          event: { type: String, required: true }, // "order_created" | "verify_ok" | "webhook_captured" | "webhook_failed"
          razorpayOrderId: String,
          razorpayPaymentId: String,
          at: { type: Date, default: Date.now },
        },
      ],
      default: [],
    },
    // Both the client's uploaded proof AND the certificate/acknowledgment
    // staff uploads back live here, distinguished by `type`. Files
    // themselves are NOT stored in Mongo — only a reference returned by
    // lib/storage.js (see that file for why: ephemeral hosting disks and
    // Mongo document size limits both make storing bytes here a bad
    // idea). `fileKey` is what lib/storage.js needs to actually fetch or
    // delete the file later; `fileUrl` is only ever a display hint, never
    // trusted for access control — every download goes through an
    // authenticated route that re-checks the requester owns this item.
    documents: {
      type: [
        {
          fileKey: { type: String, required: true },
          fileName: { type: String, required: true },
          fileUrl: { type: String, default: "" },
          uploadedBy: { type: String, required: true },
          uploadedAt: { type: Date, default: Date.now },
          type: { type: String, enum: ["client_upload", "certificate"], required: true },
        },
      ],
      default: [],
    },
    // Set by the reminders job (lib/reminders.js) so it doesn't re-email
    // the same person about the same item every single day.
    lastReminderSentAt: { type: Date, default: null },
    // Optional, staff-set actual calendar date this item is due. Kept
    // separate from `due_date` (a human-readable STRING like "15th day
    // of the 4th month after FY end (Annually)") on purpose — due_date
    // is what Claude produces and a person reads, but it's free text,
    // not something a reminders job can reliably compute "due in 7
    // days" from. Until every item has this set, due-date reminders
    // only cover items staff has dated; payment reminders (see
    // lib/reminders.js) don't depend on this at all and work today.
    dueDateActual: { type: Date, default: null },
  },
  { _id: false }
);

const profileSchema = new mongoose.Schema(
  {
    companyName: String,
    // Defaults to United States for every calendar generated before this
    // field existed. Non-US countries are NOT backed by StateCache yet —
    // they always take the live-research path in lib/claude.js (which
    // still needs a prompt update to stop assuming a US company; see
    // FRONTEND_BACKEND_NOTES.md) and are simply never cache-hits until a
    // presearched dataset is built for them the same way US states were.
    country: { type: String, default: "United States" },
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
    // The staff/admin user's email who generated this calendar (accounts
    // are real per-person now — see models/User.js). For source "public"
    // (see below) there is no logged-in user, so this is the literal
    // string "public" rather than a real email — never treat this as an
    // email address without checking `source` first.
    createdBy: { type: String, required: true },
    // "staff"  = generated by a logged-in staff/admin user (the original,
    //            default behavior — a real client engagement).
    // "public" = generated by an anonymous visitor through the free
    //            lead-gen tool (routes/public.routes.js). These are NOT
    //            real client engagements — never show them in staff
    //            queues/portals meant for actual work, only in the
    //            dedicated leads list (GET /api/admin/leads).
    source: { type: String, enum: ["staff", "public"], default: "staff", index: true },
    // Only present when source is "public" and the visitor chose to
    // unlock their full result — this IS the lead. Absent means someone
    // generated a preview and left without giving contact info.
    leadContact: {
      type: {
        name: { type: String, trim: true, default: "" },
        email: { type: String, trim: true, lowercase: true, default: "" },
        phone: { type: String, trim: true, default: "" },
        unlockedAt: { type: Date, default: Date.now },
      },
      default: null,
    },
    // Which client company this calendar belongs to. Nullable so existing
    // calendars generated before multi-tenancy don't break, and so staff
    // can still generate an internal/test calendar with no client
    // attached — but every /portal/* route MUST filter by this and treat
    // a null clientOrgId as invisible to any client.
    clientOrgId: { type: mongoose.Schema.Types.ObjectId, ref: "ClientOrg", default: null, index: true },
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
