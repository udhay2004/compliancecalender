// lib/invoices.js
//
// Invoices and credit notes.
//
//   ensureInvoiceForPayment()  called when a payment is confirmed (verify or
//                              webhook). Idempotent: one invoice per payment.
//   issueCreditNote()          called when a refund is created.
//   renderPdf()                the PDF, drawn from the stored snapshot.
//   backfillInvoices()         once at startup: invoices for payments made
//                              before invoicing existed.
//
// Numbering: <PREFIX>/<FY>/<0001>, e.g. INV/2026-27/0001 and CN/2026-27/0001
// (16 characters, the GST maximum). FY is the Indian financial year,
// April–March, of the issue date. Numbers come from an atomic counter, so
// they are unique and consecutive.
//
// Tax wording is configuration, not code: if GSTIN and LUT_ARN are set the
// invoice states it is an export of services under a Letter of Undertaking
// without payment of IGST. Have your CA confirm the wording and SAC code.

const PDFDocument = require("pdfkit");
const Invoice = require("../models/Invoice");
const Counter = require("../models/Counter");
const { businessInfo } = require("./businessInfo");

const PREFIX = { invoice: (process.env.INVOICE_PREFIX || "INV").toUpperCase(), credit_note: (process.env.CREDIT_NOTE_PREFIX || "CN").toUpperCase() };

/** Indian financial year label for a date: 2026-04-01 → "2026-27", 2027-03-31 → "2026-27". */
function fyOf(date) {
  const d = new Date(date);
  const y = d.getUTCFullYear();
  const start = d.getUTCMonth() >= 3 ? y : y - 1; // April = month 3
  return `${start}-${String((start + 1) % 100).padStart(2, "0")}`;
}

async function nextNumber(kind, date) {
  const fy = fyOf(date);
  const seq = await Counter.next(`${kind}:${fy}`);
  return { fy, seq, number: `${PREFIX[kind]}/${fy}/${String(seq).padStart(4, "0")}` };
}

