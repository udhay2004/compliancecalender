// routes/feeds.routes.js
//
// Calendar subscription links (lib/ics.js). These are PUBLIC URLs — a
// calendar app can't log in — protected by a long random token instead,
// the same way Google Calendar's "secret address in iCal format" works.
//
//   GET /feeds/<token>.ics        one client company's deadlines
//   GET /feeds/team/<token>.ics   every client's deadlines we're handling (staff)
//
// Tokens are created and reset from the portal (client) and the
// dashboard (staff). Resetting one makes the old link stop working.

const express = require("express");
const rateLimit = require("express-rate-limit");
const Calendar = require("../models/Calendar");
const ClientOrg = require("../models/ClientOrg");
const User = require("../models/User");
const ics = require("../lib/ics");

const router = express.Router();

// Calendar apps poll every few hours; this only stops someone guessing.
const feedLimiter = rateLimit({ store: require("../lib/rateLimitStore").mongoStore("calendar-feed"), windowMs: 15 * 60 * 1000, limit: 60, standardHeaders: "draft-7", legacyHeaders: false });

const KEEP_PAST_DAYS = 400; // older events drop out of the feed

function recent(events, now = new Date()) {
  const cutoff = now.getTime() - KEEP_PAST_DAYS * 86400000;
  return events.filter((e) => new Date(e.date).getTime() >= cutoff);
}

/** .ics text for one client company (all its current calendars). */
async function orgIcs(org, { calendarId = null } = {}) {
  const q = { clientOrgId: org._id, status: "approved", supersededAt: null };
  if (calendarId) q._id = calendarId;
  const calendars = await Calendar.find(q);
  const events = [];
  calendars.forEach((c) => events.push(...ics.calendarEvents(c, { audience: "client" })));
  return ics.buildIcs({
    name: `${org.name} — compliance deadlines`,
    description: "Filing deadlines from ComplyGlobally. Updates automatically.",
    events: ics.sortEvents(recent(events)),
  });
}

/** .ics text for the team: every filing a client asked us to handle. */
async function teamIcs() {
  const work = await require("../lib/workData").loadClientWork();
  const calendars = work.calendars.map((w) => w.calendar);
  const names = Object.fromEntries([...work.orgs].map(([id, o]) => [id, o.name]));
  const events = [];
  calendars.forEach((c) => events.push(...ics.calendarEvents(c, { audience: "staff", company: names[String(c.clientOrgId)] || c.profile?.companyName || "" })));
  return ics.buildIcs({
    name: "ComplyGlobally — client deadlines",
    description: "Every filing clients have asked ComplyGlobally to handle.",
    events: ics.sortEvents(recent(events)),
  });
}

const notFound = (res) => res.status(404).type("text/plain").send("This calendar link is no longer valid. Get the current link from ComplyGlobally.");

router.get("/feeds/team/:token.ics", feedLimiter, async (req, res) => {
  if (!ics.isFeedToken(req.params.token)) return notFound(res);
  const user = await User.findOne({ calendarFeedToken: req.params.token });
  if (!user || user.active === false || !["staff", "admin", "super_admin"].includes(user.role)) return notFound(res);
  ics.sendIcs(res, await teamIcs(), "complyglobally-client-deadlines", { download: false });
});

router.get("/feeds/:token.ics", feedLimiter, async (req, res) => {
  if (!ics.isFeedToken(req.params.token)) return notFound(res);
  const org = await ClientOrg.findOne({ calendarFeedToken: req.params.token });
  if (!org) return notFound(res);
  ics.sendIcs(res, await orgIcs(org), `${org.name}-deadlines`, { download: false });
});

/** Get (creating if needed) the subscription links for a token holder. */
async function feedLinksFor(doc, { kind, name, reset = false }) {
  if (reset || !ics.isFeedToken(doc.calendarFeedToken)) {
    doc.calendarFeedToken = ics.newFeedToken();
    await doc.save();
  }
  const path = kind === "team" ? `/feeds/team/${doc.calendarFeedToken}.ics` : `/feeds/${doc.calendarFeedToken}.ics`;
  return { ...ics.subscribeLinks(path, name), appUrlSet: Boolean(process.env.APP_URL) };
}

module.exports = router;
module.exports.orgIcs = orgIcs;
module.exports.teamIcs = teamIcs;
module.exports.feedLinksFor = feedLinksFor;
