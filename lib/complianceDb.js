// lib/complianceDb.js
//
// The compliance database: researched filing rules for each country we
// cover, kept in the repo as JSON (data/compliance/*.json), each with a
// machine-readable schedule so due dates are computed locally
// (lib/deadlines.js). A calendar is built from the database whenever the
// company's profile is covered. Every answer the forms accept is covered
// (tests/compliance-db.test.js checks this); there is no AI research.
//
// Data file shape (see data/compliance/README.md):
//   items            nationwide filings
//   regions[R]       items            filings for companies based in region R
//                    employerItems    payroll filings for employees working in R
//                    operatingItems   filings for businesses operating in R
//                    extraProvincialItems  corporations from elsewhere registered in R
//   freeZones[Z]     items            (UAE) filings for companies licensed by zone Z
// Every item may carry `when`: conditions on the company's facts (below).

const fs = require("fs");
const path = require("path");

const DATA_DIR = path.join(__dirname, "..", "data", "compliance");
const FILES = {
  "United States": "united-states.json",
  Canada: "canada.json",
  "United Kingdom": "united-kingdom.json",
  Singapore: "singapore.json",
  "United Arab Emirates": "united-arab-emirates.json",
  Germany: "germany.json",
};
const ODI_FILE = "india-odi.json";

const cache = new Map();
function load(file) {
  if (!cache.has(file)) cache.set(file, JSON.parse(fs.readFileSync(path.join(DATA_DIR, file), "utf8")));
  return cache.get(file);
}
function countryData(country) {
  return FILES[country] ? load(FILES[country]) : null;
}

// ---------------------------------------------------------------------
// Facts: the profile, tidied into the values `when` conditions test.
// Older calendars (before these questions existed) get sensible defaults.
// ---------------------------------------------------------------------
const yes = (v) => v === true || v === "Yes" || v === "yes" || v === "true";
const list = (v) => (Array.isArray(v) ? v : v ? [v] : []).map((s) => String(s).trim()).filter(Boolean);

function factsFor(profile = {}) {
  const country = String(profile.country || "United States").trim();
  let entityType = String(profile.entityType || "").trim();
  let incorporation = profile.incorporation || undefined;
  if (country === "Canada" && entityType === "Federal Corporation (CBCA)") {
    entityType = "Corporation";
    incorporation = incorporation || "Federal";
  }
  if (country === "Canada" && entityType === "Corporation" && !incorporation) incorporation = "Federal";

  let zoneType = profile.zoneType || undefined;
  if (country === "United Arab Emirates" && !zoneType) zoneType = /free zone/i.test(entityType) ? "Free Zone" : "Mainland";

  const employeeRegions = list(profile.employeeStates);
  const hasEmployees = profile.hasEmployees === undefined || profile.hasEmployees === null || profile.hasEmployees === ""
    ? true // older profiles: keep payroll filings, as the AI-built calendars did ("if employees")
    : yes(profile.hasEmployees) || employeeRegions.length > 0;

  const facts = {
    country,
    entityType,
    region: String(profile.state || "").trim(),
    taxStatus: profile.taxStatus === "LLP" ? "Partnership" : profile.taxStatus || undefined, // older calendars offered "LLP"
    incorporation,
    operatingRegions: list(profile.operatingRegions),
    employeeRegions,
    zoneType,
    freeZone: profile.freeZone || undefined,
    salesTax: profile.salesTax || "Annual",
    vat: profile.vat || (country === "Germany" ? "Monthly" : "Quarterly"),
    gst: profile.gst || "Quarterly",
    hasEmployees,
    employeeBand: profile.employeeBand || undefined,
    foreignOwned: Boolean(profile.hasForeignParent),
    // An ODI filing means there IS a foreign parent. Without one the ODI
    // answer doesn't apply (the public form hides the question, and its
    // hidden default is "Yes").
    odi: Boolean(profile.hasForeignParent) && profile.odiDone === "Yes",
    investorType: profile.odiInvestorType || undefined,
  };
  facts.provincialHome = country === "Canada" && incorporation === "Provincial" ? facts.region : undefined;
  return facts;
}

/** Does an item's `when` hold for these facts? All keys must match. */
function matches(when, facts) {
  return decide(when, facts, NONE) === true;
}

/**
 * Like matches(), for a profile that isn't finished: true, false, or null
 * when the answer depends on a fact in `unknown` (a question not answered
 * yet). A partial calendar keeps only the items that are certainly true.
 */
const NONE = new Set();
function decide(when, facts, unknown) {
  if (!when) return true;
  let result = true;
  for (const [key, expected] of Object.entries(when)) {
    let r;
    if (key === "not") {
      const inner = decide(expected, facts, unknown);
      r = inner === null ? null : !inner;
    } else if (unknown.has(key)) {
      r = null;
    } else {
      const actual = facts[key];
      if (typeof expected === "boolean") r = Boolean(actual) === expected;
      else if (!Array.isArray(expected)) r = actual === expected;
      else if (Array.isArray(actual)) r = actual.some((a) => expected.includes(a));
      else r = actual !== undefined && expected.includes(actual);
    }
    if (r === false) return false;
    if (r === null) result = null;
  }
  return result;
}

// Form question (lib/countries.js) -> the facts its answer decides.
const FACTS_OF_FIELD = {
  state: ["region", "provincialHome"],
  entityType: ["entityType"],
  taxStatus: ["taxStatus"],
  incorporation: ["incorporation", "provincialHome"],
  operatingRegions: ["operatingRegions"],
  salesTax: ["salesTax"],
  vat: ["vat"],
  gst: ["gst"],
  hasEmployees: ["hasEmployees", "employeeRegions", "employeeBand"],
  employeeStates: ["employeeRegions"],
  employeeBand: ["employeeBand"],
  zoneType: ["zoneType", "freeZone"],
  freeZone: ["freeZone"],
};

