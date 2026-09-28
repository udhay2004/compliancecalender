// lib/countries.js
//
// The countries the calendar tool covers, and the entity types for each.
// Each has researched data in data/presearched-*.json (the US per state).
// The website form (public/index.html) shows exactly these, and the server
// refuses anything else, so nobody gets a calendar for a country we can't
// research reliably.
//
// To add a country: research its data file (see the existing ones), add it
// here with entity types that match the data file's entityType values
// exactly, and add the same list in public/index.html.

const ENTITY_TYPES = {
  "United States": ["Corporation", "LLC", "Partnership", "Disregarded Entity"],
  "United Kingdom": ["Private Limited Company (Ltd)", "Limited Liability Partnership (LLP)", "Public Limited Company (PLC)", "Sole Trader"],
  "Canada": ["Federal Corporation (CBCA)", "Sole Proprietorship", "General Partnership"],
  "Germany": ["GmbH", "UG (haftungsbeschränkt)", "AG"],
  "Singapore": ["Private Limited Company (Pte Ltd)", "Limited Liability Partnership (LLP)", "Sole Proprietorship", "Branch Office of Foreign Company"],
  "United Arab Emirates": ["Mainland LLC", "Free Zone Company (FZE/FZCO)", "Branch of Foreign Company", "Civil Company"],
};
const SUPPORTED_COUNTRIES = Object.keys(ENTITY_TYPES);

/**
 * Check and tidy a profile from the public form.
 * Returns { ok: true, profile } or { ok: false, error, field }.
 */
function checkProfile(input) {
  if (!input || typeof input !== "object") return { ok: false, error: "Missing company details.", field: "profile" };
  const profile = { ...input };
  profile.country = String(profile.country || "United States").trim();
  if (!SUPPORTED_COUNTRIES.includes(profile.country)) {
    return {
      ok: false,
      field: "country",
      error: `We don't prepare calendars for ${profile.country || "that country"} yet. We currently cover: ${SUPPORTED_COUNTRIES.join(", ")}.`,
    };
  }
  profile.entityType = String(profile.entityType || "").trim();
  if (!ENTITY_TYPES[profile.country].includes(profile.entityType)) {
    return { ok: false, field: "entityType", error: `Choose the type of company (for ${profile.country}: ${ENTITY_TYPES[profile.country].join(", ")}).` };
  }
  profile.state = String(profile.state || "").trim().slice(0, 100);
  if (profile.country === "United States") {
    if (!profile.state) return { ok: false, field: "state", error: "Choose the state the company is registered in." };
  } else if (!profile.state) {
    // Region is optional outside the US (the rules are national).
    profile.state = profile.country;
  }
  return { ok: true, profile };
}

module.exports = { ENTITY_TYPES, SUPPORTED_COUNTRIES, checkProfile };
