// lib/businessInfo.js
//
// ONE place for the business details shown on the legal pages (/terms,
// /privacy, /refund-policy, /shipping-policy, /contact, /about, /pricing),
// in the site footer and in emails. Payment-gateway reviewers (Razorpay)
// check that these pages exist, are linked from every page, and show the
// SAME registered business name, address, email and phone everywhere.
//
// Fill in the values below once. Each can also be overridden by a Railway
// variable of the same name (e.g. BUSINESS_LEGAL_NAME), which wins.
// Admin → "Legal pages" lists anything still missing.

const DEFAULTS = {
  // Brand shown to clients.
  BRAND_NAME: "ComplyGlobally",
  // Registered legal name exactly as on your company / GST registration,
  // e.g. "ComplyGlobally Advisors Private Limited". Razorpay requires the
  // billing label to match this or your domain.
  BUSINESS_LEGAL_NAME: "",
  // Full registered address, one line per part, separated by "|".
  BUSINESS_ADDRESS: "",
  SUPPORT_EMAIL: "support@complyglobally.com",
  SUPPORT_PHONE: "",
  BUSINESS_HOURS: "Monday to Friday, 10:00 to 18:00 IST",
  // Optional registration numbers, shown on Contact / About if set.
  GSTIN: "",
  CIN: "",
  // Grievance Officer (required for Indian platforms under the IT Rules and
  // the Digital Personal Data Protection Act). Defaults to support contact.
  GRIEVANCE_OFFICER_NAME: "",
  GRIEVANCE_OFFICER_EMAIL: "",
  // City whose courts have jurisdiction under the Terms.
  JURISDICTION_CITY: "",
  // Date shown as "Last updated" on the policies.
  POLICIES_LAST_UPDATED: "24 September 2026",
  // Commercial terms used in the policies (edit to match how you work).
  REFUND_PROCESSING_DAYS: "5 to 7 business days",
  DOCS_LEAD_TIME_DAYS: "10", // business days before a deadline we need everything by
};

const REQUIRED = [
  ["BUSINESS_LEGAL_NAME", "Registered business name"],
  ["BUSINESS_ADDRESS", "Registered address"],
  ["SUPPORT_EMAIL", "Support email"],
  ["SUPPORT_PHONE", "Support phone number"],
  ["JURISDICTION_CITY", "City for legal jurisdiction (e.g. New Delhi)"],
];

function get(key) {
  const v = process.env[key];
  return (v !== undefined && String(v).trim() !== "" ? String(v) : DEFAULTS[key] || "").trim();
}

function businessInfo() {
  const info = {};
  Object.keys(DEFAULTS).forEach((k) => { info[k] = get(k); });
  info.addressLines = info.BUSINESS_ADDRESS ? info.BUSINESS_ADDRESS.split("|").map((s) => s.trim()).filter(Boolean) : [];
  info.displayName = info.BUSINESS_LEGAL_NAME || info.BRAND_NAME;
  info.grievanceName = info.GRIEVANCE_OFFICER_NAME || "Grievance Officer";
  info.grievanceEmail = info.GRIEVANCE_OFFICER_EMAIL || info.SUPPORT_EMAIL;
  info.appUrl = (process.env.APP_URL || "").replace(/\/+$/, "");
  return info;
}

/** Required details that are still empty: [{ key, label }]. */
function missingBusinessInfo() {
  return REQUIRED.filter(([k]) => !get(k)).map(([key, label]) => ({ key, label }));
}

module.exports = { businessInfo, missingBusinessInfo, DEFAULTS };
