// lib/complianceDb.js
//
// The compliance database: researched filing rules for each country we
// cover, kept in the repo as JSON (data/compliance/*.json), each with a
// machine-readable schedule so due dates are computed locally
// (lib/deadlines.js). A calendar is built from the database whenever the
// company's profile is covered; only a profile that falls outside it (an
// uncovered territory, entity type or tax status) goes to live AI research
// in lib/claude.js.
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
    taxStatus: profile.taxStatus || undefined,
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
    odi: profile.odiDone === "Yes",
    investorType: profile.odiInvestorType || undefined,
  };
  facts.provincialHome = country === "Canada" && incorporation === "Provincial" ? facts.region : undefined;
  return facts;
}

/** Does an item's `when` hold for these facts? All keys must match. */
function matches(when, facts) {
  if (!when) return true;
  return Object.entries(when).every(([key, expected]) => {
    if (key === "not") return !matches(expected, facts);
    const actual = facts[key];
    if (typeof expected === "boolean") return Boolean(actual) === expected;
    if (!Array.isArray(expected)) return actual === expected;
    if (Array.isArray(actual)) return actual.some((a) => expected.includes(a));
    return actual !== undefined && expected.includes(actual);
  });
}

// ---------------------------------------------------------------------
// Coverage: which profiles the database answers on its own.
// ---------------------------------------------------------------------
const US_TAX = {
  Corporation: ["C-Corp", "S-Corp"],
  LLC: ["Partnership", "Disregarded Entity", "C-Corp", "S-Corp"],
  "Disregarded Entity": ["Disregarded Entity"],
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

function collect(facts) {
  const data = countryData(facts.country);
  const regions = data.regions || {};
  const picked = [];
  const add = (items) => (items || []).forEach((it) => { if (matches(it.when, facts)) picked.push(it); });

  add(data.items);
  const home = regions[facts.region];
  if (home) add(home.items);

  if (facts.country === "United States" && facts.hasEmployees) {
    [...new Set([facts.region, ...facts.employeeRegions])].forEach((r) => add(regions[r] && regions[r].employerItems));
  }
  if (facts.country === "Canada") {
    const operating = [...new Set(facts.operatingRegions.filter((r) => r !== facts.region))];
    [facts.region, ...operating].forEach((r) => add(regions[r].operatingItems));
    // A federal corporation registers extra-provincially everywhere it works,
    // including the province of its registered office.
    const extra = facts.incorporation === "Federal" ? [facts.region, ...operating] : operating;
    extra.forEach((r) => add(regions[r].extraProvincialItems));
    if (facts.hasEmployees) [facts.region, ...operating].forEach((r) => add(regions[r].employerItems));
  }
  if (facts.country === "United Arab Emirates" && facts.zoneType === "Free Zone") {
    add(data.freeZones[facts.freeZone].items);
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

module.exports = { buildFromDatabase, factsFor, matches, coverage, countryData, FILES, DATA_DIR };
