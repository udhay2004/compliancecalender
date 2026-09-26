// models/Invoice.js — issued invoices and credit notes.
//
// Every paid service gets exactly one INVOICE (kind "invoice"), numbered in
// an unbroken sequence per Indian financial year (April–March), e.g.
// INV/2026-27/0001. Every refund gets a CREDIT NOTE (kind "credit_note",
// CN/2026-27/0001) pointing at the invoice it reduces.
//
// Both are SNAPSHOTS: the supplier and customer details, service name and
// amounts are copied in at issue time, so an invoice never changes later
// when a price, a company name or an address is edited.

const mongoose = require("mongoose");

const partySchema = new mongoose.Schema(
  {
    name: String,
    lines: [String], // address / contact lines, printed as given
    gstin: String,
    email: String,
    phone: String,
    country: String,
  },
  { _id: false }
);

const invoiceSchema = new mongoose.Schema(
  {
    kind: { type: String, enum: ["invoice", "credit_note"], required: true, index: true },
    number: { type: String, required: true, unique: true },
    fy: { type: String, required: true },
    seq: { type: Number, required: true },
    issuedAt: { type: Date, required: true },

    clientOrgId: { type: mongoose.Schema.Types.ObjectId, ref: "ClientOrg", index: true },
    calendarId: { type: mongoose.Schema.Types.ObjectId, ref: "Calendar" },
    itemIndex: Number,

    description: String,   // service name
    period: String,        // "Due 1 Mar 2027"
    sac: String,           // services accounting code, if configured

    // Amounts in the smallest unit of the currency actually charged
    // (cents for USD, paise for INR), plus the USD list price.
    amountMinor: { type: Number, required: true },
    currency: { type: String, required: true },
    usdPriceCents: Number,
    taxNote: String,       // e.g. export under LUT wording

    razorpayPaymentId: { type: String, index: true },
    razorpayOrderId: String,
    paidAt: Date,

    supplier: partySchema,
    customer: partySchema,

    // Invoices: how much has been refunded (credit notes issued).
    // Credit notes are "void" if Razorpay reports the refund failed.
    status: { type: String, enum: ["paid", "partially_refunded", "refunded", "issued", "void"], default: "paid" },
    refundedMinor: { type: Number, default: 0 },

    // Credit notes: which invoice and which Razorpay refund.
    invoiceId: { type: mongoose.Schema.Types.ObjectId, ref: "Invoice" },
    invoiceNumber: String,
    razorpayRefundId: String,
    reason: String,
    issuedBy: String,
  },
  { timestamps: true }
);

// One invoice per payment; one credit note per refund.
invoiceSchema.index({ issuedAt: -1 }); // reports and the finance dashboard
invoiceSchema.index({ kind: 1, razorpayPaymentId: 1 }, { unique: true, partialFilterExpression: { kind: "invoice" } });
invoiceSchema.index({ razorpayRefundId: 1 }, { unique: true, partialFilterExpression: { kind: "credit_note" } });

module.exports = mongoose.model("Invoice", invoiceSchema);
