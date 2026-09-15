// lib/auditLog.js
//
// One function, one job: write an AuditLog entry (models/AuditLog.js)
// and never let a logging failure break whatever real action triggered
// it. Every call site should look like:
//
//   logActivity({ action: "calendar_approved", actor: req.user, ... });
//
// with no `await` and no try/catch at the call site — this function
// swallows and logs its own errors so callers don't have to.

const AuditLog = require("../models/AuditLog");

function logActivity({ action, actor, clientOrgId, calendarId, itemIndex, summary, meta }) {
  AuditLog.create({
    action,
    actorId: actor?._id || null,
    actorName: actor?.name || actor?.email || "System",
    clientOrgId: clientOrgId || null,
    calendarId: calendarId || null,
    itemIndex: itemIndex ?? null,
    summary,
    meta: meta || {},
  }).catch((err) => console.error(`[audit] failed to log "${action}" (non-fatal):`, err.message));
}

module.exports = { logActivity };
