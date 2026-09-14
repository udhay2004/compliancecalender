// models/Message.js
//
// One flat, append-only collection of chat messages between a client
// company and the ComplyGlobally team. Scoped by clientOrgId (see
// models/ClientOrg.js) rather than by a single calendar, because the
// relationship with a client persists across however many calendars/
// entities they have. A message can optionally be tagged to one
// compliance item (calendarId + itemIndex + a snapshot of its name) so
// both sides can see "this message is about the Annual Report" — but
// that tag is a display label only, not a separate thread: every
// message in an org's thread is visible to everyone on both sides of
// that relationship (any staff/admin/super_admin, and any client
// account on that org), the same way a shared support inbox works.

const mongoose = require("mongoose");

const messageSchema = new mongoose.Schema(
  {
    clientOrgId: { type: mongoose.Schema.Types.ObjectId, ref: "ClientOrg", required: true, index: true },

    senderId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    // Denormalized at write time so the transcript still renders
    // correctly if the sender's account is later renamed, deactivated,
    // or (in principle) deleted — a chat log shouldn't quietly change
    // who said what.
    senderName: { type: String, required: true },
    senderRole: { type: String, enum: ["client", "staff", "admin", "super_admin"], required: true },

    body: { type: String, required: true, trim: true, maxlength: 4000 },

    // Optional context tag — which calendar/item this message is about.
    // itemLabel is a snapshot of compliance_name at send time, not a
    // live lookup, so an old message still makes sense even if that
    // item is later edited or the calendar is gone.
    calendarId: { type: mongoose.Schema.Types.ObjectId, ref: "Calendar", default: null },
    itemIndex: { type: Number, default: null },
    itemLabel: { type: String, default: "" },

    // Two independent read flags, not one "read" boolean: a message
    // FROM staff needs "has the client read it", a message FROM the
    // client needs "has staff read it" — never the same field for both
    // directions. Set true for the sender's own side at creation time
    // (see routes/messages.routes.js) so a sender's own messages never
    // count as unread to them.
    readByClient: { type: Boolean, default: false },
    readByStaff: { type: Boolean, default: false },
  },
  { timestamps: true }
);

messageSchema.index({ clientOrgId: 1, createdAt: 1 });

module.exports = mongoose.model("Message", messageSchema);
