// routes/reports.routes.js
//
// Reports (public/reports.html, lib/reports.js):
//
//   GET /api/reports/summary?range=30d|90d|12m|fy|custom&from=&to=
//   GET /api/reports/filings.csv?…same…    every chosen filing active in the period
//   GET /api/reports/revenue.csv?…same…    invoices and refunds (finance/admin only)
//
// Everyone on the team sees delivery numbers. Money is only assembled for
// finance and admins — same rule as the dashboard (routes/dashboard.routes.js).

const express = require("express");
const ClientOrg = require("../models/ClientOrg");
const { requireAuth, requireRole } = require("../middleware/auth");
const P = require("../lib/pipeline");
const R = require("../lib/reports");
const { loadWork } = require("./pipeline.routes");

const router = express.Router();
router.use(requireAuth, requireRole("staff"));

const canSeeFinance = (user) => user.role !== "staff" || user.department === "finance";

function periodOr400(req, res) {
  const period = R.periodFrom(req.query);
  if (period.error) { res.status(400).json({ error: period.error }); return null; }
  return period;
}

/** Every selected filing (current and past periods) as report rows. */
function selectedRows(calendars, orgs) {
  const rows = [];
  calendars.forEach(({ calendar, view }) => {
    const org = orgs.get(String(calendar.clientOrgId));
    view.items.forEach((item, itemIndex) => {
      if (!item.selectedByClient) return;
      rows.push({ item, itemIndex, calendarId: String(calendar._id), company: org?.name || calendar.profile?.companyName || "(unnamed)" });
    });
  });
  return rows;
}

async function invoiceDocs(extraQuery = {}) {
  const Invoice = require("../models/Invoice");
  return Invoice.find(extraQuery).select("kind number issuedAt amountMinor currency status description customer calendarId itemIndex razorpayPaymentId invoiceNumber reason refundedMinor").lean();
}

// GET /api/reports/summary
router.get("/summary", async (req, res) => {
  const period = periodOr400(req, res);
  if (!period) return;
  const { calendars, orgs, users, team } = await loadWork();
  const cards = P.buildCards(calendars, orgs, users);
  const rows = selectedRows(calendars, orgs);

  const [newClients, totalClients] = await Promise.all([
    ClientOrg.countDocuments({ createdAt: { $gte: period.from, $lt: period.to } }),
    ClientOrg.countDocuments({}),
  ]);
  const payload = {
    period: { range: period.range, label: period.label, from: period.fromDate, to: period.toDate },
    filings: R.filingStats(rows, period),
    pipeline: { stages: P.STAGES, counts: P.countByStage(cards) },
    workload: R.workload(cards, rows, team, period),
    services: R.services(rows, period).slice(0, 15),
    clients: { new: newClients, total: totalClients, withWork: new Set(rows.filter((r) => !r.item.isHistory && r.item.clientStatus !== "Filed").map((r) => r.company)).size },
    canSeeFinance: canSeeFinance(req.user),
    generatedAt: new Date(),
  };
  if (payload.canSeeFinance) {
    // Only what the page can show: the period, and the 12-month chart.
    const chartStart = new Date(Date.UTC(period.to.getUTCFullYear(), period.to.getUTCMonth() - 12, 1));
    const since = period.from < chartStart ? period.from : chartStart;
    payload.revenue = R.revenue(await invoiceDocs({ issuedAt: { $gte: since, $lt: period.to } }), period);
  }
  res.json(payload);
});

function sendCsv(res, name, text) {
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${name}"`);
  res.setHeader("Cache-Control", "no-store");
  res.send(text);
}

const day = (d) => (d ? new Date(d).toISOString().slice(0, 10) : "");
const inP = (d, p) => d && new Date(d) >= p.from && new Date(d) < p.to;

// GET /api/reports/filings.csv — chosen in the period, finished in the
// period, or still open now.
router.get("/filings.csv", async (req, res) => {
  const period = periodOr400(req, res);
  if (!period) return;
  const { calendars, orgs, users } = await loadWork();
  const cards = P.buildCards(calendars, orgs, users);
  const stageLabel = Object.fromEntries(P.STAGES.map((s) => [s.key, s.label]));
  const cardFor = new Map(cards.map((c) => [`${c.calendarId}:${c.itemIndex}`, c]));
  const rows = selectedRows(calendars, orgs)
    .filter((r) => inP(r.item.selectedAt, period) || inP(r.item.completedAt, period) || (!r.item.isHistory && r.item.clientStatus !== "Filed"))
    .map((r) => {
      const it = r.item;
      const card = cardFor.get(`${r.calendarId}:${r.itemIndex}`);
      const org = orgs.get(String(calendars.find((c) => String(c.calendar._id) === r.calendarId)?.calendar.clientOrgId));
      const owner = P.ownerOf(it, org, users);
      const ot = R.onTime(it);
      return [
        r.company, it.compliance_name, it.isHistory ? "Past period" : "Current",
        card ? stageLabel[card.stage] : it.clientStatus === "Filed" ? "Done" : "",
        it.clientStatus, it.paymentStatus,
        it.feeAmountCents ? (it.feeAmountCents / 100).toFixed(2) : "",
        day(it.selectedAt), day(it.dueDateActual), day(it.completedAt),
        ot === null ? "" : ot ? "Yes" : "No",
        R.turnaroundDays(it) ?? "",
        owner.name || "", it.completedByName || it.completedBy || "",
        `${process.env.APP_URL || ""}/calendar.html?id=${r.calendarId}#item-${r.itemIndex}`,
      ];
    });
  const csv = R.toCsv(
    ["Company", "Filing", "Period", "Stage", "Status", "Payment", "Price (USD)", "Chosen on", "Due", "Filed on", "On time", "Turnaround (days)", "Owner", "Filed by", "Link"],
    rows
  );
  sendCsv(res, `filings_${period.fromDate}_to_${period.toDate}.csv`, csv);
});

// GET /api/reports/revenue.csv — every invoice and credit note in the period.
router.get("/revenue.csv", async (req, res) => {
  if (!canSeeFinance(req.user)) return res.status(403).json({ error: "Only finance and admins can export revenue." });
  const period = periodOr400(req, res);
  if (!period) return;
  const docs = (await invoiceDocs({ issuedAt: { $gte: period.from, $lt: period.to } }))
    .sort((a, b) => new Date(a.issuedAt) - new Date(b.issuedAt));
  const rows = docs.map((d) => {
    const amount = (d.amountMinor || 0) / 100;
    const signed = d.kind === "credit_note" ? (d.status === "void" ? 0 : -amount) : amount;
    return [
      day(d.issuedAt), d.kind === "invoice" ? "Invoice" : "Credit note", d.number, d.invoiceNumber || "",
      d.customer?.name || "", d.description || "", d.currency, amount.toFixed(2), signed.toFixed(2),
      d.status, d.razorpayPaymentId || "", d.reason || "",
    ];
  });
  const csv = R.toCsv(["Date", "Type", "Number", "For invoice", "Client", "Service", "Currency", "Amount", "Net effect", "Status", "Razorpay payment", "Refund reason"], rows);
  sendCsv(res, `revenue_${period.fromDate}_to_${period.toDate}.csv`, csv);
});

module.exports = router;
