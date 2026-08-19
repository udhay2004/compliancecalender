// routes/payments.js
//
// ADJUST: assumes middleware/auth.js exports `requireAuth` (req.user = { id, role, companyId })
// and that you have a ComplianceTask model at models/ComplianceTask.js with a `company` field
// and a `status` field. Change the two require() paths below if your names differ.
const { requireAuth } = require('../middleware/auth');
const ComplianceTask = require('../models/ComplianceTask');

const express = require('express');
const crypto = require('crypto');
const razorpay = require('../config/razorpay');
const Payment = require('../models/Payment');

const router = express.Router();

/**
 * POST /api/payments/create-order
 * body: { complianceTaskId, amountRupees }
 */
router.post('/create-order', requireAuth, async (req, res) => {
  try {
    const { complianceTaskId, amountRupees } = req.body;
    if (!complianceTaskId || !amountRupees) {
      return res.status(400).json({ error: 'complianceTaskId and amountRupees are required' });
    }

    const task = await ComplianceTask.findById(complianceTaskId);
    if (!task) return res.status(404).json({ error: 'Compliance task not found' });

    if (req.user.role === 'client' && String(req.user.companyId) !== String(task.company)) {
      return res.status(403).json({ error: 'Not authorized' });
    }

    // Once your service pricing is finalized, recompute amountPaise from a server-side
    // price table keyed by service type instead of trusting amountRupees from the client.
    const amountPaise = Math.round(amountRupees * 100);

    const order = await razorpay.orders.create({
      amount: amountPaise,
      currency: 'INR',
      receipt: `task_${task._id}_${Date.now()}`,
      notes: { complianceTaskId: String(task._id), companyId: String(task.company) },
    });

    await Payment.create({
      company: task.company,
      complianceTask: task._id,
      createdBy: req.user.id,
      razorpayOrderId: order.id,
      amountPaise,
      status: 'created',
    });

    res.json({
      orderId: order.id,
      amount: order.amount,
      currency: order.currency,
      keyId: process.env.RAZORPAY_KEY_ID, // public key — safe to send to the frontend
    });
  } catch (err) {
    console.error('[payments] create-order error:', err);
    res.status(500).json({ error: 'Could not create payment order' });
  }
});

/**
 * POST /api/payments/verify
 * Called by the frontend right after Razorpay Checkout succeeds.
 * This is a FAST-PATH UX update only. The webhook below is the real source of truth —
 * this endpoint trusts data that passed through the browser, which is fine for updating
 * the UI quickly but should never be the only thing that marks a payment as paid.
 */
router.post('/verify', requireAuth, async (req, res) => {
  try {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;

    const expectedSignature = crypto
      .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
      .update(`${razorpay_order_id}|${razorpay_payment_id}`)
      .digest('hex');

    if (expectedSignature !== razorpay_signature) {
      return res.status(400).json({ error: 'Signature verification failed' });
    }

    const payment = await Payment.findOne({ razorpayOrderId: razorpay_order_id });
    if (!payment) return res.status(404).json({ error: 'Payment record not found' });

    payment.razorpayPaymentId = razorpay_payment_id;
    payment.razorpaySignature = razorpay_signature;
    payment.status = 'processing'; // webhook flips this to 'paid'
    await payment.save();

    res.json({ ok: true, status: payment.status });
  } catch (err) {
    console.error('[payments] verify error:', err);
    res.status(500).json({ error: 'Verification failed' });
  }
});

/**
 * POST /api/webhooks/razorpay
 * THE SOURCE OF TRUTH for payment status.
 *
 * IMPORTANT: this route must receive the RAW request body, not JSON-parsed, because the
 * signature is computed over the exact raw bytes Razorpay sent. See SETUP_NOTES.md for
 * how to mount this in server.js — it needs express.raw() applied only to this path,
 * before your global express.json() middleware.
 *
 * Configure the webhook URL in Razorpay Dashboard → Settings → Webhooks, and set
 * RAZORPAY_WEBHOOK_SECRET to the secret shown there (different from your API key secret).
 */
