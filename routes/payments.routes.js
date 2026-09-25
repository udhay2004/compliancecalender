// routes/payments.routes.js
//
// Client-facing Razorpay payments for a single Calendar item, mounted at
// /api/portal/payments (see server.js), plus the webhook handler (mounted
// separately in server.js with a raw body parser).
//
// PRINCIPLES (why the code below looks the way it does):
//
//  1. The browser never decides the price. The amount charged is always
//     item.feeAmountCents, set by staff (quote / status routes in
//     routes/calendar.routes.js).
//  2. A payment is only trusted after a cryptographic check — the Checkout
//     signature on /verify, the webhook signature on the webhook — and the
//     comparison is constant-time.
//  3. The amount and currency Razorpay reports are compared against what
//     the order was created for. A mismatch is recorded and flagged to
//     staff, never silently marked "Paid".
//  4. Every order ever created for an item is remembered (paymentEvents),
//     not just the latest one. A client who opens Checkout twice and pays
//     the FIRST popup used to be charged with nothing recorded, because
//     the webhook only looked for the latest order id.
//  5. Webhooks are retried by Razorpay and may arrive before or after
//     /verify. Every handler is idempotent: the same payment is recorded
//     once, however many times it's reported.
//  6. "Authorized" is not "paid". If the Razorpay account isn't set to
//     auto-capture, an authorized payment is refunded automatically after
//     a few days — so /verify captures it explicitly before marking Paid.

const express = require("express");
const crypto = require("crypto");
const razorpay = require("../config/razorpay");
const Calendar = require("../models/Calendar");
const ClientOrg = require("../models/ClientOrg");
const { requireAuth, requireClientRole } = require("../middleware/auth");
const { hasAllRequiredDocuments, toView: toViewSync, missingKeysFor } = require("../lib/calendarView");
const toView = async (calendar) => toViewSync(calendar, { missingKeys: await missingKeysFor(calendar) });
const { formatUSD } = require("../lib/complianceFees");
const { logActivity } = require("../lib/auditLog");
const { notifyStaff, notifyClient } = require("../lib/notify");

// Prices are in USD; what's charged (USD, or INR at a set rate) comes
// from lib/paymentConfig.js.
const { paymentCurrency, chargeFor, formatCharge, explainRazorpayError } = require("../lib/paymentConfig");
const CURRENCY = paymentCurrency();

// When Razorpay refuses to create an order, the team hears about it once
// per reason per hour (bell + email) instead of finding out from a client.
const lastAlert = new Map();
function alertTeamOnce(key, fn) {
  const now = Date.now();
  if (now - (lastAlert.get(key) || 0) < 60 * 60 * 1000) return;
  lastAlert.set(key, now);
  fn();
}

function safeEqualHex(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
  } catch {
    return false;
  }
}

function hmacHex(secret, data) {
  return crypto.createHmac("sha256", secret).update(data).digest("hex");
}

// Every order id this item has ever had, with the amount it was created for.
function ordersForItem(item) {
  const orders = new Map();
  (item.paymentEvents || []).forEach((e) => {
    if ((e.event === "order_created" || e.event === "order_reused") && e.razorpayOrderId) {
      orders.set(e.razorpayOrderId, { amountCents: e.amountCents, currency: e.currency });
    }
  });
  if (item.razorpayOrderId && !orders.has(item.razorpayOrderId)) {
    let fallback = { amountCents: item.feeAmountCents, currency: CURRENCY };
    try { const c = chargeFor(item.feeAmountCents); fallback = { amountCents: c.amount, currency: c.currency }; } catch {}
    orders.set(item.razorpayOrderId, fallback);
  }
  return orders;
}

function alreadyRecorded(item, eventName, paymentId) {
  return (item.paymentEvents || []).some((e) => e.event === eventName && e.razorpayPaymentId === paymentId);
}

/**
 * Record a confirmed payment on an item. Returns "paid" | "duplicate" | "mismatch".
 * Does NOT save — caller saves the calendar.
 */
