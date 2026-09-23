// lib/notify.js
//
// The one place that turns "something happened" into (a) an in-app
// notification (models/Notification.js) and (b) an email. Every route
// that used to hand-roll its own sendEmail() for client/staff events goes
// through here instead, so the two sides are always told about the same
// things in the same way.
//
// Everything in this file is BEST-EFFORT. A failed email or a failed
// notification insert must never fail the request that triggered it —
// the upload/payment/review itself has already been saved by then.

const Notification = require("../models/Notification");
const ClientOrg = require("../models/ClientOrg");
const { sendEmail } = require("./mailer");

function appUrl(path) {
  return `${process.env.APP_URL || ""}${path || ""}`;
}

async function loadOrg(clientOrgId) {
  if (!clientOrgId) return null;
  return ClientOrg.findById(clientOrgId).populate("assignedStaff", "email name");
}

/**
 * Tell the ComplyGlobally team something happened on a client's account.
 * Emails the org's assigned staff member, or ADMIN_EMAIL if nobody is
 * assigned yet.
 */
async function notifyStaff({ clientOrgId = null, calendarId = null, itemIndex = null, type, title, body = "", link = "", actorName = "", email = true }) {
  try {
    await Notification.create({ audience: "staff", clientOrgId, calendarId, itemIndex, type, title, body, link, actorName });
  } catch (err) {
    console.error("[notify] staff notification insert failed (non-fatal):", err.message);
  }
  if (!email) return;
  try {
    const org = await loadOrg(clientOrgId);
    const to = org?.assignedStaff?.email || process.env.ADMIN_EMAIL;
    if (!to) return;
    await sendEmail({
      to,
      subject: `${org?.name ? org.name + ": " : ""}${title}`,
      text: `${body}${body ? "\n\n" : ""}Open: ${appUrl(link || "/dashboard.html")}`,
      logPrefix: `[notify:${type}]`,
    });
  } catch (err) {
    console.error("[notify] staff email failed (non-fatal):", err.message);
  }
}

/**
 * Tell a client something happened. Emails the org's primary contact.
 */
async function notifyClient({ clientOrgId, calendarId = null, itemIndex = null, type, title, body = "", link = "/portal.html", actorName = "", email = true }) {
  if (!clientOrgId) return;
  try {
    await Notification.create({ audience: "client", clientOrgId, calendarId, itemIndex, type, title, body, link, actorName });
  } catch (err) {
    console.error("[notify] client notification insert failed (non-fatal):", err.message);
  }
  if (!email) return;
  try {
    const org = await loadOrg(clientOrgId);
    if (!org?.primaryContactEmail) return;
    await sendEmail({
      to: org.primaryContactEmail,
      subject: title,
      text:
        `Hi ${org.primaryContactName || "there"},\n\n` +
        `${body}${body ? "\n\n" : ""}` +
        `Open your portal: ${appUrl(link || "/portal.html")}\n\n— ComplyGlobally`,
      logPrefix: `[notify:${type}]`,
    });
  } catch (err) {
    console.error("[notify] client email failed (non-fatal):", err.message);
  }
}

module.exports = { notifyStaff, notifyClient };
