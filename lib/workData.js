// lib/workData.js
//
// One shared, briefly cached read of "all current client work": every
// approved, current (not superseded) client calendar, with its staff view
// (lib/calendarView.js), plus the client companies. The dashboard, the
// pipeline and the reports all start from this.
//
// Why a cache: those three pages used to load and re-calculate every client
// calendar on every page view. Fine for 50 clients, slow for 5,000. Now the
// work is done at most once every WORK_CACHE_SECONDS (default 30) per server,
// and immediately again after any calendar is saved on this server (see the
// hooks at the bottom of models/Calendar.js), so staff see their own changes
// straight away.
//
// Reads use .lean() (plain objects, no Mongoose documents), which is several
// times faster and lighter for read-only pages. Never save these objects.

const Calendar = require("../models/Calendar");
const ClientOrg = require("../models/ClientOrg");
const { toView } = require("./calendarView");

const TTL_MS = () => (process.env.NODE_ENV === "test" ? 0 : Math.max(0, parseInt(process.env.WORK_CACHE_SECONDS || "30", 10)) * 1000);

let cached = null; // { at, promise }

async function build() {
  const calendars = await Calendar.find({ status: "approved", clientOrgId: { $ne: null }, supersededAt: null }).lean();
  const orgList = await ClientOrg.find({ _id: { $in: calendars.map((c) => c.clientOrgId) } })
    .select("name assignedStaff primaryContactPhone whatsappOptIn createdAt")
    .lean();
  return {
    calendars: calendars.map((calendar) => ({ calendar, view: toView(calendar, { staff: true }) })),
    orgs: new Map(orgList.map((o) => [String(o._id), o])),
    builtAt: new Date(),
  };
}

/** { calendars: [{ calendar, view }], orgs: Map(id -> org), builtAt } */
function loadClientWork() {
  const ttl = TTL_MS();
  if (cached && ttl && Date.now() - cached.at < ttl) return cached.promise;
  const entry = { at: Date.now(), promise: build() };
  // A failed read must not be cached.
  entry.promise.catch(() => { if (cached === entry) cached = null; });
  cached = entry;
  return entry.promise;
}

/** Forget the cached copy (called after any calendar is saved). */
function invalidate() {
  cached = null;
}

module.exports = { loadClientWork, invalidate };
