// lib/requiredDocuments.js
//
// WHAT THIS IS: a lookup table from a compliance item's name/category to
// the specific documents a client needs to hand over before staff can
// actually file it — the checklist shown in the portal next to each item
// ("Registered Agent Renewal" -> Consent Letter, Registered Address
// Proof, tick marks as each is uploaded).
//
// WHY THIS ISN'T PART OF THE CLAUDE-GENERATED CALENDAR ITEM: the calendar
// generation prompt (lib/claude.js) is already asking Claude to verify
// deadlines/fees via live web search per state — adding "and also
// enumerate the exact required documents" to that same call increases
// prompt complexity and gives the model one more thing to hallucinate
// under time pressure. The DOCUMENT list per requirement type is much
// more stable than the deadline/fee (it rarely changes state-to-state for
// a given entity type), so it's a good fit for a plain lookup table
// maintained here instead — cheaper, instant (no API call), and easy for
// a human to correct by editing one line instead of re-prompting an LLM.
//
// HOW MATCHING WORKS: getRequiredDocuments(item) checks item.compliance_name
// (case-insensitive) against KEYWORD_RULES in order and returns the first
// match's document list. Order matters — more specific rules are listed
// before generic fallbacks. If nothing matches, category-level defaults
// apply, and if even that doesn't match, a generic fallback list is
// returned so the UI never shows an empty checklist.
//
// MAINTENANCE: this list is a best-effort standard set for typical US
// entities and is deliberately generic (it doesn't vary by state) — it's
// meant to get the checklist UI populated correctly for the common cases
// immediately. Add a new rule here any time a client asks for something
// on this item type and it isn't already listed; keep entries short,
// concrete document names (what you'd literally ask someone to upload),
// not descriptions.

const KEYWORD_RULES = [
  {
    match: /registered agent/i,
    documents: ["Registered Agent Consent Letter", "Registered Office Address Proof"],
  },
  {
    match: /annual report/i,
    documents: [
      "Certificate of Incorporation / Formation",
      "List of Current Officers/Directors or Members/Managers",
      "Registered Agent Confirmation",
    ],
  },
  {
    match: /franchise tax/i,
    documents: [
      "Prior Year Franchise Tax Return (if any)",
      "Total Authorized Shares / Par Value Statement (for corporations)",
      "EIN Confirmation Letter",
    ],
  },
  {
    match: /business (privilege|license)/i,
    documents: ["Business License Application (if first year)", "Prior Year Filing (if renewal)", "EIN Confirmation Letter"],
  },
  {
    match: /(sales tax|gross receipts)/i,
    documents: ["Sales/Revenue Summary for the Filing Period", "Sales Tax Permit Number", "Exemption Certificates (if any exempt sales)"],
  },
  {
    match: /(payroll|withholding|unemployment)/i,
    documents: ["Payroll Summary Report for the Period", "State Withholding Account Number", "Employee W-4 / State Withholding Forms (new hires only)"],
  },
  {
    match: /income tax|corporate tax/i,
    documents: [
      "Prior Year Tax Return",
      "Profit & Loss Statement for the Fiscal Year",
      "Balance Sheet as of Fiscal Year End",
      "EIN Confirmation Letter",
    ],
  },
  {
    match: /beneficial ownership|boi/i,
    documents: ["Government-Issued Photo ID for Each Beneficial Owner", "Ownership Percentage Breakdown"],
  },
  {
    match: /(annual performance report|apr).*odi|odi.*(annual performance report|apr)/i,
    documents: [
      "Audited Financial Statements of the Foreign Entity",
      "Details of Investment (Share Certificates / Valuation Report)",
      "UIN (Unique Identification Number) Allotment Letter",
    ],
  },
  {
    match: /foreign liabilities.*assets|fla return/i,
    documents: ["Audited/Provisional Balance Sheet", "Details of Foreign Investment/Liabilities", "PAN of the Company"],
  },
  {
    match: /transfer pricing/i,
    documents: ["Related-Party Transaction Summary", "Transfer Pricing Study/Benchmarking Report (if available)", "Intercompany Agreements"],
  },
  {
    match: /dissolution|withdrawal|terminat/i,
    documents: ["Board/Member Resolution Approving Dissolution", "Final Tax Clearance (if required by state)"],
  },
];

// Category-level fallback when no keyword rule matches — still better
// than nothing, and keeps the checklist from ever rendering empty.
const CATEGORY_DEFAULTS = {
  "Mandatory Annual": ["Certificate of Incorporation / Formation", "EIN Confirmation Letter"],
  Conditional: ["Supporting Documentation Relevant to This Filing"],
  "Transfer Pricing": ["Related-Party Transaction Summary"],
  "Foreign Reporting (ODI/FEMA)": ["Supporting Investment/Transaction Documentation"],
  "Event-Based": ["Documentation of the Triggering Event"],
};

const GENERIC_FALLBACK = ["Supporting Documentation for This Filing"];

/**
 * @param {{ compliance_name: string, category?: string }} item
 * @returns {string[]} document labels required for this item, in a
 *   stable order (used both for rendering the checklist and for tagging
 *   uploads with a matching requirementLabel).
 */
function getRequiredDocuments(item) {
  const name = (item && item.compliance_name) || "";
  for (const rule of KEYWORD_RULES) {
    if (rule.match.test(name)) return rule.documents;
  }
  if (item && item.category && CATEGORY_DEFAULTS[item.category]) {
    return CATEGORY_DEFAULTS[item.category];
  }
  return GENERIC_FALLBACK;
}

module.exports = { getRequiredDocuments };