router.post('/webhook', async (req, res) => {
  try {
    const signature = req.headers['x-razorpay-signature'];
    const expectedSignature = crypto
      .createHmac('sha256', process.env.RAZORPAY_WEBHOOK_SECRET)
      .update(req.body) // must be the raw Buffer — see server.js wiring note above
      .digest('hex');

    if (signature !== expectedSignature) {
      console.warn('[razorpay webhook] signature mismatch — possible spoofed request');
      return res.status(400).json({ error: 'Invalid signature' });
    }

    const event = JSON.parse(req.body.toString());

    if (event.event === 'payment.captured') {
      const orderId = event.payload.payment.entity.order_id;
      const paymentId = event.payload.payment.entity.id;

      const payment = await Payment.findOneAndUpdate(
        { razorpayOrderId: orderId },
        { status: 'paid', razorpayPaymentId: paymentId },
        { new: true }
      );

      if (payment) {
        await ComplianceTask.findByIdAndUpdate(payment.complianceTask, {
          status: 'payment_received', // adjust to match your ComplianceTask status enum
        });
        // TODO: push this into the employee queue / send a confirmation email here.
      }
    }

    if (event.event === 'payment.failed') {
      const orderId = event.payload.payment.entity.order_id;
      await Payment.findOneAndUpdate({ razorpayOrderId: orderId }, { status: 'failed' });
    }

    res.status(200).json({ received: true });
  } catch (err) {
    console.error('[razorpay webhook] error:', err);
    res.status(500).json({ error: 'Webhook processing failed' });
  }
});

// ---------------------------------------------------------------------------
// Manual bank transfer fallback — for clients who prefer NEFT/RTGS over Checkout.
// ---------------------------------------------------------------------------

/**
 * POST /api/payments/bank-transfer
 * Client records that they've initiated a manual transfer.
 */
router.post('/bank-transfer', requireAuth, async (req, res) => {
  try {
    const { complianceTaskId, amountRupees, notes } = req.body;
    const task = await ComplianceTask.findById(complianceTaskId);
    if (!task) return res.status(404).json({ error: 'Compliance task not found' });

    if (req.user.role === 'client' && String(req.user.companyId) !== String(task.company)) {
      return res.status(403).json({ error: 'Not authorized' });
    }

    const payment = await Payment.create({
      company: task.company,
      complianceTask: task._id,
      createdBy: req.user.id,
      razorpayOrderId: `manual_${task._id}_${Date.now()}`, // placeholder, not a real Razorpay order
      amountPaise: Math.round(amountRupees * 100),
      method: 'bank_transfer',
      status: 'awaiting_verification',
      notes,
    });

    res.json({ ok: true, payment });
  } catch (err) {
    console.error('[payments] bank-transfer error:', err);
    res.status(500).json({ error: 'Could not record bank transfer' });
  }
});

/**
 * POST /api/payments/:id/verify-manual
 * Employee/admin confirms a manual bank transfer after checking the bank statement.
 */
router.post('/:id/verify-manual', requireAuth, async (req, res) => {
  try {
    if (!['staff', 'admin', 'super_admin'].includes(req.user.role)) {
      return res.status(403).json({ error: 'Not authorized' });
    }

    const payment = await Payment.findByIdAndUpdate(
      req.params.id,
      { status: 'paid', verifiedBy: req.user.id },
      { new: true }
    );
    if (!payment) return res.status(404).json({ error: 'Payment not found' });

    await ComplianceTask.findByIdAndUpdate(payment.complianceTask, { status: 'payment_received' });

    res.json({ ok: true, payment });
  } catch (err) {
    console.error('[payments] verify-manual error:', err);
    res.status(500).json({ error: 'Could not verify payment' });
  }
});

module.exports = router;
