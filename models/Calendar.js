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
      enum: ["Not Invoiced", "Invoiced", "Paid", "Overdue", "Partially Refunded", "Refunded"],
      default: "Not Invoiced",
    },
    // --- Which services the client actually wants us to handle -----
    // A generated calendar lists EVERYTHING that applies to the company;
    // the client then picks the filings they want ComplyGlobally to do.
    // This is the flag that splits the staff screen into "selected" vs
    // "not selected", so staff only work (and invoice) what was asked
    // for. Uploading a document for an item selects it automatically —
    // nobody uploads paperwork for a filing they don't want done.
    // Who marked this service as done (by uploading proof), and when.
    completedBy: { type: String, default: null },
    completedByName: { type: String, default: "" },
    completedAt: { type: Date, default: null },
    selectedByClient: { type: Boolean, default: false },
    selectedAt: { type: Date, default: null },
    // --- Quote sent while verifying documents -------------------------
    // Set by POST /api/calendars/:id/items/:index/quote. quoteNote is
    // shown to the client next to the price ("includes 2 extra states").
    quoteNote: { type: String, default: "" },
    quotedBy: { type: String, default: null },
    quotedAt: { type: Date, default: null },
    // Fee for THIS item, set by staff (see PATCH /:id/items/:index/status
    // in calendar.routes.js) when they move paymentStatus to "Invoiced".
    // In cents (USD), matching Razorpay's smallest-unit convention. See
    // lib/complianceFees.js for the price-list lookup staff use as a
    // starting point — it never writes here directly. The client-facing
    // payment routes (routes/payments.routes.js) ALWAYS read the amount
    // to charge from here — never from anything the browser sends.
    feeAmountCents: { type: Number, default: null },
    // Razorpay order/payment identifiers for the CURRENT payment attempt.
    razorpayOrderId: { type: String, default: null },
    razorpayPaymentId: { type: String, default: null },
    paidAt: { type: Date, default: null },
    // Append-only audit trail for support/dispute investigation.
    paymentEvents: {
      type: [
        {
          // "order_created" | "order_reused" | "verify_ok" | "verify_authorized" |
          // "webhook_captured" | "webhook_failed" | "amount_mismatch" | "order_voided"
          event: { type: String, required: true },
          razorpayOrderId: String,
          razorpayPaymentId: String,
          // What the order was created for / what Razorpay says was paid,
          // so an amount mismatch is visible after the fact.
          amountCents: Number,
          currency: String,
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
          // Which entry of getRequiredDocuments() (see lib/requiredDocuments.js)
          // this upload is satisfying, e.g. "Registered Agent Consent Letter".
          // Only meaningful for type:"client_upload" — left "" for staff-
          // uploaded certificates, which aren't matched against a checklist.
          // Free text, not an enum: the requirement list is a lookup table
          // that can grow over time, and a document uploaded before a label
          // existed shouldn't become invalid.
          requirementLabel: { type: String, default: "" },
          // --- Proof of completion (type:"certificate") ---------------
          // Whoever did the work (often the finance team) uploads proof:
          // the filed certificate, a government acknowledgment, a receipt.
          // These details are shown to the client next to the file.
          uploadedByName: { type: String, default: "" },
          uploadedByDepartment: { type: String, default: "" },
          proofNote: { type: String, default: "" },
          referenceNumber: { type: String, default: "" },
          completedOn: { type: Date, default: null },
          // --- Staff validation of a client's upload -----------------
          // Only meaningful for type:"client_upload" — a staff-uploaded
          // certificate has no reviewStatus, it just IS the deliverable.
          // "pending" until a staff member explicitly accepts or rejects
          // it (see PATCH /:id/items/:index/documents/:docIndex/review
          // in routes/calendar.routes.js) — uploading is not the same as
          // it being correct, which is the whole point of a human check.
          // A rejected document is excluded from the checklist-satisfied
          // and shared-reuse logic in routes/portal.routes.js, so the
          // client sees that requirement as still outstanding.
          reviewStatus: { type: String, enum: ["pending", "accepted", "rejected"], default: "pending" },
          // Why it was rejected, shown to the client so they know what to
          // fix. Required by the route when rejecting; blank otherwise.
          reviewNote: { type: String, default: "" },
          reviewedBy: { type: String, default: null },
          reviewedAt: { type: Date, default: null },
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
    // --- Refunds (routes/calendar.routes.js → Razorpay) ---------------
    // One entry per refund. status follows Razorpay: "pending" until the
    // money is on its way ("processed"), or "failed".
    refunds: {
      type: [
        new mongoose.Schema(
          {
            razorpayRefundId: String,
            razorpayPaymentId: String,
            amountMinor: Number,
            currency: String,
            reason: String,
            status: { type: String, default: "pending" },
            creditNoteNumber: String,
            by: String,
            at: { type: Date, default: Date.now },
            processedAt: Date,
          },
          { _id: false }
        ),
      ],
      default: [],
    },
    // --- Real deadlines (lib/deadlines.js) ---------------------------
    // Computed automatically from `schedule` (structured, from the AI) or
    // from the due_date text, moved to the next business day where US
    // rules say so. dueDateSource:
    //   "auto"  - computed; recomputed if the due_date text changes
    //   "staff" - typed in by staff; never overwritten automatically
    //   "none"  - couldn't be computed ("As Triggered", unclear text)
    schedule: { type: mongoose.Schema.Types.Mixed, default: null },
    recurrence: { type: String, default: "" }, // annual | multiple | monthly | event | unknown
    dueDateSource: { type: String, enum: ["auto", "staff", "none", null], default: null },
    dueDateParsedFrom: { type: String, default: null },
    dueDateNote: { type: String, default: "" },
    // --- Periods: next year's filing is a NEW item -------------------
    // When a recurring filing is done (or its date passes unselected),
    // the next period is created as a fresh item and this one becomes
    // history. Keeps each period's documents, price and proof separate.
    isHistory: { type: Boolean, default: false },
    nextOccurrenceSpawned: { type: Boolean, default: false },
    previousDueDate: { type: Date, default: null },
    // Reminder keys already sent for this item ("client-7:2027-04-15"),
    // so each reminder goes out exactly once per due date.
    remindersSent: { type: [String], default: [] },
    // Automatic "please upload your documents" reminders (lib/reminders.js).
    // Each one sent is recorded in remindersSent as "docs-chase:YYYY-MM-DD".
    // Staff can pause them for one filing (e.g. the client said they'll
    // send the papers next week).
    docChasePaused: { type: Boolean, default: false },
    // Staff pipeline (lib/pipeline.js): who on the team owns this filing.
    // Null = falls back to the staff member assigned to the client company.
    assignedTo: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    assignedToName: { type: String, default: "" },
    assignedAt: { type: Date, default: null },
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
    // "client" = generated (or regenerated) by a logged-in client from
    //            their own portal / the public tool while signed in. Real
    //            client work, same as "staff".
    source: { type: String, enum: ["staff", "public", "client"], default: "staff", index: true },
    // Set on a calendar a client regenerated: the calendar it replaces.
    // The old one is kept (never deleted) so documents, payments and the
    // history stay reachable; the portal just stops treating it as current.
    supersedes: { type: mongoose.Schema.Types.ObjectId, ref: "Calendar", default: null },
    supersededAt: { type: Date, default: null },
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

// Every save computes real due dates for filings that don't have one yet
// (or whose due-date text changed). Covers every way a calendar is created:
// public tool, staff, regenerate, carry-over, edits during review.
calendarSchema.pre("save", function computeDueDates(next) {
  try {
    require("../lib/deadlines").ensureDueDates(this);
  } catch (err) {
    console.error("[deadlines] could not compute due dates (non-fatal):", err.message);
  }
  next();
});

module.exports = mongoose.model("Calendar", calendarSchema);