// ---------------------------------------------------------------------
// Coverage: which profiles the database answers on its own.
// ---------------------------------------------------------------------
const US_TAX = {
  Corporation: ["C-Corp", "S-Corp"],
  LLC: ["Partnership", "Disregarded Entity", "C-Corp", "S-Corp"],
  "Disregarded Entity": ["Disregarded Entity"],
  Partnership: ["Partnership"], // general partnerships: federal and state partnership returns, payroll
};

function coverage(facts) {
  const data = countryData(facts.country);
  if (!data) return `${facts.country} isn't in the compliance database`;
  const regions = data.regions || {};
  switch (facts.country) {
    case "United States": {
      if (!regions[facts.region]) return `the state "${facts.region}" isn't in the database`;
      if (!US_TAX[facts.entityType]) return `the entity type "${facts.entityType}" isn't in the database`;
      if (!US_TAX[facts.entityType].includes(facts.taxStatus)) return `the tax status "${facts.taxStatus || "not given"}" isn't covered for ${facts.entityType}`;
      const missing = facts.employeeRegions.find((r) => !regions[r]);
      if (missing) return `the employee state "${missing}" isn't in the database`;
      return null;
    }
    case "Canada": {
      if (!["Corporation", "Sole Proprietorship", "General Partnership"].includes(facts.entityType)) return `the entity type "${facts.entityType}" isn't in the database`;
      if (!regions[facts.region]) return `the province or territory "${facts.region || "not given"}" isn't in the database`;
      const missing = facts.operatingRegions.find((r) => !regions[r]);
      if (missing) return `"${missing}" isn't in the database`;
      return null;
    }
    case "United Arab Emirates": {
      if (!regions[facts.region]) return `the emirate "${facts.region || "not given"}" isn't in the database`;
      if (facts.zoneType === "Free Zone" && !(data.freeZones || {})[facts.freeZone]) return `the free zone "${facts.freeZone || "not given"}" isn't in the database`;
      return null;
    }
    default:
      return null; // UK, Singapore, Germany: national rules
  }
}

// ---------------------------------------------------------------------
// Building the calendar
// ---------------------------------------------------------------------
function toCalendarItem(item) {
  return {
    category: item.category,
    compliance_name: item.name,
    due_date: item.rule,
    schedule: item.schedule || null,
    applicable_to: item.applies || "",
    description: item.description || "",
    authority: item.authority || "",
    source_url: item.source || "",
    confidence: item.confidence || "medium",
  };
}

function collect(facts, unknown = NONE) {
  const data = countryData(facts.country);
  const regions = data.regions || {};
  const picked = [];
  const add = (items) => (items || []).forEach((it) => { if (decide(it.when, facts, unknown) === true) picked.push(it); });
  // A known fact that is set (for a partial profile, unanswered ones aren't).
  const is = (key) => !unknown.has(key) && Boolean(facts[key]);
  const home = unknown.has("region") ? null : regions[facts.region];

  add(data.items);
  if (home) add(home.items);

  if (facts.country === "United States" && is("hasEmployees")) {
    [...new Set([home ? facts.region : null, ...facts.employeeRegions])].forEach((r) => add(regions[r] && regions[r].employerItems));
  }
  if (facts.country === "Canada") {
    const operating = [...new Set(facts.operatingRegions.filter((r) => r !== facts.region))];
    const here = home ? [facts.region, ...operating] : operating;
    here.forEach((r) => add(regions[r] && regions[r].operatingItems));
    // A federal corporation registers extra-provincially everywhere it works,
    // including the province of its registered office.
    const extra = home && !unknown.has("incorporation") && facts.incorporation === "Federal" ? here : operating;
    extra.forEach((r) => add(regions[r] && regions[r].extraProvincialItems));
    if (is("hasEmployees")) here.forEach((r) => add(regions[r] && regions[r].employerItems));
  }
  if (facts.country === "United Arab Emirates" && is("zoneType") && facts.zoneType === "Free Zone" && is("freeZone")) {
    const zone = (data.freeZones || {})[facts.freeZone];
    if (zone) add(zone.items);
  }
  if (facts.odi) add(load(ODI_FILE).items);

  const seen = new Set();
  return picked.filter((it) => (seen.has(it.id) ? false : seen.add(it.id)));
}

/**
 * The calendar for a company profile, from the database alone.
 * @returns {{ covered: true, items: object[] } | { covered: false, reason: string }}
 */
function buildFromDatabase(profile) {
  const facts = factsFor(profile);
  const reason = coverage(facts);
  if (reason) return { covered: false, reason };
  return { covered: true, items: collect(facts).map(toCalendarItem) };
}

/**
 * The filings already certain for a profile that is still being filled in:
 * `unanswered` lists the form questions (lib/countries.js keys) with no
 * answer yet. An item is included only when no unanswered question could
 * rule it out, so the list only grows as questions are answered, and with
 * every question answered it equals buildFromDatabase().
 */
function buildPartial(profile, unanswered = []) {
  const facts = factsFor(profile);
  const unknown = new Set(unanswered.flatMap((key) => FACTS_OF_FIELD[key] || [key]));
  if (!countryData(facts.country)) return [];
  return collect(facts, unknown).map(toCalendarItem);
}

module.exports = { buildFromDatabase, buildPartial, factsFor, matches, coverage, countryData, FILES, DATA_DIR };
