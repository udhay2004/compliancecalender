// routes/invoices.routes.js
//
// Staff side of invoices, credit notes and refunds (mounted at /api/invoices
// and used by calendar.html / dashboard.html). The client side lives in
// routes/portal.routes.js (/api/portal/invoices…), always scoped to the
// client's own company.

const express = require("express");
const mongoose = require("mongoose");
const Invoice = require("../models/Invoice");
const Calendar = require("../models/Calendar");
const ClientOrg = require("../models/ClientOrg");
const { requireAuth, requireRole } = require("../middleware/auth");
const { renderPdf, money } = require("../lib/invoices");
const refunds = require("../lib/refunds");
const { logActivity } = require("../lib/auditLog");
const { notifyClient } = require("../lib/notify");

const router = express.Router();
router.use(requireAuth, requireRole("staff"));

function summary(inv) {
  return {
    id: String(inv._id), kind: inv.kind, number: inv.number, issuedAt: inv.issuedAt, status: inv.status,
    amount: money(inv.amountMinor, inv.currency), amountMinor: inv.amountMinor, currency: inv.currency,
    refunded: inv.refundedMinor ? money(inv.refundedMinor, inv.currency) : "",
    description: inv.description, customer: inv.customer?.name || "", invoiceNumber: inv.invoiceNumber || "",
    calendarId: inv.calendarId ? String(inv.calendarId) : null, itemIndex: inv.itemIndex, reason: inv.reason || "",
    pdf: `/api/invoices/${inv._id}/pdf`,
  };
}

async function sendPdf(res, inv) {
  const buf = await renderPdf(inv);
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `inline; filename="${inv.number.replace(/\//g, "-")}.pdf"`);
  res.setHeader("Cache-Control", "private, no-store");
  res.send(buf);
}

// GET /api/invoices?limit=50&clientOrgId=…
router.get("/", async (req, res) => {
  const q = {};
  if (req.query.clientOrgId && mongoose.isValidObjectId(req.query.clientOrgId)) q.clientOrgId = req.query.clientOrgId;
  if (req.query.kind === "invoice" || req.query.kind === "credit_note") q.kind = req.query.kind;
  const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
  const rows = await Invoice.find(q).sort({ issuedAt: -1 }).limit(limit);
  res.json({ invoices: rows.map(summary) });
});

// GET /api/invoices/:id/pdf
router.get("/:id/pdf", async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: "Invalid id." });
  const inv = await Invoice.findById(req.params.id);
  if (!inv) return res.status(404).json({ error: "Not found." });
  await sendPdf(res, inv);
});

// GET /api/invoices/calendar/:calendarId — billing per service on one calendar.
router.get("/calendar/:calendarId", async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.calendarId)) return res.status(400).json({ error: "Invalid id." });
  const calendar = await Calendar.findById(req.params.calendarId);
  if (!calendar) return res.status(404).json({ error: "Not found." });
  const docs = await Invoice.find({ calendarId: calendar._id }).sort({ issuedAt: 1 });
  const items = {};
  calendar.items.forEach((it, idx) => {
    const pays = refunds.paymentsOn(it);
    if (!pays.length && !(it.refunds || []).length) return;
    items[idx] = {
      payments: pays.map((pid) => {
        const r = refunds.refundable(it, pid);
        return { paymentId: pid, main: pid === it.razorpayPaymentId, paid: money(r.paid, r.currency), refunded: money(r.refunded, r.currency),
          remaining: money(r.remaining, r.currency), remainingMinor: r.remaining, currency: r.currency };
      }),
      refunds: (it.refunds || []).map((r) => ({ ...r.toObject?.() ?? r, amount: money(r.amountMinor, r.currency) })),
      documents: docs.filter((d) => d.itemIndex === idx).map(summary),
    };
  });
  res.json({ items, canRefund: refunds.canRefund(req.user) });
});

// POST /api/invoices/calendar/:calendarId/items/:index/refund
//   { amount?: "25.00" (in the charged currency; omit = everything left), reason, paymentId? }
router.post("/calendar/:calendarId/items/:index/refund", async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.calendarId)) return res.status(400).json({ error: "Invalid id." });
  const calendar = await Calendar.findById(req.params.calendarId);
  if (!calendar) return res.status(404).json({ error: "Not found." });
  const idx = parseInt(req.params.index, 10);
  const raw = req.body?.amount;
  let amountMinor = null;
  if (raw !== undefined && raw !== null && String(raw).trim() !== "") {
    const n = Number(String(raw).replace(/[, ]/g, ""));
    if (!Number.isFinite(n) || n <= 0) return res.status(400).json({ error: "Enter a valid amount." });
    amountMinor = Math.round(n * 100);
  }
  const org = await ClientOrg.findById(calendar.clientOrgId).lean().catch(() => null);
  try {
    const { refund, creditNote, amount, currency } = await refunds.createRefund({
      calendar, itemIndex: idx, amountMinor, reason: req.body?.reason, paymentId: req.body?.paymentId, actor: req.user, org,
    });
    const item = calendar.items[idx];
    const pretty = money(amount, currency);
    logActivity({
      action: "refund_created", actor: req.user, clientOrgId: calendar.clientOrgId, calendarId: calendar._id, itemIndex: idx,
      summary: `Refunded ${pretty} for ${item.compliance_name}: ${refund.reason}${creditNote ? ` (credit note ${creditNote.number})` : ""}.`,
      meta: { razorpayRefundId: refund.razorpayRefundId, paymentId: refund.razorpayPaymentId },
    });
    notifyClient({
      clientOrgId: calendar.clientOrgId, calendarId: calendar._id, itemIndex: idx, type: "payment_received",
      title: `Refund of ${pretty} for ${item.compliance_name}`,
      body: `We've refunded ${pretty} for ${item.compliance_name} to your original payment method.\n\nReason: ${refund.reason}\n\n` +
        `Refunds usually reach your account within 5 to 7 business days, depending on your bank.` +
        (creditNote ? `\n\nCredit note ${creditNote.number}: ${process.env.APP_URL || ""}/api/portal/invoices/${creditNote._id}/pdf` : ""),
      link: `/portal.html?calendar=${calendar._id}`,
    });
    res.status(201).json({ ok: true, refund, creditNote: creditNote ? summary(creditNote) : null, paymentStatus: item.paymentStatus });
  } catch (err) {
    if (err instanceof refunds.RefundError) return res.status(err.status).json({ error: err.message });
    throw err;
  }
});

module.exports = router;
module.exports.summary = summary;
module.exports.sendPdf = sendPdf;
