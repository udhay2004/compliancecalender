// lib/complianceFees.js
//
// WHAT THIS IS: a lookup table from a compliance item's name to the fee
// the firm typically charges for it — mirrors lib/requiredDocuments.js
// (same KEYWORD_RULES-in-order matching, same reasoning for why this is
// a plain table instead of something Claude generates: firm pricing
// doesn't vary by state and shouldn't ever be hallucinated).
//
// WHAT THIS IS NOT: this table does NOT set item.feeAmountCents itself,
// and never touches anything a client could pay against. It only powers
// getSuggestedFee(item), which routes/calendar.routes.js surfaces to
// staff as a *suggestion* — pre-filling what to type, not auto-invoicing.
// The actual charge always still comes from item.feeAmountCents, set
// explicitly by a staff member via PATCH /:id/items/:index/status. See
// the comment on that route for why it has to stay that way.
//
// CURRENCY: amounts are in USD cents (Razorpay's smallest-unit
// convention — see routes/payments.routes.js, currency: "USD").
//
// VARIABLE-PRICED ITEMS: several filings don't have one fixed price
// (form-count-dependent, bundled into another item, multi-state
// add-ons, audit-dependent). For those, amountCents is null and
// `note` explains why — surfaced to staff so they know to quote the
// client manually rather than seeing a blank/zero fee and assuming
// it's free. `customerMessage` is the client-facing line for those
// cases, shown instead of a price until staff sets one.
//
// MAINTENANCE: add a rule here any time the firm's price list changes;
// keep `note` short and specific enough that a staff member reading it
// knows what to actually charge without digging through old invoices.

const CUSTOMER_MESSAGE_VARIABLE =
  "We will verify your documents and our team will get back to you.";

const KEYWORD_RULES = [
  {
    match: /registered agent/i,
    kind: "fixed",
    amountCents: 12500, // $125
    note: "",
  },
  {
    match: /business (privilege|license)/i,
    kind: "quote",
    label: "Quoted after document review",
    amountCents: null,
    note: "Price TBA.",
  },
  {
    match: /annual bookkeeping|financial statement close/i,
    kind: "from",
    label: "From $150 / month",
    amountCents: null,
    note: "Starting at $150/month; final price TBA.",
  },
  {
    match: /(annual performance report|apr).*odi|odi.*(annual performance report|apr)/i,
    kind: "from",
    label: "From $300",
    amountCents: null,
    note: "Base $300; audit and cross-border filings priced separately.",
  },
  {
    match: /annual general meeting|\bagm\b/i,
    kind: "fixed",
    amountCents: 20000, // $200
    note: "",
  },
  {
    match: /1099-nec|1099-misc/i,
    kind: "from",
    label: "From $2.75 per form",
    amountCents: null,
    note: "Depends on number of forms (approx. tiered: $2.75/form for 1-100, then $50 base) — confirm exact tiering with team.",
  },
  {
    match: /federal unemployment tax.*940|form 940/i,
    kind: "fixed",
    amountCents: 20000, // $200
    note: "",
  },
  {
    match: /w-2 filing|w-2.*ssa/i,
    kind: "fixed",
    amountCents: 15000, // $150
    note: "",
  },
  {
    match: /withholding reconciliation/i,
    kind: "included",
    label: "Included in the bookkeeping / license renewal package",
    amountCents: null,
    note: "Included with Delaware State Business License Renewal / Annual Bookkeeping package — not billed separately.",
  },
  {
    match: /annual report.*franchise tax|franchise tax.*annual report/i,
    kind: "fixed",
    amountCents: 10000, // $100
    note: "",
  },
  {
    match: /foreign liabilities.*assets|fla return/i,
    kind: "fixed",
    amountCents: 30000, // $300
    note: "",
  },
  {
    match: /form 1120\b(?!-w)/i, // 1120 but not 1120-W (matched separately below)
    kind: "from",
    label: "From $650",
    amountCents: null,
    note: "Starts at $650.",
  },
  {
    match: /form 1100\b|delaware corporate income tax/i,
    kind: "included",
    label: "Included with Form 1120 (+$100 per extra state)",
    amountCents: null,
    note: "Included with Form 1120 filing; +$100 per additional state if multi-state.",
  },
  {
    match: /1120-w|quarterly estimated tax/i,
    kind: "fixed",
    amountCents: 15000, // $150
    note: "",
  },
  {
    match: /form 941/i,
    kind: "fixed",
    amountCents: 15000, // $150
    note: "",
  },
  {
    match: /franchise tax.*quarterly installment/i,
    kind: "fixed",
    label: "$150 per quarter",
    amountCents: 15000, // $150
    note: "Billed per quarter.",
  },
  {
    match: /employer withholding tax return/i,
    kind: "fixed",
    amountCents: 10000, // $100
    note: "",
  },
  {
    match: /sales.*use tax.*nexus|nexus.*sales.*use tax/i,
    kind: "from",
    label: "From $100 per state",
    amountCents: null,
    note: "Nexus registration approx. $100-250; filing approx. $100-150, depending on state.",
  },
  {
    match: /state corporate income tax.*nexus/i,
    kind: "included",
    label: "Included with the sales/use tax nexus filing",
    amountCents: null,
    note: 'Combined with "Sales/Use Tax Registration & Filing in Nexus States" — see that item.',
  },
];

