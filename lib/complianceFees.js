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
    service: "Registered agent renewal",
    match: /registered agent/i,
    kind: "fixed",
    amountCents: 12500, // $125
    note: "",
  },
  {
    service: "Business privilege / license",
    match: /business (privilege|license)/i,
    kind: "quote",
    label: "Price on request",
    amountCents: null,
    note: "Price TBA.",
  },
  {
    service: "Annual bookkeeping & financial statements",
    match: /annual bookkeeping|financial statement close/i,
    kind: "from",
    label: "From $150 / month",
    amountCents: null,
    note: "Starting at $150/month; final price TBA.",
  },
  {
    service: "ODI Annual Performance Report",
    match: /(annual performance report|apr).*odi|odi.*(annual performance report|apr)/i,
    kind: "from",
    label: "From $300",
    amountCents: null,
    note: "Base $300; audit and cross-border filings priced separately.",
  },
  {
    service: "Annual general meeting (AGM)",
    match: /annual general meeting|\bagm\b/i,
    kind: "fixed",
    amountCents: 20000, // $200
    note: "",
  },
  {
    service: "Form 1099-NEC / 1099-MISC",
    match: /1099-nec|1099-misc/i,
    kind: "from",
    label: "From $2.75 per form",
    amountCents: null,
    note: "Depends on number of forms (approx. tiered: $2.75/form for 1-100, then $50 base) — confirm exact tiering with team.",
  },
  {
    service: "Form 940 (federal unemployment tax)",
    match: /federal unemployment tax.*940|form 940/i,
    kind: "fixed",
    amountCents: 20000, // $200
    note: "",
  },
  {
    service: "W-2 filing with the SSA",
    match: /w-2 filing|w-2.*ssa/i,
    kind: "fixed",
    amountCents: 15000, // $150
    note: "",
  },
  {
    service: "Withholding reconciliation",
    match: /withholding reconciliation/i,
    kind: "included",
    label: "Included in the bookkeeping / license renewal package",
    amountCents: null,
    note: "Included with Delaware State Business License Renewal / Annual Bookkeeping package — not billed separately.",
  },
  {
    service: "Annual report & franchise tax",
    match: /annual report.*franchise tax|franchise tax.*annual report/i,
    kind: "fixed",
    amountCents: 10000, // $100
    note: "",
  },
  {
    service: "FLA return (foreign liabilities & assets)",
    match: /foreign liabilities.*assets|fla return/i,
    kind: "fixed",
    amountCents: 30000, // $300
    note: "",
  },
  {
    service: "Form 1120 federal corporate income tax return",
    match: /form 1120\b(?!-w)/i, // 1120 but not 1120-W (matched separately below)
    kind: "from",
    label: "From $650",
    amountCents: null,
    note: "Starts at $650.",
  },
  {
    service: "Form 1100 (Delaware corporate income tax)",
    match: /form 1100\b|delaware corporate income tax/i,
    kind: "included",
    label: "Included with Form 1120 (+$100 per extra state)",
    amountCents: null,
    note: "Included with Form 1120 filing; +$100 per additional state if multi-state.",
  },
  {
    service: "Form 1120-W quarterly estimated tax",
    match: /1120-w|quarterly estimated tax/i,
    kind: "fixed",
    amountCents: 15000, // $150
    note: "",
  },
  {
    service: "Form 941 quarterly payroll return",
    match: /form 941/i,
    kind: "fixed",
    amountCents: 15000, // $150
    note: "",
  },
  {
    service: "Franchise tax quarterly installment",
    match: /franchise tax.*quarterly installment/i,
    kind: "fixed",
    label: "$150 per quarter",
    amountCents: 15000, // $150
    note: "Billed per quarter.",
  },
  {
    service: "Employer withholding tax return",
    match: /employer withholding tax return/i,
    kind: "fixed",
    amountCents: 10000, // $100
    note: "",
  },
  {
    service: "Sales & use tax (nexus states)",
    match: /sales.*use tax.*nexus|nexus.*sales.*use tax/i,
    kind: "from",
    label: "From $100 per state",
    amountCents: null,
    note: "Nexus registration approx. $100-250; filing approx. $100-150, depending on state.",
  },
  {
    service: "State corporate income tax (nexus states)",
    match: /state corporate income tax.*nexus/i,
    kind: "included",
    label: "Included with the sales/use tax nexus filing",
    amountCents: null,
    note: 'Combined with "Sales/Use Tax Registration & Filing in Nexus States" — see that item.',
  },
];

