// models/Notification.js
//
// In-app notifications — the bell in the top bar of the portal and of
// every staff page. Email still goes out for the important events (see
// lib/notify.js), but email is easy to miss and impossible to "mark as
// done", so every event that matters also lands here.
//
// Two audiences, never mixed:
//   audience "staff"  - one shared team inbox (like the review queue).
//                       Read state is tracked PER PERSON in readBy, so one
//                       teammate opening a notification doesn't hide it
//                       from everyone else.
//   audience "client" - scoped to exactly one clientOrgId. Every client
//                       account on that org sees it; readBy works the same.
//
// A client can only ever read audience:"client" rows for their own
// clientOrgId — enforced in routes/notifications.routes.js, not here.

const mongoose = require("mongoose");

const TYPES = [
  "client_signed_up",
  "calendar_generated",
  "calendar_regenerated",
  "calendar_approved",
  "service_selected",
  "service_deselected",
  "document_uploaded",
  "document_accepted",
  "document_rejected",
  "quote_sent",
  "status_changed",
  "certificate_uploaded",
  "payment_received",
  "payment_failed",
  "profile_updated",
  "message",
];

const notificationSchema = new mongoose.Schema(
  {
    audience: { type: String, enum: ["staff", "client"], required: true, index: true },
    clientOrgId: { type: mongoose.Schema.Types.ObjectId, ref: "ClientOrg", default: null, index: true },
    calendarId: { type: mongoose.Schema.Types.ObjectId, ref: "Calendar", default: null },
    itemIndex: { type: Number, default: null },
    type: { type: String, enum: TYPES, required: true },
    title: { type: String, required: true, maxlength: 200 },
    body: { type: String, default: "", maxlength: 1000 },
    // Relative path inside this app ("/calendar.html?id=..."), never an
    // absolute URL, so a notification can't be used to send someone off-site.
    link: { type: String, default: "" },
    actorName: { type: String, default: "" },
    readBy: { type: [mongoose.Schema.Types.ObjectId], default: [] },
  },
  { timestamps: true }
);

notificationSchema.index({ audience: 1, clientOrgId: 1, createdAt: -1 });

notificationSchema.statics.TYPES = TYPES;

module.exports = mongoose.model("Notification", notificationSchema);
