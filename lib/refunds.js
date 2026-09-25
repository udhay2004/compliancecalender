// lib/refunds.js
//
// Refunds through Razorpay, from the staff calendar page (finance / admin).
//
//   createRefund()      full or partial refund of a payment on a service,
//                       with a reason. Money goes back to the original
//                       payment method. Issues a credit note against the
//                       invoice and tells the client.
//   applyRefundEvent()  Razorpay webhook refund.created / refund.processed /
//                       refund.failed: keeps the status current, and records
//                       refunds someone made directly in the Razorpay
//                       dashboard so the app never disagrees with Razorpay.
//
// Amounts are in the smallest unit of the currency actually charged (cents
// for USD, paise for INR) — what Razorpay works in.

const razorpay = require("../config/razorpay");
const { paymentAmount, ensureInvoiceForPayment, issueCreditNote, money } = require("./invoices");

const inFlight = new Set(); // one refund per payment at a time (double clicks)

/** Can this person issue refunds? Finance team and admins. */
function canRefund(user) {
  return Boolean(user) && (user.role === "admin" || user.role === "super_admin" || (user.role === "staff" && user.department === "finance"));
}

/** All payment ids that took money for this item: the main one + duplicates. */
function paymentsOn(item) {
  const ids = [];
  if (item.razorpayPaymentId) ids.push(item.razorpayPaymentId);
  (item.paymentEvents || []).forEach((e) => {
    if (e.event === "duplicate_payment" && e.razorpayPaymentId && !ids.includes(e.razorpayPaymentId)) ids.push(e.razorpayPaymentId);
  });
  return ids;
}

function refundedSoFar(item, paymentId) {
  return (item.refunds || [])
    .filter((r) => r.razorpayPaymentId === paymentId && r.status !== "failed")
    .reduce((n, r) => n + (r.amountMinor || 0), 0);
}

/** { paid, refunded, remaining, currency } for one payment on an item. */
function refundable(item, paymentId) {
  const { amountMinor, currency } = paymentAmount(item, paymentId);
  const refunded = refundedSoFar(item, paymentId);
  return { paid: amountMinor, refunded, remaining: Math.max(0, amountMinor - refunded), currency };
}

/** Paid / Partially Refunded / Refunded, from the main payment's refunds. */
function recomputeStatus(item) {
  if (!item.razorpayPaymentId || !["Paid", "Partially Refunded", "Refunded"].includes(item.paymentStatus)) return;
  const r = refundable(item, item.razorpayPaymentId);
  item.paymentStatus = r.refunded <= 0 ? "Paid" : r.remaining <= 0 ? "Refunded" : "Partially Refunded";
}

class RefundError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

/**
 * @param {object} p
 * @param {object} p.calendar   Mongoose Calendar document (saved here)
 * @param {number} p.itemIndex
 * @param {number|null} p.amountMinor  null = everything still refundable
 * @param {string} p.reason     shown to the client and on the credit note
 * @param {string} [p.paymentId]  a specific payment (duplicate); default: the main one
 * @param {object} p.actor      the staff user
 * @returns {{ refund, creditNote }}
 */