// Shown when a filing has no price in the list above. Short form for the
// price tag, full sentence wherever there's room to explain.
const QUOTE_LABEL = "Price on request";
const QUOTE_MESSAGE = "We'll contact you with the price as soon as you upload your documents.";

// The sentence shown under each price, by kind.
function priceMessage(kind, label) {
  switch (kind) {
    case "invoiced": return "This is the final price. Pay here once every document is uploaded.";
    case "fixed": return "Standard price. It's added as soon as you choose this service; pay once your documents are uploaded.";
    case "from": return `Starts at ${label.replace(/^From\s+/i, "")}. We'll confirm the exact price as soon as you upload your documents.`;
    case "included": return "No separate charge.";
    default: return QUOTE_MESSAGE;
  }
}

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
    const label = formatUSD(item.feeAmountCents);
    return { kind: "invoiced", label, amountCents: item.feeAmountCents, currency: "USD", message: priceMessage("invoiced", label), fromPriceList: item.quotedBy === PRICE_LIST_ACTOR };
  }
  const s = getSuggestedFee(item);
  return { kind: s.kind, label: s.label, amountCents: s.amountCents, currency: "USD", message: priceMessage(s.kind, s.label) };
}

// quotedBy value for prices applied automatically from the list above,
// so staff (and the deselect rule) can tell them apart from hand quotes.
const PRICE_LIST_ACTOR = "price-list";

/**
 * When a client chooses a service that has a FIXED price in the list,
 * the price applies straight away — no waiting for staff to send it.
 * "From …" and unlisted items still wait for staff, who confirm the
 * price after the documents are in. Returns true if a price was applied.
 */
function applyListPrice(item) {
  if (!item || item.feeAmountCents || item.paymentStatus !== "Not Invoiced") return false;
  const s = getSuggestedFee(item);
  if (s.kind !== "fixed" || !s.amountCents) return false;
  item.feeAmountCents = s.amountCents;
  item.paymentStatus = "Invoiced";
  item.quotedBy = PRICE_LIST_ACTOR;
  item.quotedAt = new Date();
  item.quoteNote = "";
  return true;
}

/** Undo applyListPrice when the client removes the service (only if unpaid and untouched by staff). */
function removeListPrice(item) {
  if (!item || item.quotedBy !== PRICE_LIST_ACTOR || item.paymentStatus === "Paid") return false;
  item.feeAmountCents = null;
  item.paymentStatus = "Not Invoiced";
  item.quotedBy = null;
  item.quotedAt = null;
  if (item.razorpayOrderId) {
    item.paymentEvents.push({ event: "order_voided", razorpayOrderId: item.razorpayOrderId });
    item.razorpayOrderId = null;
  }
  return true;
}

// The whole price list, for the finance screen and the portal's price section.
function getPriceList() {
  return KEYWORD_RULES.map((r) => ({
    service: r.service,
    label: r.label || (r.amountCents ? formatUSD(r.amountCents) : QUOTE_LABEL),
    kind: r.kind || (r.amountCents ? "fixed" : "quote"),
    amountCents: r.amountCents,
    note: r.note || "",
  }));
}

module.exports = {
  getSuggestedFee, getPriceInfo, applyListPrice, removeListPrice, getPriceList,
  formatUSD, CUSTOMER_MESSAGE_VARIABLE, QUOTE_MESSAGE, PRICE_LIST_ACTOR,
};