function applyCapturedPayment(item, { orderId, paymentId, amountCents, currency, source }) {
  if (item.paymentStatus === "Paid" && item.razorpayPaymentId === paymentId) return "duplicate";

  const expected = ordersForItem(item).get(orderId);
  const expectedAmount = expected?.amountCents ?? item.feeAmountCents;
  const expectedCurrency = (expected?.currency || CURRENCY).toUpperCase();
  const amountOk =
    typeof amountCents !== "number" || // amount unknown (Razorpay API unreachable) — rely on signature
    (amountCents === expectedAmount && (!currency || currency.toUpperCase() === expectedCurrency));

  if (!amountOk) {
    if (!alreadyRecorded(item, "amount_mismatch", paymentId)) {
      item.paymentEvents.push({ event: "amount_mismatch", razorpayOrderId: orderId, razorpayPaymentId: paymentId, amountCents, currency });
    }
    return "mismatch";
  }

  if (item.paymentStatus === "Paid" && item.razorpayPaymentId && item.razorpayPaymentId !== paymentId) {
    // A SECOND successful payment for the same item (e.g. two tabs). Money
    // was taken twice — record it so staff can refund, don't overwrite.
    if (!alreadyRecorded(item, "duplicate_payment", paymentId)) {
      item.paymentEvents.push({ event: "duplicate_payment", razorpayOrderId: orderId, razorpayPaymentId: paymentId, amountCents, currency });
    }
    return "mismatch";
  }

  item.paymentStatus = "Paid";
  item.razorpayPaymentId = paymentId;
  item.razorpayOrderId = orderId;
  item.paidAt = item.paidAt || new Date();
  if (!alreadyRecorded(item, source, paymentId)) {
    item.paymentEvents.push({ event: source, razorpayOrderId: orderId, razorpayPaymentId: paymentId, amountCents, currency });
  }
  return "paid";
}

// If the client regenerated their calendar after creating an order, the
// order lives on the OLD calendar. Mirror the payment onto the same
// filing in the calendar(s) that replaced it, so the portal shows Paid.
async function propagateToNewerCalendars(calendar, item) {
  let current = calendar;
  for (let hops = 0; hops < 10; hops++) {
    const newer = await Calendar.findOne({ supersedes: current._id });
    if (!newer) return;
    const match = newer.items.find(
      (it) => it.compliance_name.toLowerCase().trim() === item.compliance_name.toLowerCase().trim()
    );
    if (match && match.paymentStatus !== "Paid") {
      match.paymentStatus = "Paid";
      match.razorpayPaymentId = item.razorpayPaymentId;
      match.paidAt = item.paidAt;
      match.feeAmountCents = match.feeAmountCents || item.feeAmountCents;
      match.paymentEvents.push({ event: "paid_on_previous_calendar", razorpayOrderId: item.razorpayOrderId, razorpayPaymentId: item.razorpayPaymentId });
      await newer.save();
    }
    current = newer;
  }
}

async function announcePayment(calendar, item, outcome) {
  const org = await ClientOrg.findById(calendar.clientOrgId).select("name").lean().catch(() => null);
  const company = org?.name || calendar.profile?.companyName || "A client";
  if (outcome === "paid") {
    const amount = item.feeAmountCents ? formatUSD(item.feeAmountCents) : "";
    logActivity({
      action: "payment_captured",
      actor: null,
      clientOrgId: calendar.clientOrgId,
      calendarId: calendar._id,
      summary: `Payment captured for ${item.compliance_name}${amount ? ` (${amount})` : ""}.`,
      meta: { razorpayOrderId: item.razorpayOrderId, razorpayPaymentId: item.razorpayPaymentId },
    });
    notifyStaff({
      clientOrgId: calendar.clientOrgId,
      calendarId: calendar._id,
      type: "payment_received",
      title: `${company} paid ${amount} for ${item.compliance_name}`,
      body: `Razorpay payment ${item.razorpayPaymentId}. The filing can go ahead.`,
      link: `/calendar.html?id=${calendar._id}`,
    });
    notifyClient({
      clientOrgId: calendar.clientOrgId,
      calendarId: calendar._id,
      type: "payment_received",
      title: `Payment received: ${amount} for ${item.compliance_name}`,
      body: `Thank you — we've received your payment of ${amount} for ${item.compliance_name} (payment reference ${item.razorpayPaymentId}). We'll start on the filing and keep you posted.`,
      link: `/portal.html?calendar=${calendar._id}`,
    });
  } else if (outcome === "mismatch") {
    logActivity({
      action: "payment_amount_mismatch",
      actor: null,
      clientOrgId: calendar.clientOrgId,
      calendarId: calendar._id,
      summary: `A Razorpay payment for ${item.compliance_name} didn't match the invoiced amount, or was a second payment for an already-paid item. Check Razorpay and refund if needed.`,
      meta: { events: item.paymentEvents.slice(-3) },
    });
    notifyStaff({
      clientOrgId: calendar.clientOrgId,
      calendarId: calendar._id,
      type: "payment_failed",
      title: `Check payment for ${item.compliance_name} (${company})`,
      body: "Razorpay reported a payment that doesn't match the invoice, or a second payment for an item that was already paid. It has NOT been marked paid automatically. Check the Razorpay dashboard and refund if needed.",
      link: `/calendar.html?id=${calendar._id}`,
    });
  }
}

