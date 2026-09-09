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
    amountCents: 12500, // $125
    note: "",
  },
  {
    match: /business (privilege|license)/i,
    amountCents: null,
    note: "Price TBA.",
  },
  {
    match: /annual bookkeeping|financial statement close/i,
    amountCents: null,
    note: "Starting at $150/month; final price TBA.",
  },
  {
    match: /(annual performance report|apr).*odi|odi.*(annual performance report|apr)/i,
    amountCents: null,
    note: "Base $300; audit and cross-border filings priced separately.",
  },
  {
    match: /annual general meeting|\bagm\b/i,
    amountCents: 20000, // $200
    note: "",
  },
  {
    match: /1099-nec|1099-misc/i,
    amountCents: null,
    note: "Depends on number of forms (approx. tiered: $2.75/form for 1-100, then $50 base) — confirm exact tiering with team.",
  },
  {
    match: /federal unemployment tax.*940|form 940/i,
    amountCents: 20000, // $200
    note: "",
  },
  {
    match: /w-2 filing|w-2.*ssa/i,
    amountCents: 15000, // $150
    note: "",
  },
  {
    match: /withholding reconciliation/i,
    amountCents: null,
    note: "Included with Delaware State Business License Renewal / Annual Bookkeeping package — not billed separately.",
  },
  {
    match: /annual report.*franchise tax|franchise tax.*annual report/i,
    amountCents: 10000, // $100
    note: "",
  },
  {
    match: /foreign liabilities.*assets|fla return/i,
    amountCents: 30000, // $300
    note: "",
  },
  {
    match: /form 1120\b(?!-w)/i, // 1120 but not 1120-W (matched separately below)
    amountCents: null,
    note: "Starts at $650.",
  },
  {
    match: /form 1100\b|delaware corporate income tax/i,
    amountCents: null,
    note: "Included with Form 1120 filing; +$100 per additional state if multi-state.",
  },
  {
    match: /1120-w|quarterly estimated tax/i,
    amountCents: 15000, // $150
    note: "",
  },
  {
    match: /form 941/i,
    amountCents: 15000, // $150
    note: "",
  },
  {
    match: /franchise tax.*quarterly installment/i,
    amountCents: 15000, // $150
    note: "Billed per quarter.",
  },
  {
    match: /employer withholding tax return/i,
    amountCents: 10000, // $100
    note: "",
  },
  {
    match: /sales.*use tax.*nexus|nexus.*sales.*use tax/i,
    amountCents: null,
    note: "Nexus registration approx. $100-250; filing approx. $100-150, depending on state.",
  },
  {
    match: /state corporate income tax.*nexus/i,
    amountCents: null,
    note: 'Combined with "Sales/Use Tax Registration & Filing in Nexus States" — see that item.',
  },
];

/**
 * @param {{ compliance_name: string }} item
 * @returns {{ amountCents: number|null, note: string, customerMessage: string|null }}
 *   amountCents is null when the item is variable-priced — staff should
 *   read `note` and set item.feeAmountCents manually via the status
 *   route rather than trusting an auto-filled number. When amountCents
 *   is set, customerMessage is null (there's a real price to show);
 *   when it's null, customerMessage is the line to show the client
 *   instead of a price.
 */
function getSuggestedFee(item) {
  const name = (item && item.compliance_name) || "";
  for (const rule of KEYWORD_RULES) {
    if (rule.match.test(name)) {
      return {
        amountCents: rule.amountCents,
        note: rule.note,
        customerMessage: rule.amountCents === null ? CUSTOMER_MESSAGE_VARIABLE : null,
      };
    }
  }
  // No match — nothing in the price list covers this item yet (e.g. a
  // newly-added or state-specific filing). Treat like any other
  // variable-priced item rather than silently suggesting $0.
  return {
    amountCents: null,
    note: "Not in the standard price list yet — set manually.",
    customerMessage: CUSTOMER_MESSAGE_VARIABLE,
  };
}

module.exports = { getSuggestedFee, CUSTOMER_MESSAGE_VARIABLE };
