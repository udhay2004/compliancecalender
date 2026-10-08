// lib/clientAccounts.js
//
// Client accounts, shared by both ways a client gets in: Google sign-in
// and the email-code sign-in / sign-up (routes/auth.routes.js).
//
//   createClientAccount  — a new person gets their own company workspace
//                          (ClientOrg) and a client login scoped to it.
//   claimCalendars       — every calendar they generated on the public
//                          tool before signing in (the one they clicked
//                          "Log in" from, plus any other generated with
//                          the same email) moves into their workspace.
//
// Claiming by email is only ever done for an email address that was just
// proven (a Google account, or a code sent to that inbox), and only takes
// calendars nobody owns yet (source "public", clientOrgId null).

const mongoose = require("mongoose");
const User = require("../models/User");
const ClientOrg = require("../models/ClientOrg");
const Calendar = require("../models/Calendar");
const { notifyStaff } = require("./notify");

// Enough for anyone genuinely running several companies; stops a flood of
// calendars someone else generated with this address from being pulled in.
const MAX_CLAIM = 25;

function defaultOrgName({ email, name, companyName }) {
  if (companyName) return companyName;
  if (name) return `${name}'s Company`;
  return email.split("@")[1] || email;
}

/**
 * A new client login with its own company workspace. If the email was
 * registered in the meantime (two tabs, a double click), the existing
 * account is returned and the spare workspace removed.
 */
async function createClientAccount({ email, name = "", companyName = "", googleId, createdBy }) {
  const org = await ClientOrg.create({
    name: defaultOrgName({ email, name, companyName }),
    primaryContactEmail: email,
    primaryContactName: name,
    createdBy,
  });
  try {
    const attrs = { email, name, role: "client", clientOrgId: org._id };
    if (googleId) attrs.googleId = googleId;
    return await User.create(attrs);
  } catch (err) {
    if (err && err.code === 11000) {
      await ClientOrg.deleteOne({ _id: org._id }).catch(() => {});
      const existing = await User.findOne({ email });
      if (existing) return existing;
    }
    throw err;
  }
}

/**
 * Moves the visitor's unclaimed public calendars into their workspace.
 * Returns the ids claimed, the one they came from first.
 */
async function claimCalendars(user, { pendingCalendarId } = {}) {
  if (!user || user.role !== "client" || !user.clientOrgId) return [];

  const ids = [];
  if (pendingCalendarId && mongoose.isValidObjectId(String(pendingCalendarId))) ids.push(String(pendingCalendarId));
  const byEmail = await Calendar.find({ "leadContact.email": user.email, source: "public", clientOrgId: null })
    .select("_id")
    .sort({ createdAt: -1 })
    .limit(MAX_CLAIM);
  byEmail.forEach((c) => { if (!ids.includes(String(c._id))) ids.push(String(c._id)); });

  const claimed = [];
  for (const id of ids) {
    // Re-checked atomically: never takes a calendar that already belongs
    // to someone, even if it was claimed a moment ago in another tab.
    const cal = await Calendar.findOneAndUpdate(
      { _id: id, source: "public", clientOrgId: null },
      { $set: { clientOrgId: user.clientOrgId, status: "approved", reviewedBy: "auto", reviewedAt: new Date() } },
      { new: true }
    );
    if (cal) claimed.push(cal);
  }
  if (!claimed.length) return [];

  // Contact details typed into the public form fill any gaps on the
  // company record, so staff have an email and phone from the start.
  const org = await ClientOrg.findById(user.clientOrgId);
  if (org) {
    const first = claimed[0];
    const lead = first.leadContact || {};
    if (!org.primaryContactPhone && lead.phone) org.primaryContactPhone = lead.phone;
    if (!org.primaryContactEmail) org.primaryContactEmail = lead.email || user.email;
    if (!org.primaryContactName && lead.name) org.primaryContactName = lead.name;
    if (/^(google-signup|client-signup)$/.test(org.createdBy || "") && first.profile?.companyName && /'s Company$|@|\./.test(org.name)) {
      org.name = first.profile.companyName;
    }
    await org.save();
  }

  claimed.forEach((cal) => {
    const company = cal.profile?.companyName || org?.name || user.email;
    notifyStaff({
      clientOrgId: user.clientOrgId,
      calendarId: cal._id,
      type: "client_signed_up",
      title: `${company}: calendar saved to ${user.name || user.email}'s portal`,
      body: `${user.name || user.email} signed in and their ${cal.items?.length || ""}-item compliance calendar for ${company} is now in their portal, where they can pick services and upload documents.`,
      link: `/calendar?id=${cal._id}`,
      actorName: user.name || user.email,
    });
  });

  return claimed.map((c) => String(c._id));
}

/** Where a client lands after signing in. */
function portalUrlFor(claimedIds) {
  return claimedIds && claimedIds.length ? `/portal?calendar=${claimedIds[0]}` : "/portal";
}

module.exports = { createClientAccount, claimCalendars, portalUrlFor, MAX_CLAIM };
