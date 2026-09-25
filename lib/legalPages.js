// lib/legalPages.js
//
// Server-rendered public pages that payment-gateway reviewers (Razorpay)
// and clients need: About, Contact, Pricing, Terms, Privacy, Cancellation
// & Refunds, Shipping & Delivery. Rendered on the server as plain HTML so
// any crawler can read them without running JavaScript.
//
// The wording describes how THIS app actually works (AI-researched
// calendar reviewed by the team, services the client selects, prices from
// lib/complianceFees.js, Razorpay payments, documents in Cloudflare R2,
// proof of completion in the portal). It is a solid starting point, not
// legal advice: have a lawyer review it before relying on it.
//
// Business details (name, address, phone…) come from lib/businessInfo.js.

const { businessInfo } = require("./businessInfo");
const { getPriceList } = require("./complianceFees");

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const LINKS = [
  ["/about", "About us"],
  ["/pricing", "Pricing"],
  ["/contact", "Contact us"],
  ["/terms", "Terms & Conditions"],
  ["/privacy", "Privacy Policy"],
  ["/refund-policy", "Cancellation & Refunds"],
  ["/shipping-policy", "Shipping & Delivery"],
];

function addressHtml(b, sep = "<br>") {
  return b.addressLines.map(esc).join(sep);
}

/** Footer shown on every public page and the client portal. */
function footerHtml() {
  const b = businessInfo();
  return `
<footer class="site-footer" role="contentinfo">
  <div class="site-footer-inner">
    <div class="site-footer-biz">
      <div class="site-footer-name">${esc(b.displayName)}</div>
      ${b.addressLines.length ? `<div>${addressHtml(b, ", ")}</div>` : ""}
      <div>${b.SUPPORT_EMAIL ? `<a href="mailto:${esc(b.SUPPORT_EMAIL)}">${esc(b.SUPPORT_EMAIL)}</a>` : ""}${b.SUPPORT_PHONE ? ` · <a href="tel:${esc(b.SUPPORT_PHONE.replace(/[^\d+]/g, ""))}">${esc(b.SUPPORT_PHONE)}</a>` : ""}</div>
    </div>
    <nav class="site-footer-links" aria-label="Legal and company">
      ${LINKS.map(([href, label]) => `<a href="${href}">${esc(label)}</a>`).join("")}
    </nav>
  </div>
  <div class="site-footer-copy">© ${new Date().getFullYear()} ${esc(b.displayName)}. All rights reserved.</div>
</footer>`;
}

const FOOTER_CSS = `
.site-footer { margin-top: 64px; border-top: 1px solid var(--rule, #e3e8e8); background: var(--card, #fff); font-family: var(--sans, system-ui, sans-serif); font-size: 13px; color: var(--ink-soft, #5c6e72); }
.site-footer-inner { max-width: 1120px; margin: 0 auto; padding: 28px 24px 12px; display: flex; flex-wrap: wrap; gap: 20px 48px; justify-content: space-between; }
.site-footer-name { font-weight: 700; color: var(--ink, #1b2a2e); margin-bottom: 4px; }
.site-footer-biz { line-height: 1.7; max-width: 420px; }
.site-footer-links { display: grid; grid-template-columns: repeat(2, minmax(0, auto)); gap: 6px 28px; align-content: start; }
.site-footer a { color: var(--ink-soft, #5c6e72); text-decoration: none; }
.site-footer a:hover { color: var(--brand-dark, #1f7f79); text-decoration: underline; }
.site-footer-copy { max-width: 1120px; margin: 0 auto; padding: 8px 24px 24px; font-size: 12px; }
@media (max-width: 560px) { .site-footer-links { grid-template-columns: 1fr 1fr; } }`;