function money(minor, currency) {
  const v = (minor || 0) / 100;
  return `${currency} ${v.toLocaleString(currency === "INR" ? "en-IN" : "en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

// "One hundred twenty-five US dollars and fifty cents"
const ONES = ["", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen"];
const TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];
function words(n) {
  if (n === 0) return "zero";
  const chunk = (x) => {
    let out = "";
    if (x >= 100) { out += `${ONES[Math.floor(x / 100)]} hundred`; x %= 100; if (x) out += " "; }
    if (x >= 20) { out += TENS[Math.floor(x / 10)]; if (x % 10) out += `-${ONES[x % 10]}`; } else if (x) out += ONES[x];
    return out;
  };
  const parts = [];
  [[1e9, "billion"], [1e6, "million"], [1e3, "thousand"], [1, ""]].forEach(([u, label]) => {
    const c = Math.floor(n / u) % 1000;
    if (c) parts.push(chunk(c) + (label ? ` ${label}` : ""));
  });
  return parts.join(" ");
}
function amountInWords(minor, currency) {
  const major = Math.floor(minor / 100), sub = minor % 100;
  const [unit, subUnit] = currency === "INR" ? ["rupees", "paise"] : ["US dollars", "cents"];
  const s = `${words(major)} ${unit}${sub ? ` and ${words(sub)} ${subUnit}` : ""} only`;
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function supplierSnapshot() {
  const b = businessInfo();
  return {
    name: b.displayName,
    lines: b.addressLines,
    gstin: b.GSTIN || "",
    email: b.SUPPORT_EMAIL || "",
    phone: b.SUPPORT_PHONE || "",
    country: "India",
  };
}

function customerSnapshot(org, calendar) {
  const lines = [];
  if (org?.billingAddress) org.billingAddress.split(/\r?\n|\|/).map((s) => s.trim()).filter(Boolean).forEach((l) => lines.push(l));
  const p = calendar?.profile || {};
  const where = [p.state, p.country && p.country !== "United States" ? p.country : "United States"].filter(Boolean).join(", ");
  if (!lines.length && where) lines.push(where);
  if (org?.primaryContactName) lines.push(`Attn: ${org.primaryContactName}`);
  return {
    name: org?.name || p.companyName || "Client",
    lines,
    email: org?.primaryContactEmail || "",
    phone: org?.primaryContactPhone || "",
    country: p.country || "United States",
  };
}

function taxNote() {
  const b = businessInfo();
  const lut = (process.env.LUT_ARN || "").trim();
  if (b.GSTIN && lut) return `Supply meant for export of services under LUT without payment of IGST (LUT ARN: ${lut}).`;
  if (b.GSTIN) return "Export of services.";
  return "";
}

function paymentAmount(item, paymentId) {
  // What Razorpay actually captured for this payment (currency may be INR).
  const ev = (item.paymentEvents || []).slice().reverse()
    .find((e) => e.razorpayPaymentId === paymentId && typeof e.amountCents === "number" && /verify|webhook_captured|reconciled|duplicate_payment/.test(e.event));
  return ev ? { amountMinor: ev.amountCents, currency: (ev.currency || "USD").toUpperCase() } : { amountMinor: item.feeAmountCents || 0, currency: "USD" };
}

function periodLabel(item) {
  if (!item.dueDateActual) return item.due_date ? `Due ${item.due_date}` : "";
  const d = new Date(item.dueDateActual);
  return `Due ${d.getUTCDate()} ${d.toLocaleString("en-US", { month: "short", timeZone: "UTC" })} ${d.getUTCFullYear()}`;
}

/**
 * One invoice per captured payment. Returns the invoice (existing or new).
 */
async function ensureInvoiceForPayment({ calendar, item, itemIndex, org }) {
  const paymentId = item.razorpayPaymentId;
  if (!paymentId) return null;
  const existing = await Invoice.findOne({ kind: "invoice", razorpayPaymentId: paymentId });
  if (existing) return existing;
  const issuedAt = item.paidAt ? new Date(item.paidAt) : new Date();
  const { amountMinor, currency } = paymentAmount(item, paymentId);
  const { fy, seq, number } = await nextNumber("invoice", issuedAt);
  try {
    return await Invoice.create({
      kind: "invoice", number, fy, seq, issuedAt,
      clientOrgId: calendar.clientOrgId, calendarId: calendar._id, itemIndex,
      description: item.compliance_name, period: periodLabel(item),
      sac: process.env.INVOICE_SAC_CODE || "",
      amountMinor, currency, usdPriceCents: item.feeAmountCents || null, taxNote: taxNote(),
      razorpayPaymentId: paymentId, razorpayOrderId: item.razorpayOrderId || null, paidAt: item.paidAt || issuedAt,
      supplier: supplierSnapshot(), customer: customerSnapshot(org, calendar), status: "paid",
    });
  } catch (err) {
    // Two confirmations raced (verify + webhook): the other one won.
    if (err && err.code === 11000) return Invoice.findOne({ kind: "invoice", razorpayPaymentId: paymentId });
    throw err;
  }
}

/** Credit note for a refund, and update the invoice's refunded total. */
async function issueCreditNote({ invoice, refund, reason, by }) {
  const existing = await Invoice.findOne({ kind: "credit_note", razorpayRefundId: refund.id });
  if (existing) return existing;
  const issuedAt = new Date();
  const { fy, seq, number } = await nextNumber("credit_note", issuedAt);
  const note = await Invoice.create({
    kind: "credit_note", number, fy, seq, issuedAt,
    clientOrgId: invoice.clientOrgId, calendarId: invoice.calendarId, itemIndex: invoice.itemIndex,
    description: `Refund: ${invoice.description}`, period: invoice.period, sac: invoice.sac,
    amountMinor: refund.amount, currency: invoice.currency, taxNote: invoice.taxNote,
    razorpayPaymentId: invoice.razorpayPaymentId, razorpayRefundId: refund.id,
    supplier: invoice.supplier, customer: invoice.customer, status: "issued",
    invoiceId: invoice._id, invoiceNumber: invoice.number, reason, issuedBy: by,
  });
  invoice.refundedMinor = (invoice.refundedMinor || 0) + refund.amount;
  invoice.status = invoice.refundedMinor >= invoice.amountMinor ? "refunded" : "partially_refunded";
  await invoice.save();
  return note;
}

/**
 * Razorpay reported the refund FAILED: the money didn't go back, so the
 * credit note is voided and the invoice's refunded total reduced again.
 */
async function voidCreditNoteForRefund(refundId) {
  const note = await Invoice.findOne({ kind: "credit_note", razorpayRefundId: refundId });
  if (!note || note.status === "void") return null;
  note.status = "void";
  await note.save();
  const invoice = note.invoiceId ? await Invoice.findById(note.invoiceId) : null;
  if (invoice) {
    invoice.refundedMinor = Math.max(0, (invoice.refundedMinor || 0) - note.amountMinor);
    invoice.status = invoice.refundedMinor <= 0 ? "paid" : invoice.refundedMinor >= invoice.amountMinor ? "refunded" : "partially_refunded";
    await invoice.save();
  }
  return note;
}

// ---------------------------------------------------------------------
// PDF
// ---------------------------------------------------------------------
function renderPdf(doc, { compress = true } = {}) {
  return new Promise((resolve, reject) => {
    const pdf = new PDFDocument({ size: "A4", margin: 50, compress, info: { Title: `${doc.kind === "invoice" ? "Invoice" : "Credit note"} ${doc.number}`, Author: doc.supplier?.name || "" } });
    const chunks = [];
    pdf.on("data", (c) => chunks.push(c));
    pdf.on("end", () => resolve(Buffer.concat(chunks)));
    pdf.on("error", reject);

    const INK = "#1B2A2E", SOFT = "#5C6E72", BRAND = "#1F7F79", RULE = "#D9E1E2";
    const isInvoice = doc.kind === "invoice";
    const left = 50, right = 545;
    const date = (d) => (d ? new Date(d).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" }) : "");

    // Header
    pdf.font("Helvetica-Bold").fontSize(20).fillColor(INK).text(isInvoice ? "INVOICE" : "CREDIT NOTE", left, 50);
    if (doc.status === "void") pdf.font("Helvetica-Bold").fontSize(11).fillColor("#B3261E").text("VOID: the refund did not go through", left, 96);
    pdf.font("Helvetica").fontSize(9).fillColor(SOFT).text(isInvoice ? (doc.status === "paid" || doc.status?.includes("refund") ? "Paid" : "") : `Against invoice ${doc.invoiceNumber || ""}`, left, 76);
    pdf.font("Helvetica-Bold").fontSize(10).fillColor(INK).text(doc.number, 330, 52, { width: right - 330, align: "right" });
    pdf.font("Helvetica").fontSize(9).fillColor(SOFT)
      .text(`Date: ${date(doc.issuedAt)}`, 330, 67, { width: right - 330, align: "right" })
      .text(`Financial year: ${doc.fy}`, 330, 80, { width: right - 330, align: "right" });

    // Parties
    const party = (title, p, x, y) => {
      pdf.font("Helvetica-Bold").fontSize(8.5).fillColor(BRAND).text(title, x, y);
      pdf.font("Helvetica-Bold").fontSize(10.5).fillColor(INK).text(p?.name || "", x, y + 14, { width: 230 });
      pdf.font("Helvetica").fontSize(9).fillColor(SOFT);
      (p?.lines || []).forEach((l) => pdf.text(l, { width: 230 }));
      if (p?.gstin) pdf.text(`GSTIN: ${p.gstin}`, { width: 230 });
      if (p?.email) pdf.text(p.email, { width: 230 });
      if (p?.phone) pdf.text(p.phone, { width: 230 });
      return pdf.y;
    };
    const y1 = party("FROM", doc.supplier, left, 120);
    const y2 = party(isInvoice ? "BILL TO" : "ISSUED TO", doc.customer, 315, 120);
    let y = Math.max(y1, y2) + 24;

    // Table
    pdf.moveTo(left, y).lineTo(right, y).strokeColor(RULE).lineWidth(1).stroke();
    y += 8;
    pdf.font("Helvetica-Bold").fontSize(8.5).fillColor(SOFT)
      .text("DESCRIPTION", left, y).text("SAC", 360, y, { width: 50 }).text("AMOUNT", 420, y, { width: right - 420, align: "right" });
    y += 16;
    pdf.moveTo(left, y).lineTo(right, y).strokeColor(RULE).stroke();
    y += 10;
    pdf.font("Helvetica-Bold").fontSize(10.5).fillColor(INK).text(doc.description || "", left, y, { width: 300 });
    pdf.font("Helvetica").fontSize(9).fillColor(SOFT);
    if (doc.period) pdf.text(doc.period, left, pdf.y + 2, { width: 300 });
    if (!isInvoice && doc.reason) pdf.text(`Reason: ${doc.reason}`, left, pdf.y + 2, { width: 300 });
    const leftBottom = pdf.y; // after everything in the description column
    pdf.font("Helvetica").fontSize(10).fillColor(INK).text(doc.sac || "-", 360, y, { width: 50 });
    pdf.font("Helvetica-Bold").fontSize(10.5).text(money(doc.amountMinor, doc.currency), 420, y, { width: right - 420, align: "right" });
    y = Math.max(pdf.y, leftBottom) + 14;
    pdf.moveTo(left, y).lineTo(right, y).strokeColor(RULE).stroke();
    y += 12;

    // Totals
    const row = (label, value, bold) => {
      pdf.font(bold ? "Helvetica-Bold" : "Helvetica").fontSize(bold ? 11 : 9.5).fillColor(bold ? INK : SOFT)
        .text(label, 300, y, { width: 150 }).text(value, 420, y, { width: right - 420, align: "right" });
      y += bold ? 20 : 15;
    };
    row("Subtotal", money(doc.amountMinor, doc.currency));
    if (doc.taxNote) row("IGST", money(0, doc.currency));
    row(isInvoice ? "Total" : "Total credited", money(doc.amountMinor, doc.currency), true);
    if (isInvoice && doc.refundedMinor) row("Refunded (see credit notes)", `- ${money(doc.refundedMinor, doc.currency)}`);
    y += 4;
    pdf.font("Helvetica").fontSize(9).fillColor(SOFT).text(`Amount in words: ${amountInWords(doc.amountMinor, doc.currency)}`, left, y, { width: right - left });
    if (isInvoice && doc.currency !== "USD" && doc.usdPriceCents) pdf.text(`Service price: ${money(doc.usdPriceCents, "USD")}, charged in ${doc.currency}.`, { width: right - left });
    y = pdf.y + 18;

    // Payment / tax
    pdf.font("Helvetica-Bold").fontSize(8.5).fillColor(BRAND).text(isInvoice ? "PAYMENT" : "REFUND", left, y);
    pdf.font("Helvetica").fontSize(9).fillColor(SOFT);
    if (isInvoice) {
      pdf.text(`Paid online via Razorpay on ${date(doc.paidAt || doc.issuedAt)}.`, left, y + 13);
      if (doc.razorpayPaymentId) pdf.text(`Payment reference: ${doc.razorpayPaymentId}`);
    } else {
      pdf.text(`Refunded to the original payment method via Razorpay. Refund reference: ${doc.razorpayRefundId || ""}`, left, y + 13, { width: right - left });
      if (doc.razorpayPaymentId) pdf.text(`Original payment reference: ${doc.razorpayPaymentId}`);
    }
    if (doc.taxNote) pdf.moveDown(0.6).fillColor(INK).text(doc.taxNote, { width: right - left });
    if (doc.customer?.country) pdf.fillColor(SOFT).text(`Place of supply: ${doc.customer.country === "India" ? "India" : `${doc.customer.country} (outside India)`}`);

    // Footer
    pdf.font("Helvetica").fontSize(8).fillColor(SOFT)
      .text(`${doc.supplier?.name || ""}${doc.supplier?.email ? " | " + doc.supplier.email : ""}. This is a computer-generated ${isInvoice ? "invoice" : "credit note"} and needs no signature.`, left, 780, { width: right - left, align: "center" });

    pdf.end();
  });
}

/** Invoices for payments made before invoicing existed (run once at startup). */
async function backfillInvoices() {
  const Calendar = require("../models/Calendar");
  const ClientOrg = require("../models/ClientOrg");
  const calendars = await Calendar.find({ clientOrgId: { $ne: null }, "items.paymentStatus": { $in: ["Paid", "Partially Refunded", "Refunded"] } });
  const paid = [];
  calendars.forEach((c) => c.items.forEach((it, idx) => { if (it.razorpayPaymentId && ["Paid", "Partially Refunded", "Refunded"].includes(it.paymentStatus)) paid.push({ c, it, idx }); }));
  paid.sort((a, b) => new Date(a.it.paidAt || 0) - new Date(b.it.paidAt || 0)); // oldest first: numbers in date order
  let created = 0;
  for (const { c, it, idx } of paid) {
    if (await Invoice.exists({ kind: "invoice", razorpayPaymentId: it.razorpayPaymentId })) continue;
    const org = await ClientOrg.findById(c.clientOrgId).lean().catch(() => null);
    await ensureInvoiceForPayment({ calendar: c, item: it, itemIndex: idx, org });
    created++;
  }
  if (created) console.log(`[invoices] Created ${created} invoice(s) for earlier payments.`);
  return created;
}

module.exports = { ensureInvoiceForPayment, issueCreditNote, voidCreditNoteForRefund, renderPdf, backfillInvoices, fyOf, nextNumber, amountInWords, money, paymentAmount };
