// lib/calendarView.js
//
// One shared definition of "what does this item look like right now",
// used by BOTH the client portal (routes/portal.routes.js) and the staff
// screen (routes/calendar.routes.js). Before this file the two sides each
// computed their own version — the portal knew about the document
// checklist and document reuse, the staff screen didn't; the staff screen
// knew the price list, the portal didn't — which is exactly why the two
// UIs didn't match. Anything both sides display is computed here, once.

const { getRequiredDocuments } = require("./requiredDocuments");
const { getSuggestedFee, getPriceInfo } = require("./complianceFees");

// Every calendar that is real client work, as opposed to an anonymous
// lead from the public tool that nobody has claimed yet. A public
// calendar that a client later claimed (Google "Start filing" flow) keeps
// source:"public" but gains a clientOrgId — it IS real work from then on,
// and used to be silently dropped from staff counts and queues.
const REAL_WORK_MATCH = {
  $or: [{ source: { $in: ["staff", "client"] } }, { clientOrgId: { $ne: null } }],
};

// label -> the first non-rejected client upload for that label anywhere
// in the calendar (so one document can satisfy several filings).
function buildSharedDocumentIndex(calendar) {
  const index = {};
  (calendar.items || []).forEach((item, itemIndex) => {
    (item.documents || []).forEach((doc, docIndex) => {
      if (doc.type === "client_upload" && doc.requirementLabel && doc.reviewStatus !== "rejected") {
        const existing = index[doc.requirementLabel];
        // Prefer an accepted copy over a pending one if both exist.
        if (!existing || (existing.reviewStatus !== "accepted" && doc.reviewStatus === "accepted")) {
          index[doc.requirementLabel] = {
            itemIndex,
            docIndex,
            fileName: doc.fileName,
            reviewStatus: doc.reviewStatus,
            compliance_name: item.compliance_name,
          };
        }
      }
    });
  });
  return index;
}

/**
 * Per required document for this item: where it stands.
 *   state "accepted" | "pending" - uploaded (on this item or reused from another)
 *   state "rejected"             - only a rejected upload exists; needs a new file
 *   state "missing"              - nothing uploaded
 */
function computeChecklist(item, itemIndex, sharedIndex) {
  const required = getRequiredDocuments(item);
  return required.map((label) => {
    const hit = sharedIndex[label];
    if (hit) {
      return {
        label,
        state: hit.reviewStatus === "accepted" ? "accepted" : "pending",
        reused: hit.itemIndex !== itemIndex,
        fromItem: hit.itemIndex !== itemIndex ? hit.compliance_name : null,
        fileName: hit.fileName,
        itemIndex: hit.itemIndex,
        docIndex: hit.docIndex,
      };
    }
    const rejected = (item.documents || []).some(
      (d) => d.type === "client_upload" && d.requirementLabel === label && d.reviewStatus === "rejected"
    );
    return { label, state: rejected ? "rejected" : "missing", reused: false };
  });
}

function summarizeChecklist(checklist) {
  const provided = checklist.filter((r) => r.state === "accepted" || r.state === "pending").length;
  const accepted = checklist.filter((r) => r.state === "accepted").length;
  return {
    total: checklist.length,
    provided,
    accepted,
    allProvided: provided === checklist.length,
    allAccepted: accepted === checklist.length,
  };
}

// Payment gate (routes/payments.routes.js): every required document has
// a non-rejected upload somewhere in the calendar.
function hasAllRequiredDocuments(item, calendar) {
  const idx = (calendar.items || []).indexOf(item);
  return summarizeChecklist(computeChecklist(item, idx, buildSharedDocumentIndex(calendar))).allProvided;
}

function decorateItem(item, itemIndex, sharedIndex, { staff }) {
  const checklist = computeChecklist(item, itemIndex, sharedIndex);
  const out = {
    ...item,
    requiredDocuments: checklist.map((r) => r.label),
    checklist,
    checklistSummary: summarizeChecklist(checklist),
    price: getPriceInfo(item),
  };
  if (staff) {
    if (!item.feeAmountCents) out.suggestedFee = getSuggestedFee(item);
  } else {
    // Kept for older portal builds that read feeMessage directly.
    out.feeMessage = item.feeAmountCents ? null : getSuggestedFee(item).customerMessage;
  }
  return out;
}

function toView(calendar, { staff = false } = {}) {
  const obj = calendar.toObject ? calendar.toObject() : { ...calendar };
  const sharedIndex = buildSharedDocumentIndex(obj);
  obj.items = (obj.items || []).map((item, i) => decorateItem(item, i, sharedIndex, { staff }));
  obj.sharedDocumentIndex = sharedIndex;

  const selected = obj.items.filter((it) => it.selectedByClient);
  obj.summary = {
    totalItems: obj.items.length,
    selected: selected.length,
    notSelected: obj.items.length - selected.length,
    documentsPendingReview: obj.items.reduce(
      (n, it) => n + (it.documents || []).filter((d) => d.type === "client_upload" && d.reviewStatus === "pending").length,
      0
    ),
    readyToQuote: selected.filter((it) => it.checklistSummary.allProvided && it.paymentStatus === "Not Invoiced").length,
    awaitingPayment: selected.filter((it) => it.paymentStatus === "Invoiced" || it.paymentStatus === "Overdue").length,
    // Sum of what's been invoiced/paid on selected items, for a quick total.
    selectedInvoicedCents: selected.reduce((n, it) => n + (it.feeAmountCents || 0), 0),
  };
  return obj;
}

// Contact details the business needs before it can do any work: an email
// AND a phone number. Checked server-side before any client action that
// creates work (upload, select, pay, generate).
function missingContactFields(org) {
  const missing = [];
  if (!org || !org.primaryContactEmail) missing.push("email");
  if (!org || !org.primaryContactPhone) missing.push("phone");
  return missing;
}

// Loose international phone check: 7–15 digits once formatting is
// stripped, optional leading +. Deliberately permissive — the goal is to
// catch "asdf" and typos, not to reject real numbers from 45+ countries.
function normalizePhone(raw) {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!/^\+?[\d\s().-]+$/.test(trimmed)) return null;
  const digits = trimmed.replace(/\D/g, "");
  if (digits.length < 7 || digits.length > 15) return null;
  return trimmed.replace(/\s+/g, " ");
}

// Content-Disposition filename that can't break out of the header.
function safeDownloadName(name) {
  const cleaned = String(name || "document").replace(/[\r\n"\\]/g, "_").slice(0, 180);
  return cleaned || "document";
}
function setDownloadHeaders(res, fileName) {
  const safe = safeDownloadName(fileName);
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="${safe.replace(/[^\x20-\x7e]/g, "_")}"; filename*=UTF-8''${encodeURIComponent(safe)}`
  );
}

module.exports = {
  REAL_WORK_MATCH,
  buildSharedDocumentIndex,
  computeChecklist,
  summarizeChecklist,
  hasAllRequiredDocuments,
  toView,
  missingContactFields,
  normalizePhone,
  setDownloadHeaders,
};