function layout({ title, description, body, path }) {
  const b = businessInfo();
  const canonical = b.appUrl ? `<link rel="canonical" href="${esc(b.appUrl + path)}">` : "";
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} · ${esc(b.BRAND_NAME)}</title>
<meta name="description" content="${esc(description)}">
${canonical}
<link rel="stylesheet" href="/shared.css">
<style>
  body { background: var(--paper, #f4f7f7); }
  .legal-top { background: var(--card, #fff); border-bottom: 1px solid var(--rule, #e3e8e8); }
  .legal-top-inner { max-width: 1120px; margin: 0 auto; padding: 16px 24px; display: flex; justify-content: space-between; align-items: center; gap: 16px; flex-wrap: wrap; font-family: var(--sans); }
  .legal-brand { font-weight: 700; color: var(--ink); text-decoration: none; font-size: 16px; }
  .legal-brand span { color: var(--brand, #34a9a1); }
  .legal-nav { display: flex; gap: 18px; flex-wrap: wrap; font-size: 14px; }
  .legal-nav a { color: var(--ink-soft); text-decoration: none; }
  .legal-nav a:hover, .legal-nav a[aria-current="page"] { color: var(--brand-dark); }
  .legal-main { max-width: 760px; margin: 0 auto; padding: 40px 24px 0; font-family: var(--sans); color: var(--ink); line-height: 1.7; font-size: 15px; }
  .legal-main h1 { font-family: var(--serif); font-size: 32px; line-height: 1.2; margin: 0 0 6px; }
  .legal-main .updated { color: var(--ink-soft); font-size: 13px; margin-bottom: 28px; }
  .legal-main h2 { font-family: var(--serif); font-size: 20px; margin: 32px 0 8px; }
  .legal-main p, .legal-main li { color: #33464a; }
  .legal-main ul { padding-left: 20px; }
  .legal-main li { margin: 4px 0; }
  .legal-main a { color: var(--brand-dark); }
  .legal-card { background: var(--card); border: 1px solid var(--rule); border-radius: var(--radius, 10px); padding: 18px 22px; margin: 16px 0; }
  .price-table { width: 100%; border-collapse: collapse; background: var(--card); border: 1px solid var(--rule); border-radius: var(--radius); overflow: hidden; font-size: 14px; }
  .price-table th, .price-table td { text-align: left; padding: 11px 14px; border-bottom: 1px solid var(--rule-soft, #eef2f2); vertical-align: top; }
  .price-table th { background: var(--paper); font-size: 12px; text-transform: uppercase; letter-spacing: .04em; color: var(--ink-soft); }
  .price-table td.amt { white-space: nowrap; font-weight: 700; text-align: right; }
  .price-table td.amt.soft { font-weight: 500; color: var(--ink-soft); white-space: normal; }
  @media (max-width: 560px) { .legal-main h1 { font-size: 26px; } .price-table td, .price-table th { padding: 9px 10px; } }
  ${FOOTER_CSS}
</style>
</head>
<body>
<header class="legal-top">
  <div class="legal-top-inner">
    <a class="legal-brand" href="/">${esc(b.BRAND_NAME)}</a>
    <nav class="legal-nav" aria-label="Main">
      <a href="/pricing"${path === "/pricing" ? ' aria-current="page"' : ""}>Pricing</a>
      <a href="/about"${path === "/about" ? ' aria-current="page"' : ""}>About</a>
      <a href="/contact"${path === "/contact" ? ' aria-current="page"' : ""}>Contact</a>
      <a href="/login.html">Log in</a>
    </nav>
  </div>
</header>
<main class="legal-main">
${body}
</main>
${footerHtml()}
</body>
</html>`;
}

// ---------------------------------------------------------------------
// Page bodies
// ---------------------------------------------------------------------
function contactBlock(b) {
  return `
<div class="legal-card">
  <p><strong>${esc(b.displayName)}</strong>${b.addressLines.length ? `<br>${addressHtml(b)}` : ""}</p>
  <p>Email: <a href="mailto:${esc(b.SUPPORT_EMAIL)}">${esc(b.SUPPORT_EMAIL)}</a>${b.SUPPORT_PHONE ? `<br>Phone / WhatsApp: <a href="tel:${esc(b.SUPPORT_PHONE.replace(/[^\d+]/g, ""))}">${esc(b.SUPPORT_PHONE)}</a>` : ""}<br>Hours: ${esc(b.BUSINESS_HOURS)}</p>
</div>`;
}

const PAGES = {
  "/about": (b) => ({
    title: "About us",
    description: `${b.BRAND_NAME} keeps US companies with international founders compliant: a researched compliance calendar and a team that files for you.`,
    body: `
<h1>About ${esc(b.BRAND_NAME)}</h1>
<p class="updated">${esc(b.displayName)}</p>
<p>${esc(b.BRAND_NAME)} helps founders, especially founders based outside the United States, keep their US company in good standing. Missing a US state or federal filing can mean penalties, loss of good standing or, for foreign-owned companies, very large fines, and the rules differ by state, entity type and fiscal year.</p>
<h2>What we do</h2>
<ul>
  <li><strong>Compliance calendar.</strong> Tell us about your company and we research every filing that applies to it (state annual reports and franchise taxes, federal returns, payroll filings, foreign-ownership reporting and more), with real due dates for your fiscal year. Our team reviews each calendar.</li>
  <li><strong>Filing services.</strong> Choose the filings you want us to handle. You upload the documents we list, we verify them, prepare and file, and upload proof of completion to your client portal.</li>
  <li><strong>Reminders.</strong> We remind you before every deadline, by email and in your portal, and roll each recurring filing forward to the next period.</li>
</ul>
<h2>How it works</h2>
<ul>
  <li>Generate your calendar for free and see prices for every service on our <a href="/pricing">pricing page</a>.</li>
  <li>Sign in, choose the services you want us to handle, and upload the listed documents.</li>
  <li>We verify your documents and confirm the price; you pay securely online.</li>
  <li>We complete the work and share proof of completion in your portal.</li>
</ul>
${b.GSTIN || b.CIN ? `<h2>Registration</h2><p>${b.CIN ? `CIN: ${esc(b.CIN)}<br>` : ""}${b.GSTIN ? `GSTIN: ${esc(b.GSTIN)}` : ""}</p>` : ""}
<h2>Contact</h2>
${contactBlock(b)}`,
  }),

  "/contact": (b) => ({
    title: "Contact us",
    description: `How to reach ${b.BRAND_NAME}: email, phone and registered address.`,
    body: `
<h1>Contact us</h1>
<p class="updated">We usually reply within one business day.</p>
${contactBlock(b)}
<h2>Existing clients</h2>
<p>The fastest way to reach us about a filing, a document or a payment is the <strong>Messages</strong> section of your <a href="/portal.html">client portal</a>, so everything stays with your filing.</p>
<h2>Refunds and payment questions</h2>
<p>See our <a href="/refund-policy">Cancellation &amp; Refunds policy</a>, or email <a href="mailto:${esc(b.SUPPORT_EMAIL)}">${esc(b.SUPPORT_EMAIL)}</a> with your company name and the service concerned.</p>
<h2>Grievance Officer</h2>
<p>For complaints about our service or how we handle your personal data:<br>${esc(b.grievanceName)}<br>Email: <a href="mailto:${esc(b.grievanceEmail)}">${esc(b.grievanceEmail)}</a>${b.addressLines.length ? `<br>${addressHtml(b, ", ")}` : ""}</p>
<p>We acknowledge complaints within 2 business days and aim to resolve them within 30 days.</p>`,
  }),

  "/pricing": (b) => {
    const list = getPriceList();
    const soft = (k) => (k === "fixed" ? "" : " soft");
    return {
      title: "Pricing",
      description: `${b.BRAND_NAME} service prices for US compliance filings, in US dollars.`,
      body: `
<h1>Pricing</h1>
<p class="updated">All prices are in US dollars (USD) and are charged per filing period.</p>
<p>Generating your compliance calendar is <strong>free</strong>. You only pay for the filings you choose to have us handle. Prices are shown next to every filing in your calendar before you choose it.</p>
<table class="price-table">
  <thead><tr><th scope="col">Service</th><th scope="col" style="text-align:right;">Price (USD)</th></tr></thead>
  <tbody>
    ${list.map((p) => `<tr><td>${esc(p.service)}</td><td class="amt${soft(p.kind)}">${esc(p.label)}</td></tr>`).join("")}
  </tbody>
</table>
<h2>How prices work</h2>
<ul>
  <li><strong>Fixed price</strong> (e.g. $125): applied as soon as you choose the service.</li>
  <li><strong>"From"</strong> (e.g. From $650): the starting price. We confirm the exact price after reviewing your documents, before you pay.</li>
  <li><strong>Price on request</strong>: we'll contact you with the price as soon as you upload your documents, before you pay.</li>
  <li><strong>Included</strong>: no separate charge when taken with the related service.</li>
</ul>
<p>You always see the final price in your portal before paying. If a government or state fee applies to a filing, we tell you the amount before you pay. Payments are processed securely by Razorpay; see our <a href="/refund-policy">Cancellation &amp; Refunds policy</a>.</p>`,
    };
  },

  "/terms": (b) => ({
    title: "Terms & Conditions",
    description: `Terms and conditions for using ${b.BRAND_NAME}.`,
    body: `
<h1>Terms &amp; Conditions</h1>
<p class="updated">Last updated: ${esc(b.POLICIES_LAST_UPDATED)}</p>
<p>These terms are an agreement between you and <strong>${esc(b.displayName)}</strong> ("${esc(b.BRAND_NAME)}", "we", "us") for use of this website, the client portal and our services. By creating an account, generating a calendar or paying for a service, you agree to them.</p>

<h2>1. Our services</h2>
<p>We provide (a) a compliance calendar listing the US federal, state and related filings that may apply to your company, with due dates, and (b) filing services for the filings you choose to have us handle, as described on our <a href="/about">About</a> and <a href="/pricing">Pricing</a> pages.</p>

<h2>2. The compliance calendar</h2>
<p>Calendars are researched with the help of artificial intelligence from official and public sources and reviewed by our team. They are provided for information and planning. Requirements change and depend on facts about your company; the calendar is not legal or tax advice for your specific situation unless we have agreed to handle that filing for you. Please tell us promptly if any company details change.</p>

<h2>3. Your account</h2>
<p>You must be at least 18 and authorised to act for the company you register. Keep your login secure; you are responsible for activity under your account. You must give us a valid email address and phone number so we can reach you about deadlines and documents.</p>

<h2>4. Engaging us for a filing</h2>
<ul>
  <li>An engagement starts when you choose a service in your portal and pay the price shown for it (or when we confirm in writing that we will proceed).</li>
  <li>You agree to provide complete, accurate and timely information and documents. We rely on what you provide.</li>
  <li>To meet a deadline, we need all documents and payment at least ${esc(b.DOCS_LEAD_TIME_DAYS)} business days before it. If we receive them later we will try our best, but we cannot guarantee on-time filing.</li>
  <li>We may decline or stop work on a filing if information is missing, inaccurate or unlawful, in which case our <a href="/refund-policy">refund policy</a> applies.</li>
</ul>

<h2>5. Fees and payment</h2>
<p>Prices are in US dollars and shown before you pay. Payment is made online through Razorpay, whose terms also apply to the payment. Government, state or third-party fees, where applicable, are charged at cost and shown before you pay. Cancellations and refunds are covered by our <a href="/refund-policy">Cancellation &amp; Refunds policy</a>.</p>

<h2>6. Communication</h2>
<p>We will contact you by email, in the portal, by phone and, where you have given us a number, by SMS or WhatsApp about your deadlines, documents, prices and filings. Deadline reminders are part of the service.</p>

<h2>7. Confidentiality and data</h2>
<p>We keep your documents and company information confidential and use them only to provide our services, as described in our <a href="/privacy">Privacy Policy</a>.</p>

<h2>8. Responsibility and limits</h2>
<ul>
  <li>We perform services with reasonable skill and care. We are not responsible for penalties, interest or losses caused by information or documents that were late, incomplete or inaccurate, by changes you did not tell us about, by filings you did not engage us for, or by delays of government systems or authorities.</li>
  <li>To the extent permitted by law, our total liability for any claim relating to a filing is limited to the fees you paid us for that filing, and we are not liable for indirect or consequential losses.</li>
</ul>

<h2>9. Acceptable use</h2>
<p>Do not misuse the website or portal, upload unlawful or malicious files, attempt to access other clients' data, or use our services for unlawful purposes.</p>

<h2>10. Ending the relationship</h2>
<p>You may stop using our services at any time. We may suspend or close accounts that breach these terms. Work already paid for is handled under our refund policy; you can ask us for copies of your documents.</p>

<h2>11. Changes</h2>
<p>We may update these terms. The date above shows the latest version; material changes will be notified by email or in the portal.</p>

<h2>12. Governing law</h2>
<p>These terms are governed by the laws of India. Courts at ${esc(b.JURISDICTION_CITY || "the city of our registered office")} have exclusive jurisdiction.</p>

<h2>13. Contact</h2>
${contactBlock(b)}`,
  }),

  "/privacy": (b) => ({
    title: "Privacy Policy",
    description: `How ${b.BRAND_NAME} collects, uses and protects your information.`,
    body: `
<h1>Privacy Policy</h1>
<p class="updated">Last updated: ${esc(b.POLICIES_LAST_UPDATED)}</p>
<p><strong>${esc(b.displayName)}</strong> ("we") respects your privacy. This policy explains what we collect, why, who we share it with and your choices.</p>

<h2>1. What we collect</h2>
<ul>
  <li><strong>Contact and account details:</strong> your name, email address, phone number, and, if you sign in with Google, your Google account name and email.</li>
  <li><strong>Company details:</strong> company name, state and country, entity and tax type, incorporation date, fiscal year, ownership and foreign-investment information, employee states and similar details you enter to generate a calendar.</li>
  <li><strong>Documents and messages:</strong> files you upload (for example incorporation certificates, financial statements, payroll reports, IDs) and messages you send us in the portal.</li>
  <li><strong>Payment information:</strong> payments are processed by Razorpay. We receive and store the amount, currency, status and payment reference, <em>not</em> your full card or bank details.</li>
  <li><strong>Technical data:</strong> server logs (such as IP address, browser type and pages requested) used for security and troubleshooting.</li>
</ul>

<h2>2. How we use it</h2>
<ul>
  <li>To research and maintain your compliance calendar and calculate due dates.</li>
  <li>To provide the services you choose: reviewing documents, preparing and submitting filings, and sharing proof of completion.</li>
  <li>To send deadline reminders, price and payment notices, and service messages by email, in the portal, and by phone, SMS or WhatsApp.</li>
  <li>To process payments and refunds, keep financial records, prevent fraud and meet legal obligations.</li>
</ul>
<p>We do not sell your personal information and we do not use it for third-party advertising.</p>

<h2>3. Who we share it with</h2>
<p>We share information only with service providers that help us run the service, under contracts that protect it, and with government authorities when filing on your behalf or when required by law:</p>
<ul>
  <li><strong>Anthropic</strong> (AI research that prepares your calendar; receives company details, not your uploaded documents), under commercial terms that do not allow it to train its models on this data.</li>
  <li><strong>Cloudflare</strong> (storage of uploaded documents), <strong>MongoDB Atlas</strong> (database) and <strong>Railway</strong> (application hosting).</li>
  <li><strong>Razorpay</strong> (payments), <strong>Google</strong> (optional sign-in) and our email delivery provider.</li>
  <li><strong>Government and state authorities</strong> (such as the IRS or state agencies) when we file on your behalf.</li>
</ul>
<p>These providers may process data in the United States, India or other countries.</p>

<h2>4. Cookies</h2>
<p>We use only essential cookies: one to keep you signed in, and short-lived ones to secure Google sign-in, complete account setup, and remember a calendar you generated while you sign up. We do not use advertising or analytics tracking cookies.</p>

<h2>5. How long we keep it</h2>
<p>We keep your information while your account is active and afterwards for as long as needed to provide records of our work and to meet tax, accounting and legal obligations. You can ask us to delete information we no longer need to keep.</p>

<h2>6. Security</h2>
<p>Data is sent over encrypted connections (HTTPS). Documents are stored with a cloud provider that encrypts data at rest, access is restricted to authorised staff, and every document download is checked against your account.</p>

<h2>7. Your rights</h2>
<p>You can ask to access, correct or delete your personal information, withdraw consent for optional uses, or nominate someone to exercise these rights, including under India's Digital Personal Data Protection Act, 2023. You can update your contact details yourself in the portal. For anything else, contact our Grievance Officer below.</p>

<h2>8. Children</h2>
<p>Our services are for businesses and are not directed to anyone under 18.</p>

<h2>9. Changes</h2>
<p>We will post any changes here and update the date above; material changes will be notified by email or in the portal.</p>

<h2>10. Grievance Officer and contact</h2>
<p>${esc(b.grievanceName)}<br>Email: <a href="mailto:${esc(b.grievanceEmail)}">${esc(b.grievanceEmail)}</a>${b.addressLines.length ? `<br>${addressHtml(b, ", ")}` : ""}</p>
<p>We acknowledge requests within 2 business days and aim to resolve them within 30 days.</p>`,
  }),

  "/refund-policy": (b) => ({
    title: "Cancellation & Refunds",
    description: `${b.BRAND_NAME} cancellation and refund policy.`,
    body: `
<h1>Cancellation &amp; Refunds</h1>
<p class="updated">Last updated: ${esc(b.POLICIES_LAST_UPDATED)}</p>
<p>This policy applies to fees paid to <strong>${esc(b.displayName)}</strong> for filing services. Generating a compliance calendar is free.</p>

<h2>Cancelling a service</h2>
<ul>
  <li><strong>Before you pay:</strong> you can remove any service from your portal at any time, free of charge.</li>
  <li><strong>After you pay, before we start work:</strong> cancel by messaging us in the portal or by email and we refund our fee in full.</li>
  <li><strong>After we have started preparing the filing:</strong> we refund the part of our fee that covers work not yet done, and explain the amount to you in writing.</li>
  <li><strong>After the filing has been submitted</strong> to the authority or the service is marked complete in your portal: the service has been delivered and our fee is not refundable.</li>
</ul>

<h2>When we refund in full</h2>
<ul>
  <li>You were charged twice or charged the wrong amount.</li>
  <li>We cannot provide the service you paid for.</li>
  <li>You gave us all documents and payment at least ${esc(b.DOCS_LEAD_TIME_DAYS)} business days before the deadline and we did not file on time because of our error (our fee for that filing).</li>
</ul>

<h2>Not refundable</h2>
<ul>
  <li>Government, state or third-party fees already paid to the authority on your behalf.</li>
  <li>Penalties or interest charged by authorities, except as set out in our <a href="/terms">Terms</a>.</li>
</ul>

<h2>How refunds are paid</h2>
<p>Refunds go back to the original payment method through Razorpay within ${esc(b.REFUND_PROCESSING_DAYS)} after we approve them. Your bank may take a few extra days to show the credit. Refunds are made in the currency you paid; any currency conversion is handled by your bank or card issuer.</p>

<h2>How to request a refund</h2>
<p>Message us in your portal or email <a href="mailto:${esc(b.SUPPORT_EMAIL)}">${esc(b.SUPPORT_EMAIL)}</a> with your company name and the service. We reply within 2 business days. If you have a problem with a payment, please contact us before raising a dispute with your bank; we will sort it out quickly.</p>`,
  }),

  "/shipping-policy": (b) => ({
    title: "Shipping & Delivery",
    description: `How ${b.BRAND_NAME} delivers its services.`,
    body: `
<h1>Shipping &amp; Delivery</h1>
<p class="updated">Last updated: ${esc(b.POLICIES_LAST_UPDATED)}</p>
<p><strong>${esc(b.displayName)}</strong> provides professional services online. <strong>We do not ship physical goods</strong>, and there are no shipping charges.</p>
<h2>How services are delivered</h2>
<ul>
  <li><strong>Compliance calendar:</strong> shown on screen as soon as it is generated, and saved to your client portal when you sign in. Our team reviews calendars, usually within 1 to 2 business days.</li>
  <li><strong>Filing services:</strong> we prepare and submit filings electronically, or as the authority requires. When a filing is done, we upload proof of completion (the filed return, acknowledgment, certificate or receipt) to your portal and notify you by email.</li>
  <li><strong>Documents and messages:</strong> available in your portal at any time.</li>
</ul>
<h2>Timelines</h2>
<p>We work to complete each filing before its legal due date. To make sure of that, we need all documents and payment at least ${esc(b.DOCS_LEAD_TIME_DAYS)} business days before the deadline; if they arrive later we do our best and tell you if the filing may be late. Delivery confirmation is the proof of completion in your portal.</p>
<h2>Questions</h2>
${contactBlock(b)}`,
  }),
};

function renderPage(path) {
  const make = PAGES[path];
  if (!make) return null;
  const b = businessInfo();
  const p = make(b);
  return layout({ ...p, path });
}

module.exports = { renderPage, footerHtml, FOOTER_CSS, LINKS, PAGE_PATHS: Object.keys(PAGES) };
