// lib/pdf.js
//
// Renders an approved (or any) calendar document to a PDF buffer using
// PDFKit (pure JS, no headless browser / no external binary download —
// important since this environment can't reach arbitrary CDNs).

const PDFDocument = require("pdfkit");

const CATEGORY_ORDER = [
  "Mandatory Annual",
  "Conditional",
  "Transfer Pricing",
  "Foreign Reporting (ODI/FEMA)",
  "Event-Based",
];

function groupByCategory(items) {
  const groups = {};
  items.forEach((it) => {
    const cat = it.category || "Other";
    if (!groups[cat]) groups[cat] = [];
    groups[cat].push(it);
  });
  return groups;
}

function calendarToPdfBuffer(calendar) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margin: 42 });
    const chunks = [];
    doc.on("data", (c) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    const { profile, items, status, reviewedAt } = calendar;

    // -- Header --
    doc.font("Helvetica-Bold").fontSize(18).fillColor("#14213D")
      .text(profile.companyName || "Unnamed Company");
    doc.moveDown(0.2);
    doc.font("Helvetica").fontSize(10).fillColor("#3B4A6B")
      .text(
        `${profile.entityType} (${profile.taxStatus}) · ${profile.state} · FY ${profile.fyStart}–${profile.fyEnd}`
      );
    doc.fontSize(9).fillColor("#9AA1A8")
      .text(
        `Status: ${status.toUpperCase()}${reviewedAt ? " · Reviewed " + new Date(reviewedAt).toLocaleDateString() : ""} · Generated ${new Date(calendar.createdAt).toLocaleDateString()}`
      );
    doc.moveDown(1);

    const groups = groupByCategory(items);

    CATEGORY_ORDER.forEach((cat) => {
      const catItems = groups[cat];
      if (!catItems || !catItems.length) return;

      if (doc.y > 700) doc.addPage();

      doc.moveDown(0.5);
      doc.font("Helvetica-Bold").fontSize(12).fillColor("#2E5E55").text(cat);
      doc.moveDown(0.3);

      catItems.forEach((it) => {
        if (doc.y > 700) doc.addPage();

        doc.font("Helvetica-Bold").fontSize(10.5).fillColor("#14213D")
          .text(`${it.compliance_name}  —  ${it.due_date}`);
        doc.font("Helvetica").fontSize(9.5).fillColor("#3B4A6B")
          .text(`Applies to: ${it.applicable_to || "—"}   |   Confidence: ${it.confidence || "medium"}`);
        if (it.description) {
          doc.fontSize(9.5).fillColor("#14213D").text(it.description);
        }
        if (it.authority) {
          doc.fontSize(9).fillColor("#3B4A6B").text(`Authority: ${it.authority}`);
        }
        if (it.source_url) {
          doc.fontSize(8.5).fillColor("#2E5E55").text(it.source_url, { link: it.source_url, underline: true });
        }
        doc.moveDown(0.6);
      });
    });

    doc.moveDown(1);
    doc.font("Helvetica-Oblique").fontSize(8.5).fillColor("#9AA1A8")
      .text(
        status === "approved"
          ? "This calendar has been reviewed and approved by a team member. Confirm anything marked medium/low confidence continues to be periodically re-checked against official sources."
          : "This calendar has NOT been reviewed/approved yet. Do not rely on it as a final source of truth."
      );

    doc.end();
  });
}

module.exports = { calendarToPdfBuffer };
