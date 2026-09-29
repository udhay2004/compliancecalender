// lib/countries.js
//
// The countries the calendar tool covers and the questions asked for each.
// ONE definition used everywhere:
//   * the forms (website generator, staff generator, client portal) fetch it
//     from GET /api/public/form and render the questions with
//     public/js/company-form.js;
//   * the server checks every submitted profile against it (checkProfile).
// The answers are what lib/complianceDb.js uses to pick filings from the
// compliance database (data/compliance/*.json).
//
// To add a question: add a field here and use its key in a `when` condition
// in the data files (lib/complianceDb.js factsFor() maps the answer).

const db = require("./complianceDb");

const US_STATES = Object.keys(db.countryData("United States").regions).sort();
const CANADA_TERRITORIES = ["Yukon", "Northwest Territories", "Nunavut"];
const CANADA_PROVINCES = Object.keys(db.countryData("Canada").regions).filter((r) => !CANADA_TERRITORIES.includes(r)).sort();
const UAE = db.countryData("United Arab Emirates");
const EMIRATES = Object.keys(UAE.regions);
const GERMAN_STATES = ["Baden-Württemberg", "Bavaria", "Berlin", "Brandenburg", "Bremen", "Hamburg", "Hesse", "Lower Saxony", "Mecklenburg-Western Pomerania", "North Rhine-Westphalia", "Rhineland-Palatinate", "Saarland", "Saxony", "Saxony-Anhalt", "Schleswig-Holstein", "Thuringia"];

const EMPLOYEES = { key: "hasEmployees", type: "yesno", label: "Does the company have employees on payroll?", required: true };

// Field types: select | multiselect | yesno | text.
//   options      the allowed values (optionLabels: nicer text for some)
//   optionsFrom  { field, map } — options depend on another answer
//   showIf       { field: [values] } — asked only then
//   labelFrom    { field, map, default } — label depends on another answer
const FORMS = {
  "United States": [
    { key: "state", type: "select", label: "State of incorporation", options: US_STATES, required: true },
    { key: "entityType", type: "select", label: "Entity type", options: ["Corporation", "LLC", "Disregarded Entity", "Partnership"], required: true,
      optionLabels: { "Disregarded Entity": "Single-member LLC (disregarded entity)", Partnership: "General partnership" } },
    { key: "taxStatus", type: "select", label: "How is it taxed?", required: true,
      optionsFrom: { field: "entityType", map: {
        Corporation: ["C-Corp", "S-Corp"],
        LLC: ["Partnership", "Disregarded Entity", "C-Corp", "S-Corp"],
        "Disregarded Entity": ["Disregarded Entity"],
        Partnership: ["Partnership"],
      } },
      optionLabels: { "C-Corp": "C corporation", "S-Corp": "S corporation (S election)", Partnership: "Partnership (multi-member)", "Disregarded Entity": "Disregarded entity (single owner)" } },
    EMPLOYEES,
    { key: "employeeStates", type: "multiselect", label: "Other states where employees work", options: US_STATES, showIf: { hasEmployees: ["Yes"] },
      help: "Payroll registrations follow the state where each employee works, not where the company is incorporated." },
  ],
  Canada: [
    { key: "entityType", type: "select", label: "Business type", options: ["Corporation", "Sole Proprietorship", "General Partnership"], required: true },
    { key: "incorporation", type: "select", label: "Where is it incorporated?", options: ["Federal", "Provincial"], required: true, showIf: { entityType: ["Corporation"] },
      optionLabels: { Federal: "Federally (Canada Business Corporations Act)", Provincial: "Under a province's or territory's law" } },
    { key: "state", type: "select", required: true, options: [...CANADA_PROVINCES, ...CANADA_TERRITORIES],
      labelFrom: { field: "incorporation", map: { Federal: "Province or territory of the registered office", Provincial: "Province or territory of incorporation" }, default: "Province or territory where the business is based" } },
    { key: "operatingRegions", type: "multiselect", label: "Other provinces or territories where it carries on business", options: [...CANADA_PROVINCES, ...CANADA_TERRITORIES],
      help: "Each one usually needs an extra-provincial registration and its own annual filings." },
    { key: "salesTax", type: "select", label: "GST/HST registration", options: ["Not registered", "Annual", "Quarterly", "Monthly"], required: true,
      optionLabels: { Annual: "Registered, files annually", Quarterly: "Registered, files quarterly", Monthly: "Registered, files monthly" } },
    EMPLOYEES,
  ],
  "United Kingdom": [
    { key: "entityType", type: "select", label: "Entity type", required: true,
      options: ["Private Limited Company (Ltd)", "Limited Liability Partnership (LLP)", "Public Limited Company (PLC)", "Sole Trader"] },
    { key: "vat", type: "select", label: "VAT registration", options: ["Not registered", "Quarterly", "Monthly", "Annual"], required: true,
      optionLabels: { Quarterly: "Registered, quarterly returns", Monthly: "Registered, monthly returns", Annual: "Registered, Annual Accounting Scheme" } },
    EMPLOYEES,
  ],
  Singapore: [
    { key: "entityType", type: "select", label: "Entity type", required: true,
      options: ["Private Limited Company (Pte Ltd)", "Limited Liability Partnership (LLP)", "Sole Proprietorship", "Branch Office of Foreign Company"] },
    { key: "gst", type: "select", label: "GST registration", options: ["Not registered", "Quarterly", "Monthly"], required: true,
      optionLabels: { Quarterly: "Registered, quarterly returns", Monthly: "Registered, monthly returns" } },
    EMPLOYEES,
  ],
  "United Arab Emirates": [
    { key: "state", type: "select", label: "Which emirate?", options: EMIRATES, required: true },
    { key: "zoneType", type: "select", label: "Mainland or free zone?", options: ["Mainland", "Free Zone"], required: true },
    { key: "freeZone", type: "select", label: "Which free zone?", required: true, showIf: { zoneType: ["Free Zone"] },
      optionsFrom: { field: "state", map: UAE.freeZonesByEmirate } },
    { key: "entityType", type: "select", label: "Entity type", required: true,
      optionsFrom: { field: "zoneType", map: {
        Mainland: ["Mainland LLC", "Sole Establishment", "Civil Company", "Branch of Foreign Company"],
        "Free Zone": ["Free Zone Company (FZE/FZCO)", "Branch of Foreign Company"],
      } },
      optionLabels: { "Free Zone Company (FZE/FZCO)": "Free zone company (FZE / FZCO / FZ-LLC)" } },
    { key: "vat", type: "select", label: "VAT registration", options: ["Not registered", "Quarterly", "Monthly"], required: true,
      optionLabels: { Quarterly: "Registered, quarterly returns", Monthly: "Registered, monthly returns" } },
    EMPLOYEES,
    { key: "employeeBand", type: "select", label: "How many employees?", options: ["Fewer than 20", "20–49", "50 or more"], required: true,
      showIf: { hasEmployees: ["Yes"], zoneType: ["Mainland"] }, help: "Emiratisation targets apply to mainland companies with 20 or more employees." },
  ],
  Germany: [
    { key: "entityType", type: "select", label: "Entity type", options: ["GmbH", "UG (haftungsbeschränkt)", "AG"], required: true },
    { key: "state", type: "select", label: "Federal state (optional)", options: GERMAN_STATES },
    { key: "vat", type: "select", label: "VAT advance returns", options: ["Monthly", "Quarterly", "Not registered"], required: true,
      optionLabels: { Monthly: "Monthly", Quarterly: "Quarterly", "Not registered": "Not registered / small business (§19 UStG)" } },
    EMPLOYEES,
  ],
};
const SUPPORTED_COUNTRIES = Object.keys(FORMS);
const ENTITY_TYPES = Object.fromEntries(SUPPORTED_COUNTRIES.map((c) => {
  const f = FORMS[c].find((x) => x.key === "entityType");
  return [c, f.options || [...new Set(Object.values(f.optionsFrom.map).flat())]];
}));

