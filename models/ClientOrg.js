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
  },
  { timestamps: true }
);

module.exports = mongoose.model("ClientOrg", clientOrgSchema);
