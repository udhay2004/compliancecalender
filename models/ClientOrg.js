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
    primaryContactEmail: { type: String, trim: true, lowercase: true, default: "" },
    primaryContactName: { type: String, trim: true, default: "" },
    notes: { type: String, default: "" },
    // Who on your team created this org record — an internal
    // staff/admin User's email, for accountability, not a foreign key.
    createdBy: { type: String, default: "" },
  },
  { timestamps: true }
);

module.exports = mongoose.model("ClientOrg", clientOrgSchema);