async function createRefund({ calendar, itemIndex, amountMinor = null, reason, paymentId, actor, org }) {
  const item = calendar.items[itemIndex];
  if (!item) throw new RefundError("Service not found.", 404);
  if (!canRefund(actor)) throw new RefundError("Only the finance team or an admin can issue refunds.", 403);
  const payments = paymentsOn(item);
  const pid = paymentId || item.razorpayPaymentId;
  if (!pid || !payments.includes(pid)) throw new RefundError("There's no payment on this service to refund.");
  const why = String(reason || "").trim();
  if (why.length < 3) throw new RefundError("Give a short reason; the client sees it on the credit note.");

  const { remaining, currency, paid } = refundable(item, pid);
  if (remaining <= 0) throw new RefundError("This payment has already been refunded in full.");
  const amount = amountMinor === null || amountMinor === undefined ? remaining : Math.round(Number(amountMinor));
  if (!Number.isFinite(amount) || amount <= 0) throw new RefundError("Enter an amount greater than zero.");
  if (amount > remaining) throw new RefundError(`You can refund at most ${money(remaining, currency)} (paid ${money(paid, currency)}, already refunded ${money(paid - remaining, currency)}).`);

  if (inFlight.has(pid)) throw new RefundError("A refund for this payment is already being processed.", 409);
  inFlight.add(pid);
  try {
    let rz;
    try {
      rz = await razorpay.payments.refund(pid, {
        amount,
        speed: "normal",
        notes: { reason: why.slice(0, 250), calendarId: String(calendar._id), itemIndex: String(itemIndex), by: actor.email },
      });
    } catch (err) {
      const desc = err?.error?.description || err?.message || "Razorpay refused the refund.";
      throw new RefundError(`Razorpay couldn't process the refund: ${desc}`, 502);
    }

    item.refunds.push({
      razorpayRefundId: rz.id, razorpayPaymentId: pid, amountMinor: rz.amount ?? amount, currency: (rz.currency || currency).toUpperCase(),
      reason: why, status: rz.status || "pending", by: actor.email, at: new Date(), processedAt: rz.status === "processed" ? new Date() : null,
    });
    const isMain = pid === item.razorpayPaymentId;
    if (isMain) recomputeStatus(item);
    item.paymentEvents.push({ event: "refund_created", razorpayPaymentId: pid, amountCents: rz.amount ?? amount, currency });

    // Credit note against the invoice (duplicate payments have no invoice).
    let creditNote = null;
    if (isMain) {
      const invoice = await ensureInvoiceForPayment({ calendar, item, itemIndex, org });
      if (invoice) {
        creditNote = await issueCreditNote({ invoice, refund: { id: rz.id, amount: rz.amount ?? amount }, reason: why, by: actor.email });
        item.refunds[item.refunds.length - 1].creditNoteNumber = creditNote.number;
      }
    }
    await calendar.save();
    return { refund: item.refunds[item.refunds.length - 1], creditNote, amount, currency };
  } finally {
    inFlight.delete(pid);
  }
}

/**
 * Razorpay webhook: refund.created / refund.processed / refund.failed.
 * Returns { calendar, item, refund, changed, created } or null if unknown.
 */
async function applyRefundEvent(Calendar, entity, eventName) {
  if (!entity || !entity.id || !entity.payment_id) return null;
  const calendar = await Calendar.findOne({
    $or: [{ "items.refunds.razorpayRefundId": entity.id }, { "items.razorpayPaymentId": entity.payment_id }, { "items.paymentEvents.razorpayPaymentId": entity.payment_id }],
  });
  if (!calendar) return null;
  let idx = calendar.items.findIndex((it) => (it.refunds || []).some((r) => r.razorpayRefundId === entity.id));
  let created = false;
  if (idx === -1) {
    // Made directly in the Razorpay dashboard: record it.
    idx = calendar.items.findIndex((it) => paymentsOn(it).includes(entity.payment_id));
    if (idx === -1) return null;
    calendar.items[idx].refunds.push({
      razorpayRefundId: entity.id, razorpayPaymentId: entity.payment_id, amountMinor: entity.amount,
      currency: (entity.currency || "USD").toUpperCase(), reason: entity.notes?.reason || "Refunded from the Razorpay dashboard",
      status: entity.status || "pending", by: "razorpay-dashboard", at: new Date((entity.created_at || Date.now() / 1000) * 1000),
    });
    created = true;
  }
  const item = calendar.items[idx];
  const refund = item.refunds.find((r) => r.razorpayRefundId === entity.id);
  const newStatus = eventName === "refund.failed" ? "failed" : eventName === "refund.processed" ? "processed" : (entity.status || refund.status);
  const changed = created || refund.status !== newStatus;
  refund.status = newStatus;
  if (newStatus === "processed" && !refund.processedAt) refund.processedAt = new Date();
  if (entity.payment_id === item.razorpayPaymentId) recomputeStatus(item);
  return { calendar, item, itemIndex: idx, refund, changed, created };
}

module.exports = { createRefund, applyRefundEvent, canRefund, refundable, paymentsOn, recomputeStatus, RefundError };