function optionsFor(field, answers) {
  if (field.options) return field.options;
  return (field.optionsFrom.map[answers[field.optionsFrom.field]] || []);
}
function isShown(field, answers) {
  return !field.showIf || Object.entries(field.showIf).every(([k, vals]) => vals.includes(answers[k]));
}
function labelOf(field, answers) {
  if (!field.labelFrom) return field.label;
  return field.labelFrom.map[answers[field.labelFrom.field]] || field.labelFrom.default;
}

/**
 * Check and tidy a profile from any of the forms.
 * opts.requireAll false (regenerating an older calendar): unanswered
 * questions are allowed; answers that are given must still be valid.
 * Returns { ok: true, profile } or { ok: false, error, field }.
 */
function checkProfile(input, { requireAll = true } = {}) {
  if (!input || typeof input !== "object") return { ok: false, error: "Missing company details.", field: "profile" };
  const profile = { ...input };
  profile.country = String(profile.country || "United States").trim();
  if (!FORMS[profile.country]) {
    return {
      ok: false,
      field: "country",
      error: `We don't prepare calendars for ${profile.country || "that country"} yet. We currently cover: ${SUPPORTED_COUNTRIES.join(", ")}.`,
    };
  }
  // Earlier Canadian calendars stored the incorporation in the entity type.
  if (profile.country === "Canada" && profile.entityType === "Federal Corporation (CBCA)") {
    profile.entityType = "Corporation";
    profile.incorporation = profile.incorporation || "Federal";
  }
  if (typeof profile.hasEmployees === "boolean") profile.hasEmployees = profile.hasEmployees ? "Yes" : "No";

  for (const field of FORMS[profile.country]) {
    const label = labelOf(field, profile);
    if (!isShown(field, profile)) { delete profile[field.key]; continue; }
    const value = profile[field.key];
    if (field.type === "multiselect") {
      const allowed = optionsFor(field, profile);
      profile[field.key] = [...new Set((Array.isArray(value) ? value : []).map((v) => String(v).trim()).filter((v) => allowed.includes(v)))];
      continue;
    }
    const text = value === undefined || value === null ? "" : String(value).trim();
    if (!text) {
      if (field.required && requireAll) return { ok: false, field: field.key, error: `Please answer: ${label}.` };
      delete profile[field.key];
      continue;
    }
    const allowed = field.type === "yesno" ? ["Yes", "No"] : optionsFor(field, profile);
    if (!allowed.includes(text)) {
      return { ok: false, field: field.key, error: `Choose a valid option for "${label}"${allowed.length && allowed.length <= 8 ? ` (${allowed.join(", ")})` : ""}.` };
    }
    profile[field.key] = text;
  }
  if (profile.country === "United States" && profile.employeeStates) {
    profile.employeeStates = profile.employeeStates.filter((s) => s !== profile.state);
  }
  if (profile.country === "Canada" && profile.operatingRegions) {
    profile.operatingRegions = profile.operatingRegions.filter((s) => s !== profile.state);
  }
  // Countries whose rules are national keep the country as the region.
  if (!profile.state) profile.state = profile.country;
  return { ok: true, profile };
}

/** What the forms need to render the questions (GET /api/public/form). */
function formDefinition() {
  return { countries: SUPPORTED_COUNTRIES, fields: FORMS };
}

module.exports = { ENTITY_TYPES, SUPPORTED_COUNTRIES, FORMS, checkProfile, formDefinition };
