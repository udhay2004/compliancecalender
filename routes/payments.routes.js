// routes/payments.routes.js
//
// Client-facing payment routes for a single Calendar item, mounted at
// /api/portal/payments (see server.js). Deliberately separate from
// portal.routes.js so the Razorpay-specific code (signature verification,
// order creation) doesn't get lost in the upload/download logic — but it
// shares the exact same ownership pattern: every route re-derives the
// calendar via findOwnApprovedCalendar-equivalent logic below, never
// trusts a calendarId alone.
//
// THE SOURCE OF TRUTH FOR "IS THIS PAID" IS THE WEBHOOK ROUTE, mounted
// separately in server.js (see the block below and the comment there
// about raw-body parsing). /verify in this file is a fast-path UX
// update only, exactly as the amount was in the original orphaned
// payments.js — that reasoning was correct, it was just pointed at the
// wrong model.

const express = require("express");
const crypto = require("crypto");
const razorpay = require("../config/razorpay");
const Calendar = require("../models/Calendar");
const { requireAuth, requireClientRole } = require("../middleware/auth");

const router = express.Router();
router.use(requireAuth, requireClientRole);

async function findOwnApprovedCalendar(req, calendarId) {
  return Calendar.findOne({
    _id: calendarId,
    clientOrgId: req.user.clientOrgId,
    status: "approved",
  });
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
// No amount in the request body on purpose — the amount charged is
// ALWAYS item.feeAmountPaise, set by staff via
// PATCH /api/calendars/:id/items/:index/status. A client sending their
// own amount here would let them pay whatever they want for a filing.
router.post("/calendars/:id/items/:index/create-order", async (req, res) => {
  try {
    const calendar = await findOwnApprovedCalendar(req, req.params.id);
    if (!calendar) return res.status(404).json({ error: "Not found." });
    const found = getItemOr404(res, calendar, req.params.index);
    if (!found) return;
    const { idx, item } = found;

    if (!item.feeAmountPaise || item.feeAmountPaise <= 0) {
      return res.status(400).json({ error: "This item hasn't been invoiced yet." });
    }
    if (item.paymentStatus === "Paid") {
      return res.status(400).json({ error: "This item is already paid." });
    }

    const order = await razorpay.orders.create({
      amount: item.feeAmountPaise,
      currency: "INR",
      receipt: `cal_${calendar._id}_item_${idx}_${Date.now()}`.slice(0, 40), // Razorpay caps receipt at 40 chars
      notes: {
        calendarId: String(calendar._id),
        itemIndex: String(idx),
        complianceName: item.compliance_name,
      },
    });

    item.razorpayOrderId = order.id;
    item.paymentEvents.push({ event: "order_created", razorpayOrderId: order.id });
    await calendar.save();

    res.json({
      orderId: order.id,
      amount: order.amount,
      currency: order.currency,
      keyId: process.env.RAZORPAY_KEY_ID, // public key — safe to send to the frontend
    });
  } catch (err) {
    console.error("[payments] create-order error:", err);
    res.status(500).json({ error: "Could not create payment order." });
  }
});

// POST /api/portal/payments/calendars/:id/items/:index/verify
// Called by the frontend immediately after Razorpay Checkout succeeds.
// Flips paymentStatus to "Paid" right away for a responsive UI — the
// webhook (server.js) re-confirms this independently and is what you'd
// trust in a dispute, but making the client wait for a webhook rounp-trip
// before unlocking uploads would be a noticeably worse experience for the
// common case where nothing goes wrong.
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
    if (item.razorpayOrderId !== razorpay_order_id) {
      return res.status(400).json({ error: "Order ID does not match this item's current payment attempt." });
    }

    const expectedSignature = crypto
      .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
      .update(`${razorpay_order_id}|${razorpay_payment_id}`)
      .digest("hex");

    if (expectedSignature !== razorpay_signature) {
      return res.status(400).json({ error: "Signature verification failed." });
    }

    item.razorpayPaymentId = razorpay_payment_id;
    item.paymentStatus = "Paid";
    item.paidAt = new Date();
    item.paymentEvents.push({ event: "verify_ok", razorpayOrderId: razorpay_order_id, razorpayPaymentId: razorpay_payment_id });
    await calendar.save();

    res.json({ ok: true, calendar });
  } catch (err) {
    console.error("[payments] verify error:", err);
    res.status(500).json({ error: "Verification failed." });
  }
});

module.exports = router;

// ---------------------------------------------------------------------
// Webhook handler — exported separately (not on `router`, and not
// behind requireAuth/requireClientRole above) because Razorpay calls
// this directly with no session cookie, and it needs the RAW request
// body for signature verification. See server.js for how this is
// mounted — it MUST be registered before the global express.json()
// middleware, on its own path, with express.raw() applied only there.
// ---------------------------------------------------------------------
async function razorpayWebhookHandler(req, res) {
  try {
    const signature = req.headers["x-razorpay-signature"];
    if (!process.env.RAZORPAY_WEBHOOK_SECRET) {
      console.error("[razorpay webhook] RAZORPAY_WEBHOOK_SECRET not set — rejecting.");
      return res.status(500).json({ error: "Webhook not configured." });
    }
    const expectedSignature = crypto
      .createHmac("sha256", process.env.RAZORPAY_WEBHOOK_SECRET)
      .update(req.body) // must be the raw Buffer, not parsed JSON
      .digest("hex");

    if (signature !== expectedSignature) {
      console.warn("[razorpay webhook] signature mismatch — possible spoofed request.");
      return res.status(400).json({ error: "Invalid signature." });
    }

    const event = JSON.parse(req.body.toString());

    if (event.event === "payment.captured" || event.event === "payment.failed") {
      const orderId = event.payload.payment.entity.order_id;
      const paymentId = event.payload.payment.entity.id;

      // Razorpay orders are tagged with calendarId/itemIndex in `notes`
      // at creation time (see create-order above) — cheaper and more
      // reliable than a separate lookup collection for a single field
      // read.
      const calendar = await Calendar.findOne({ "items.razorpayOrderId": orderId });
      if (!calendar) {
        console.warn(`[razorpay webhook] no calendar found for order ${orderId}`);
        return res.status(200).json({ received: true }); // ack anyway — Razorpay retries on non-2xx
      }
      const item = calendar.items.find((it) => it.razorpayOrderId === orderId);
      if (!item) return res.status(200).json({ received: true });

      if (event.event === "payment.captured") {
        item.paymentStatus = "Paid";
        item.razorpayPaymentId = paymentId;
        item.paidAt = item.paidAt || new Date();
        item.paymentEvents.push({ event: "webhook_captured", razorpayOrderId: orderId, razorpayPaymentId: paymentId });
      } else {
        item.paymentEvents.push({ event: "webhook_failed", razorpayOrderId: orderId, razorpayPaymentId: paymentId });
      }
      await calendar.save();
    }

    res.status(200).json({ received: true });
  } catch (err) {
    console.error("[razorpay webhook] error:", err);
    res.status(500).json({ error: "Webhook processing failed." });
  }
}
module.exports.razorpayWebhookHandler = razorpayWebhookHandler;
