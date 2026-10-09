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
// The regions (states, cantons, prefectures…) a country's data file lists.
const regionsOf = (country) => Object.keys(db.countryData(country).regions);

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
  Australia: [
    { key: "state", type: "select", label: "State or territory", options: regionsOf("Australia"), required: true },
    { key: "entityType", type: "select", label: "Business structure", required: true,
      options: ["Proprietary Company (Pty Ltd)", "Public Company (Ltd)", "Sole Trader", "Partnership", "Trust", "Branch of Foreign Company"] },
    { key: "gst", type: "select", label: "GST registration", options: ["Not registered", "Quarterly", "Monthly", "Annual"], required: true,
      optionLabels: { Quarterly: "Registered, quarterly activity statements", Monthly: "Registered, monthly activity statements", Annual: "Registered, annual GST return" } },
    EMPLOYEES,
    { key: "employeeStates", type: "multiselect", label: "Other states or territories where employees work", options: regionsOf("Australia"), showIf: { hasEmployees: ["Yes"] },
      help: "Payroll tax and workers' compensation follow the state where each employee works." },
  ],
  Austria: [
    { key: "state", type: "select", label: "Federal state (Bundesland)", options: regionsOf("Austria"), required: true },
    { key: "entityType", type: "select", label: "Entity type", required: true,
      options: ["GmbH", "FlexKapG (FlexCo)", "AG", "Sole Proprietorship (Einzelunternehmen)", "Partnership (OG / KG)", "Branch of Foreign Company"] },
    { key: "vat", type: "select", label: "VAT advance returns (UVA)", options: ["Monthly", "Quarterly", "Not registered"], required: true,
      optionLabels: { Quarterly: "Quarterly (turnover up to €100,000)", "Not registered": "Not registered / small business (Kleinunternehmer)" } },
    EMPLOYEES,
  ],
  Belgium: [
    { key: "entityType", type: "select", label: "Entity type", required: true,
      options: ["BV / SRL (private limited company)", "NV / SA (public limited company)", "Sole Proprietorship (eenmanszaak)", "Partnership (VOF / CommV)", "Branch of Foreign Company"] },
    { key: "vat", type: "select", label: "VAT returns", options: ["Quarterly", "Monthly", "Not registered"], required: true,
      optionLabels: { "Not registered": "No returns (small-business exemption)" } },
    EMPLOYEES,
  ],
  Denmark: [
    { key: "entityType", type: "select", label: "Entity type", required: true,
      options: ["ApS (private limited company)", "A/S (public limited company)", "Sole Proprietorship (enkeltmandsvirksomhed)", "Partnership (I/S)", "Branch of Foreign Company (filial)"] },
    { key: "vat", type: "select", label: "VAT (moms) returns", options: ["Half-yearly", "Quarterly", "Monthly", "Not registered"], required: true,
      optionLabels: { "Half-yearly": "Half-yearly (turnover under DKK 5 million)", Quarterly: "Quarterly (DKK 5–50 million, and new businesses)", Monthly: "Monthly (over DKK 50 million)" } },
    EMPLOYEES,
  ],
  France: [
    { key: "entityType", type: "select", label: "Entity type", required: true,
      options: ["SAS", "SASU", "SARL", "EURL", "SA", "Entreprise Individuelle (sole proprietor)", "Branch of Foreign Company (succursale)"] },
    { key: "vat", type: "select", label: "VAT (TVA) regime", options: ["Monthly", "Quarterly", "Annual", "Not registered"], required: true,
      optionLabels: { Monthly: "Normal regime, monthly returns", Quarterly: "Normal regime, quarterly returns (VAT under €4,000 a year)", Annual: "Simplified regime, annual return", "Not registered": "VAT exemption (franchise en base)" } },
    EMPLOYEES,
    { key: "employeeBand", type: "select", label: "How many employees?", options: ["Fewer than 11", "11–49", "50 or more"], required: true,
      showIf: { hasEmployees: ["Yes"] }, help: "Payroll filing dates and staff representation duties depend on headcount." },
  ],
  "Hong Kong": [
    { key: "entityType", type: "select", label: "Business type", required: true,
      options: ["Private Company Limited by Shares", "Branch of Non-Hong Kong Company", "Sole Proprietorship", "Partnership"] },
    EMPLOYEES,
  ],
  Ireland: [
    { key: "entityType", type: "select", label: "Entity type", required: true,
      options: ["Private Company Limited by Shares (LTD)", "Designated Activity Company (DAC)", "Public Limited Company (PLC)", "Sole Trader", "Partnership", "Branch of Foreign Company"] },
    { key: "vat", type: "select", label: "VAT registration", options: ["Not registered", "Bi-monthly", "Monthly"], required: true,
      optionLabels: { "Bi-monthly": "Registered, returns every two months", Monthly: "Registered, monthly returns" } },
    EMPLOYEES,
  ],
  Italy: [
    { key: "state", type: "select", label: "Region", options: regionsOf("Italy"), required: true },
    { key: "entityType", type: "select", label: "Entity type", required: true,
      options: ["S.r.l.", "S.r.l.s. (simplified)", "S.p.A.", "Sole Proprietorship (ditta individuale)", "Partnership (S.n.c. / S.a.s.)", "Branch of Foreign Company"] },
    { key: "vat", type: "select", label: "VAT (IVA) settlements", options: ["Monthly", "Quarterly", "Not registered"], required: true,
      optionLabels: { "Not registered": "No VAT charged (flat-rate regime, regime forfettario)" } },
    EMPLOYEES,
  ],
  Japan: [
    { key: "state", type: "select", label: "Prefecture of the head office", options: regionsOf("Japan"), required: true },
    { key: "entityType", type: "select", label: "Entity type", required: true,
      options: ["Kabushiki Kaisha (KK)", "Godo Kaisha (GK)", "Branch of Foreign Company", "Sole Proprietorship (kojin jigyo)"] },
    { key: "vat", type: "select", label: "Consumption tax", options: ["Annual", "Not registered"], required: true,
      optionLabels: { Annual: "Taxable business (files consumption tax returns)", "Not registered": "Exempt business" } },
    EMPLOYEES,
  ],
  Netherlands: [
    { key: "entityType", type: "select", label: "Entity type", required: true,
      options: ["BV (private limited company)", "NV (public limited company)", "Eenmanszaak (sole proprietorship)", "VOF (general partnership)", "Branch of Foreign Company"] },
    { key: "vat", type: "select", label: "VAT (btw) returns", options: ["Quarterly", "Monthly", "Annual", "Not registered"], required: true,
      optionLabels: { "Not registered": "No returns (small businesses scheme, KOR)" } },
    EMPLOYEES,
  ],
  Norway: [
    { key: "entityType", type: "select", label: "Entity type", required: true,
      options: ["AS (private limited company)", "ASA (public limited company)", "Enkeltpersonforetak (sole proprietorship)", "ANS / DA (partnership)", "NUF (Norwegian branch of a foreign company)"] },
    { key: "vat", type: "select", label: "VAT (MVA) registration", options: ["Not registered", "Bi-monthly", "Annual"], required: true,
      optionLabels: { "Bi-monthly": "Registered, returns every two months", Annual: "Registered, annual return" } },
    EMPLOYEES,
  ],
  Portugal: [
    { key: "state", type: "select", label: "Where is the business based?", options: regionsOf("Portugal"), required: true },
    { key: "entityType", type: "select", label: "Entity type", required: true,
      options: ["Lda (sociedade por quotas)", "Unipessoal Lda", "SA (sociedade anónima)", "Sole Proprietorship (empresário em nome individual)", "Branch of Foreign Company"] },
    { key: "vat", type: "select", label: "VAT (IVA) returns", options: ["Quarterly", "Monthly", "Not registered"], required: true,
      optionLabels: { Quarterly: "Quarterly (turnover under €650,000)", "Not registered": "No returns (article 53 exemption)" } },
    EMPLOYEES,
  ],
  "South Korea": [
    { key: "entityType", type: "select", label: "Entity type", required: true,
      options: ["Yuhan Hoesa (limited company)", "Jusik Hoesa (stock company)", "Branch of Foreign Company", "Sole Proprietorship"] },
    EMPLOYEES,
  ],
  Spain: [
    { key: "state", type: "select", label: "Autonomous community", options: regionsOf("Spain"), required: true,
      help: "The Basque Country and Navarre have their own tax offices; the Canary Islands, Ceuta and Melilla have their own sales taxes." },
    { key: "entityType", type: "select", label: "Entity type", required: true,
      options: ["Sociedad Limitada (S.L.)", "Sociedad Anónima (S.A.)", "Autónomo (self-employed)", "Branch of Foreign Company (sucursal)"] },
    { key: "vat", type: "select", label: "VAT (IVA / IGIC) returns", options: ["Quarterly", "Monthly"], required: true,
      optionLabels: { Monthly: "Monthly (large company, or monthly refund register)" } },
    EMPLOYEES,
  ],
  Sweden: [
    { key: "entityType", type: "select", label: "Entity type", required: true,
      options: ["Aktiebolag (AB)", "Enskild firma (sole trader)", "Handelsbolag / Kommanditbolag (partnership)", "Branch of Foreign Company (filial)"] },
    { key: "vat", type: "select", label: "VAT (moms) returns", options: ["Quarterly", "Monthly", "Annual", "Not registered"], required: true,
      optionLabels: { Annual: "Annual (turnover up to SEK 1 million)" } },
    EMPLOYEES,
  ],
  Switzerland: [
    { key: "state", type: "select", label: "Canton", options: regionsOf("Switzerland"), required: true },
    { key: "entityType", type: "select", label: "Entity type", required: true,
      options: ["AG / SA (company limited by shares)", "GmbH / Sàrl (limited liability company)", "Sole Proprietorship (Einzelunternehmen)", "Kollektivgesellschaft (general partnership)", "Branch of Foreign Company"] },
    { key: "vat", type: "select", label: "VAT returns", options: ["Quarterly", "Semi-annual", "Monthly", "Annual", "Not registered"], required: true,
      optionLabels: { Quarterly: "Quarterly (effective method)", "Semi-annual": "Half-yearly (net tax rate method)" } },
    EMPLOYEES,
    { key: "employeeStates", type: "multiselect", label: "Other cantons where employees are taxed at source", options: regionsOf("Switzerland"), showIf: { hasEmployees: ["Yes"] },
      help: "Tax at source on foreign employees' wages goes to the canton where each employee lives or works." },
  ],
};
// The United States first (the default), then alphabetically.
const SUPPORTED_COUNTRIES = ["United States", ...Object.keys(FORMS).filter((c) => c !== "United States").sort()];
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
 * Returns { ok: true, profile, unanswered } or { ok: false, error, field }.
 * unanswered: the questions still to answer ({ key, label }), for the
 * calendar that grows as a signed-in user fills in the form.
 */