// ---------------------------------------------------------------------
// Client routes
// ---------------------------------------------------------------------

const router = express.Router();
router.use(requireAuth, requireClientRole);

function findOwnApprovedCalendar(req, calendarId) {
  return Calendar.findOne({ _id: calendarId, clientOrgId: req.user.clientOrgId, status: "approved" }).catch(() => null);
}

function getItemOr404(res, calendar, indexParam) {
  const idx = parseInt(indexParam, 10);
  if (isNaN(idx) || idx < 0 || idx >= calendar.items.length) {
    res.status(400).json({ error: "Invalid item index." });
    return null;
  }
  return { idx, item: calendar.items[idx] };
}

// POST /api/portal/payments/calendars/:id/items/:index/create-order
// No amount in the request body on purpose — see principle 1.
router.post("/calendars/:id/items/:index/create-order", async (req, res) => {
  try {
    const calendar = await findOwnApprovedCalendar(req, req.params.id);
    if (!calendar) return res.status(404).json({ error: "Not found." });
    if (calendar.supersededAt) return res.status(400).json({ error: "This is an older calendar. Pay from your current one." });
    const found = getItemOr404(res, calendar, req.params.index);
    if (!found) return;
    const { idx, item } = found;

    if (!item.feeAmountCents || item.feeAmountCents <= 0) {
      return res.status(400).json({ error: "We haven't sent a price for this service yet." });
    }
    if (item.paymentStatus === "Paid") return res.status(400).json({ error: "This service is already paid." });
    if (item.paymentStatus !== "Invoiced" && item.paymentStatus !== "Overdue") {
      return res.status(400).json({ error: "This service hasn't been invoiced yet." });
    }
    if (!hasAllRequiredDocuments(item, calendar, await missingKeysFor(calendar))) {
      return res.status(400).json({ error: "Please upload all required documents for this service before paying." });
    }
    const org = await ClientOrg.findById(req.user.clientOrgId).lean();
    if (!org?.primaryContactEmail || !org?.primaryContactPhone) {
      return res.status(409).json({ error: "Please add your email and phone number before paying.", code: "CONTACT_INCOMPLETE" });
    }

    const prefill = { name: org.primaryContactName || req.user.name || "", email: org.primaryContactEmail, contact: org.primaryContactPhone };
    const charge = chargeFor(item.feeAmountCents);
    const payload = (orderId, amount, currency) => ({
      orderId,
      amount,
      currency,
      displayAmount: formatCharge(amount, currency),
      // e.g. "$125 = ₹10,438 at ₹83.5 per $" so the client isn't surprised
      conversionNote: charge.rate ? `${formatCharge(item.feeAmountCents, "USD")} is charged as ${formatCharge(amount, currency)} (₹${charge.rate} per US$).` : "",
      keyId: process.env.RAZORPAY_KEY_ID, // public key — safe to send to the browser
      description: item.compliance_name,
      prefill,
    });

    // Reuse the open order if it's for the same amount, instead of
    // creating a new order on every click (principle 4 still covers the
    // case where a new one IS created).
    if (item.razorpayOrderId) {
      const known = ordersForItem(item).get(item.razorpayOrderId);
      if (known && known.amountCents === charge.amount && (known.currency || CURRENCY) === charge.currency) {
        try {
          const existing = await razorpay.orders.fetch(item.razorpayOrderId);
          if (existing.status === "paid") {
            // The payment went through but neither /verify nor the webhook
            // recorded it (closed tab + webhook not configured). Reconcile now.
            const payments = await razorpay.orders.fetchPayments(item.razorpayOrderId);
            const captured = (payments.items || []).find((p) => p.status === "captured");
            if (captured) {
              const outcome = applyCapturedPayment(item, {
                orderId: item.razorpayOrderId, paymentId: captured.id,
                amountCents: captured.amount, currency: captured.currency, source: "reconciled",
              });
              await calendar.save();
              announcePayment(calendar, item, outcome).catch(() => {});
              return res.status(409).json({ error: "This service is already paid.", calendar: await toView(calendar) });
            }
          } else if (existing.amount === charge.amount && existing.currency === charge.currency) {
            item.paymentEvents.push({ event: "order_reused", razorpayOrderId: existing.id, amountCents: existing.amount, currency: existing.currency });
            await calendar.save();
            return res.json(payload(existing.id, existing.amount, existing.currency));
          }
        } catch (err) {
          console.warn("[payments] could not re-check existing order, creating a new one:", err.message);
        }
      }
    }

    const order = await razorpay.orders.create({
      amount: charge.amount,
      currency: charge.currency,
      receipt: `cal_${calendar._id}_i${idx}_${Date.now().toString(36)}`.slice(0, 40), // Razorpay caps receipt at 40 chars
      notes: {
        calendarId: String(calendar._id),
        itemIndex: String(idx),
        complianceName: item.compliance_name.slice(0, 250),
        clientOrgId: String(calendar.clientOrgId),
        priceUsdCents: String(item.feeAmountCents),
        ...(charge.rate ? { usdToInrRate: String(charge.rate) } : {}),
      },
    });

    item.razorpayOrderId = order.id;
    item.paymentEvents.push({ event: "order_created", razorpayOrderId: order.id, amountCents: order.amount, currency: order.currency });
    await calendar.save();

    res.json(payload(order.id, order.amount, order.currency));
  } catch (err) {
    const why = explainRazorpayError(err);
    // One readable line in the logs, with Razorpay's own words.
    console.error(`[payments] create-order FAILED (${why.status || "-"} ${why.code}): ${why.description} | ${why.reason} | Fix: ${why.fix}`);
    alertTeamOnce(why.code + why.description, () => {
      notifyStaff({
        type: "payment_failed",
        title: "Online payments are failing",
        body: `A client tried to pay and Razorpay refused. ${why.reason}\n\nHow to fix: ${why.fix}\n\nRazorpay's message: ${why.description}`,
        link: "/admin.html",
      });
    });
    const temporary = why.reason.startsWith("The server couldn't reach Razorpay");
    res.status(temporary ? 503 : 500).json({
      error: temporary
        ? "The payment service didn't respond. Please try again in a minute."
        : "Online payment isn't available for this right now. Our team has been notified and will contact you shortly; you haven't been charged.",
      code: "PAYMENT_UNAVAILABLE",
    });
  }
});

