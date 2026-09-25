// models/AuditLog.js
//
// An append-only trail of the actions that matter most to get right in
// a compliance business: who approved or rejected a calendar, who
// accepted or rejected a client's document and why, and every payment
// event. Deliberately NOT trying to log everything (every field edit,
// every login) — that turns into noise nobody reads. This is the "if a
// client or a regulator ever asks 'who signed off on this and when',
// can we answer in one query" list.
//
// Write with logActivity() in lib/auditLog.js, never directly — that
// helper is what makes every call site fire-and-forget (a logging
// failure must never break the action being logged).

const mongoose = require("mongoose");

const auditLogSchema = new mongoose.Schema(
  {
    action: {
      type: String,
      enum: [
        "calendar_approved",
        "calendar_rejected",
        "document_accepted",
        "document_rejected",
        "payment_captured",
        "payment_failed",
        "payment_amount_mismatch",
        "document_uploaded",
        "calendar_regenerated",
        "quote_sent",
        "proof_uploaded",
        "two_factor_enabled",
        "two_factor_locked",
        "two_factor_recovery_used",
        "two_factor_codes_regenerated",
        "two_factor_reset",
        "backup_created",
        "refund_created",
        "refund_updated",
        "backup_failed",
        "proof_removed",
        "user_deactivated",
        "user_reactivated",
        // Account-security events. Worth keeping alongside the
        // business events: "who set a password, and when" is the first
        // question asked after any suspected account compromise.
        "password_set",
        "password_changed",
      ],
      required: true,
    },
    // Who did it. Denormalized name/role for the same reason as
    // Message.senderName (models/Message.js) — a log entry shouldn't
    // change meaning if the actor's account is later renamed or
    // deactivated. actorId is null for system-triggered entries (the
    // Razorpay webhook has no logged-in user).
    actorId: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    actorName: { type: String, default: "System" },

    clientOrgId: { type: mongoose.Schema.Types.ObjectId, ref: "ClientOrg", default: null },
    calendarId: { type: mongoose.Schema.Types.ObjectId, ref: "Calendar", default: null },
    itemIndex: { type: Number, default: null },

    // Short, human-readable line for the activity feed, e.g. "Rejected
    // 'EIN Letter.pdf' for Annual Report — wrong tax year." Built once
    // at write time so the feed never has to re-derive it from `meta`.
    summary: { type: String, required: true },

    // Anything action-specific that doesn't deserve its own column —
    // a rejection reason, a payment amount, an old/new status pair.
    meta: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { timestamps: true }
);

auditLogSchema.index({ createdAt: -1 });
auditLogSchema.index({ clientOrgId: 1, createdAt: -1 });

module.exports = mongoose.model("AuditLog", auditLogSchema);
