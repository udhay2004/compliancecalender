// models/ClientOrg.js
//
// One record per client company. This is the "tenant" for the client
// portal — every client User (models/User.js) belongs to exactly one
// ClientOrg, and every Calendar generated for that company should be
// linked here (see clientOrgId on models/Calendar.js) so a client only
// ever sees their own data, never another client's.

const mongoose = require("mongoose");

const clientOrgSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    primaryContactName: { type: String, trim: true, default: "" },
    primaryContactEmail: { type: String, trim: true, lowercase: true, default: "" },
    primaryContactPhone: { type: String, trim: true, default: "" },
    // Printed on invoices (optional; the client can add it in the portal).
    billingAddress: { type: String, trim: true, default: "" },
    notes: { type: String, default: "" },
    // Who on your team created this org record — an internal
    // staff/admin User's email, for accountability, not a foreign key.
    createdBy: { type: String, default: "" },
    // The staff/admin account this client sees as "your contact" in the
    // portal (see routes/portal.routes.js's GET /contact) and who gets
    // treated as the primary point of contact in the admin UI. Not
    // enforced at the schema level that this points at a staff-or-above
    // account — that's checked in routes/admin.routes.js's PATCH
    // /client-orgs/:id, the only place this is ever set. Left null
    // until someone is assigned, in which case the portal falls back to
    // ComplyGlobally's general support contact instead of a named person.
    assignedStaff: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },

    // WhatsApp reminders (lib/whatsapp.js). Only ever switched on by the
    // client themselves in the portal (or by replying START) — WhatsApp
    // requires the person's own opt-in. whatsappNumber is digits only,
    // with country code (e.g. 14155550100).
    whatsappOptIn: { type: Boolean, default: false },
    whatsappNumber: { type: String, default: "", index: true },
    whatsappOptInAt: { type: Date, default: null },
    whatsappOptOutAt: { type: Date, default: null },
    whatsappLastSentAt: { type: Date, default: null },
    whatsappLastError: { type: String, default: "" },

    // Secret part of the client's calendar subscription link
    // (/feeds/<token>.ics). Anyone with the link can read the deadlines, so
    // the client can reset it from the portal at any time.
    calendarFeedToken: { type: String, default: undefined, index: { unique: true, sparse: true } },
  },
  { timestamps: true }
);

// The calendar-link secret never leaves the server in ordinary API
// responses; only the portal's own "calendar link" endpoint returns it.
clientOrgSchema.set("toJSON", {
  transform(doc, ret) {
    delete ret.calendarFeedToken;
    return ret;
  },
});

module.exports = mongoose.model("ClientOrg", clientOrgSchema);