function checkProfile(input, { requireAll = true } = {}) {
  if (!input || typeof input !== "object") return { ok: false, error: "Missing company details.", field: "profile" };
  const profile = { ...input };
  profile.country = String(profile.country || "United States").trim();
  // Free text typed by the visitor: keep it text, and a sensible length.
  if (profile.companyName !== undefined) {
    profile.companyName = typeof profile.companyName === "string" ? profile.companyName.replace(/\s+/g, " ").trim().slice(0, 200) : "";
  }
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

  const unanswered = [];
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
      if (field.required || field.type === "yesno") unanswered.push({ key: field.key, label });
      delete profile[field.key];
      continue;
    }
    const allowed = field.type === "yesno" ? ["Yes", "No"] : optionsFor(field, profile);
    if (!allowed.includes(text)) {
      return { ok: false, field: field.key, error: `Choose a valid option for "${label}"${allowed.length && allowed.length <= 8 ? ` (${allowed.join(", ")})` : ""}.` };
    }
    profile[field.key] = text;
  }
  if (profile.country !== "Canada" && profile.employeeStates) {
    profile.employeeStates = profile.employeeStates.filter((s) => s !== profile.state);
  }
  if (profile.country === "Canada" && profile.operatingRegions) {
    profile.operatingRegions = profile.operatingRegions.filter((s) => s !== profile.state);
  }
  // Countries whose rules are national keep the country as the region.
  if (!profile.state) profile.state = profile.country;
  return { ok: true, profile, unanswered };
}

/** What the forms need to render the questions (GET /api/public/form). */
function formDefinition() {
  return { countries: SUPPORTED_COUNTRIES, fields: Object.fromEntries(SUPPORTED_COUNTRIES.map((c) => [c, FORMS[c]])) };
}

module.exports = { ENTITY_TYPES, SUPPORTED_COUNTRIES, FORMS, checkProfile, formDefinition };