// POST /api/portal/payments/calendars/:id/items/:index/verify
// Called by the browser right after Checkout succeeds. Fast path for the
// UI; the webhook confirms independently.
router.post("/calendars/:id/items/:index/verify", async (req, res) => {
  try {
    const calendar = await findOwnApprovedCalendar(req, req.params.id);
    if (!calendar) return res.status(404).json({ error: "Not found." });
    const found = getItemOr404(res, calendar, req.params.index);
    if (!found) return;
    const { item } = found;

    const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body || {};
    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
      return res.status(400).json({ error: "Missing Razorpay payment fields." });
    }
    if (!ordersForItem(item).has(razorpay_order_id)) {
      return res.status(400).json({ error: "This payment doesn't belong to this service." });
    }
    if (!process.env.RAZORPAY_KEY_SECRET) return res.status(500).json({ error: "Payments are not configured." });

    const expected = hmacHex(process.env.RAZORPAY_KEY_SECRET, `${razorpay_order_id}|${razorpay_payment_id}`);
    if (!safeEqualHex(expected, razorpay_signature)) {
      return res.status(400).json({ error: "Signature verification failed." });
    }

    // Ask Razorpay what actually happened (principles 3 and 6). If the API
    // is unreachable, the valid signature is still proof of payment and
    // the webhook will fill in the rest.
    let amountCents, currency, source = "verify_ok";
    try {
      let payment = await razorpay.payments.fetch(razorpay_payment_id);
      if (payment.order_id && payment.order_id !== razorpay_order_id) {
        return res.status(400).json({ error: "Payment and order don't match." });
      }
      if (payment.status === "authorized") {
        payment = await razorpay.payments.capture(razorpay_payment_id, payment.amount, payment.currency);
        source = "verify_captured";
      }
      if (payment.status !== "captured") {
        item.paymentEvents.push({ event: "verify_not_captured", razorpayOrderId: razorpay_order_id, razorpayPaymentId: razorpay_payment_id });
        await calendar.save();
        return res.status(202).json({ pending: true, message: "Your payment is being processed. We'll confirm it here and by email shortly.", calendar: await toView(calendar) });
      }
      amountCents = payment.amount;
      currency = payment.currency;
    } catch (err) {
      console.warn("[payments] could not fetch payment from Razorpay (relying on signature):", err.message);
    }

    const outcome = applyCapturedPayment(item, {
      orderId: razorpay_order_id, paymentId: razorpay_payment_id, amountCents, currency, source,
    });
    await calendar.save();
    if (outcome !== "duplicate") {
      announcePayment(calendar, item, outcome).catch(() => {});
      if (outcome === "paid") propagateToNewerCalendars(calendar, item).catch(() => {});
    }
    if (outcome === "mismatch") {
      return res.status(409).json({ error: "We received your payment but it needs a quick check by our team. We'll be in touch — no need to pay again.", calendar: await toView(calendar) });
    }
    res.json({ ok: true, calendar: await toView(calendar) });
  } catch (err) {
    console.error("[payments] verify error:", err);
    res.status(500).json({ error: "We couldn't confirm the payment yet. If you were charged, don't pay again — we'll confirm it shortly." });
  }
});