const QUOTE_LABEL = "Quoted after document review";

function formatUSD(cents) {
  const dollars = cents / 100;
  return "$" + dollars.toLocaleString("en-US", { minimumFractionDigits: dollars % 1 ? 2 : 0, maximumFractionDigits: 2 });
}

function matchRule(item) {
  const name = (item && item.compliance_name) || "";
  return KEYWORD_RULES.find((rule) => rule.match.test(name)) || null;
}

/**
 * Staff-facing suggestion used to pre-fill the "fee" box. Never applied
 * automatically — see the header comment.
 * @returns {{ amountCents: number|null, note: string, customerMessage: string|null, label: string, kind: string }}
 */
function getSuggestedFee(item) {
  const rule = matchRule(item);
  if (!rule) {
    // Nothing in the price list covers this item yet (e.g. a newly-added
    // or state-specific filing). Treat like any other variable-priced
    // item rather than silently suggesting $0.
    return {
      amountCents: null,
      note: "Not in the standard price list yet — set manually.",
      customerMessage: CUSTOMER_MESSAGE_VARIABLE,
      label: QUOTE_LABEL,
      kind: "quote",
    };
  }
  return {
    amountCents: rule.amountCents,
    note: rule.note,
    customerMessage: rule.amountCents === null ? CUSTOMER_MESSAGE_VARIABLE : null,
    label: rule.label || (rule.amountCents ? formatUSD(rule.amountCents) : QUOTE_LABEL),
    kind: rule.kind || (rule.amountCents ? "fixed" : "quote"),
  };
}

/**
 * The price line BOTH sides see for an item, so the portal and the staff
 * screen can never disagree about what something costs.
 *
 *   kind "invoiced" - staff has set the actual fee; this is what gets charged
 *   kind "fixed"    - standard price-list amount, not invoiced yet
 *   kind "from"     - starting price; final quote after review
 *   kind "included" - bundled into another item, no separate charge
 *   kind "quote"    - no list price; quoted after document review
 *
 * Deliberately excludes the internal `note`, which is written for staff.
 */
function getPriceInfo(item) {
  if (item && item.feeAmountCents) {
    return { kind: "invoiced", label: formatUSD(item.feeAmountCents), amountCents: item.feeAmountCents, currency: "USD" };
  }
  const s = getSuggestedFee(item);
  return { kind: s.kind, label: s.label, amountCents: s.amountCents, currency: "USD" };
}

module.exports = { getSuggestedFee, getPriceInfo, formatUSD, CUSTOMER_MESSAGE_VARIABLE };
