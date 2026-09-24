// lib/paymentConfig.js
//
// Two jobs:
//
// 1. CURRENCY. Prices in lib/complianceFees.js are in US dollars. Razorpay
//    accounts in India reject USD unless "International Payments" has been
//    activated. Two ways to run:
//      PAYMENT_CURRENCY=USD (default) — charge dollars. Needs International
//                                        Payments activated on Razorpay.
//      PAYMENT_CURRENCY=INR           — charge rupees, converted from the
//                                        dollar price at USD_TO_INR_RATE
//                                        (e.g. 83.5). Works on every account.
//
// 2. ERRORS. The Razorpay SDK rejects with { statusCode, error: { code,
//    description } }. explainRazorpayError() turns that into a sentence a
//    person can act on, instead of the old generic "Could not start the
//    payment".

const SUPPORTED = ["USD", "INR"];

function paymentCurrency() {
  const c = (process.env.PAYMENT_CURRENCY || "USD").trim().toUpperCase();
  return SUPPORTED.includes(c) ? c : "USD";
}

function usdToInrRate() {
  const r = Number(process.env.USD_TO_INR_RATE);
  return isFinite(r) && r > 0 ? r : null;
}

/** Problems with the currency settings, in plain words (empty = fine). */
function currencyProblems() {
  const problems = [];
  const raw = (process.env.PAYMENT_CURRENCY || "USD").trim().toUpperCase();
  if (!SUPPORTED.includes(raw)) problems.push(`PAYMENT_CURRENCY is "${raw}"; it must be USD or INR.`);
  if (paymentCurrency() === "INR" && !usdToInrRate()) {
    problems.push("PAYMENT_CURRENCY is INR but USD_TO_INR_RATE isn't set (e.g. USD_TO_INR_RATE=83.5).");
  }
  return problems;
}

/**
 * What to actually charge for a USD price in cents.
 * Razorpay amounts are in the smallest unit (cents for USD, paise for INR).
 */
function chargeFor(usdCents) {
  const currency = paymentCurrency();
  if (currency === "INR") {
    const rate = usdToInrRate();
    if (!rate) {
      const err = new Error("USD_TO_INR_RATE is not set.");
      err.code = "PAYMENT_CURRENCY_MISCONFIGURED";
      throw err;
    }
    return { amount: Math.round(usdCents * rate), currency: "INR", rate };
  }
  return { amount: usdCents, currency: "USD", rate: null };
}

function formatCharge(amount, currency) {
  const v = amount / 100;
  return currency === "INR"
    ? "₹" + v.toLocaleString("en-IN", { minimumFractionDigits: v % 1 ? 2 : 0, maximumFractionDigits: 2 })
    : "$" + v.toLocaleString("en-US", { minimumFractionDigits: v % 1 ? 2 : 0, maximumFractionDigits: 2 });
}

/**
 * @returns {{ status: number|null, code: string, description: string, reason: string, fix: string }}
 */
function explainRazorpayError(err) {
  if (err && err.code === "RAZORPAY_NOT_CONFIGURED") {
    return { status: null, code: err.code, description: err.message, reason: "Razorpay keys are not set on the server.", fix: "Add RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET in your host's variables and redeploy." };
  }
  if (err && err.code === "PAYMENT_CURRENCY_MISCONFIGURED") {
    return { status: null, code: err.code, description: err.message, reason: "Currency settings are incomplete.", fix: "Set USD_TO_INR_RATE (e.g. 83.5), or remove PAYMENT_CURRENCY=INR." };
  }
  const status = err && typeof err.statusCode === "number" ? err.statusCode : null;
  const code = (err && err.error && err.error.code) || (err && err.code) || "UNKNOWN";
  const description = (err && err.error && err.error.description) || (err && err.message) || String(err);
  const d = description.toLowerCase();

  let reason = `Razorpay said: ${description}`;
  let fix = "Check the Razorpay dashboard, or run Admin → Check payments.";

  if (status === 401 || /authentication failed|invalid.*key|api key/i.test(d)) {
    reason = "Razorpay rejected the API keys.";
    fix = "RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET are wrong or from different modes. Copy both from Razorpay → Account & Settings → API Keys (both test, or both live) and redeploy.";
  } else if (/currency/i.test(d) && /(not supported|invalid|not allowed|not enabled)/i.test(d)) {
    reason = `Your Razorpay account can't accept ${paymentCurrency()} yet.`;
    fix = paymentCurrency() === "USD"
      ? "Activate International Payments in Razorpay (Account & Settings → Payment methods → International cards), or set PAYMENT_CURRENCY=INR and USD_TO_INR_RATE to charge in rupees."
      : "Check that INR payments are enabled on the account.";
  } else if (/amount/i.test(d) && /(minimum|less than|at least|too (low|small))/i.test(d)) {
    reason = "The amount is below Razorpay's minimum.";
    fix = "Raise the price for this service.";
  } else if (/not activated|activation|kyc/i.test(d)) {
    reason = "The Razorpay account isn't fully activated for live payments.";
    fix = "Finish activation (KYC) in the Razorpay dashboard, or use test keys until it's done.";
  } else if (!status && /(ENOTFOUND|ECONNRESET|ETIMEDOUT|timeout|network|Cannot read properties of undefined)/i.test(description)) {
    reason = "The server couldn't reach Razorpay.";
    fix = "Usually temporary. Try again in a minute; if it persists, check Razorpay's status page.";
  }
  return { status, code, description, reason, fix };
}

module.exports = { paymentCurrency, usdToInrRate, currencyProblems, chargeFor, formatCharge, explainRazorpayError };