module.exports = router;

// ---------------------------------------------------------------------
// Webhook — no session, raw body. See server.js.
// Configure in Razorpay Dashboard → Webhooks: URL <APP_URL>/api/webhooks/razorpay,
// events payment.captured, payment.failed, order.paid.
// ---------------------------------------------------------------------
async function findCalendarAndItemForOrder(orderId) {
  const calendar = await Calendar.findOne({
    $or: [{ "items.razorpayOrderId": orderId }, { "items.paymentEvents.razorpayOrderId": orderId }],
  });
  if (!calendar) return {};
  const item =
    calendar.items.find((it) => it.razorpayOrderId === orderId) ||
    calendar.items.find((it) => (it.paymentEvents || []).some((e) => e.razorpayOrderId === orderId));
  return { calendar, item };
}

async function razorpayWebhookHandler(req, res) {
  try {
    if (!process.env.RAZORPAY_WEBHOOK_SECRET) {
      console.error("[razorpay webhook] RAZORPAY_WEBHOOK_SECRET not set — rejecting.");
      return res.status(500).json({ error: "Webhook not configured." });
    }
    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from(typeof req.body === "string" ? req.body : "");
    const expected = hmacHex(process.env.RAZORPAY_WEBHOOK_SECRET, raw);
    if (!safeEqualHex(expected, req.headers["x-razorpay-signature"])) {
      console.warn("[razorpay webhook] signature mismatch — possible spoofed request.");
      return res.status(400).json({ error: "Invalid signature." });
    }

    let event;
    try {
      event = JSON.parse(raw.toString("utf8"));
    } catch {
      return res.status(400).json({ error: "Invalid JSON." });
    }

    const payment = event?.payload?.payment?.entity;
    const handled = ["payment.captured", "payment.failed", "order.paid"];
    if (!handled.includes(event.event) || !payment?.order_id) {
      return res.status(200).json({ received: true });
    }

    const orderId = payment.order_id;
    const { calendar, item } = await findCalendarAndItemForOrder(orderId);
    if (!calendar || !item) {
      console.warn(`[razorpay webhook] no calendar item found for order ${orderId}`);
      return res.status(200).json({ received: true }); // ack — Razorpay retries on non-2xx
    }

    if (event.event === "payment.failed") {
      if (!alreadyRecorded(item, "webhook_failed", payment.id)) {
        item.paymentEvents.push({ event: "webhook_failed", razorpayOrderId: orderId, razorpayPaymentId: payment.id, amountCents: payment.amount, currency: payment.currency });
        await calendar.save();
        logActivity({
          action: "payment_failed",
          actor: null,
          clientOrgId: calendar.clientOrgId,
          calendarId: calendar._id,
          summary: `Payment attempt failed for ${item.compliance_name}${payment.error_description ? `: ${payment.error_description}` : ""}.`,
          meta: { razorpayOrderId: orderId, razorpayPaymentId: payment.id },
        });
      }
      return res.status(200).json({ received: true });
    }

    // payment.captured / order.paid
    if (payment.status && payment.status !== "captured") return res.status(200).json({ received: true });
    const outcome = applyCapturedPayment(item, {
      orderId, paymentId: payment.id, amountCents: payment.amount, currency: payment.currency, source: "webhook_captured",
    });
    if (outcome !== "duplicate") {
      await calendar.save();
      await announcePayment(calendar, item, outcome).catch(() => {});
      if (outcome === "paid") await propagateToNewerCalendars(calendar, item).catch(() => {});
    }
    res.status(200).json({ received: true });
  } catch (err) {
    console.error("[razorpay webhook] error:", err);
    res.status(500).json({ error: "Webhook processing failed." });
  }
}
module.exports.razorpayWebhookHandler = razorpayWebhookHandler;
module.exports._internals = { applyCapturedPayment, ordersForItem, safeEqualHex, hmacHex };
