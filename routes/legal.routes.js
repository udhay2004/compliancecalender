// routes/legal.routes.js
//
// Public company and policy pages (server-rendered, crawlable, no login):
//   /about  /contact  /pricing  /terms  /privacy  /refund-policy  /shipping-policy
// plus common alternative addresses a reviewer might try (/terms.html,
// /privacy-policy, /refunds, /cancellation-policy, /delivery-policy …).
//
// Also exports sendPageWithFooter(), used by server.js to add the same
// footer (business name, address, contact, policy links) to the static
// pages: home, login, sign-up and the client portal.

const fs = require("fs");
const path = require("path");
const express = require("express");
const { renderPage, footerHtml, FOOTER_CSS, PAGE_PATHS } = require("../lib/legalPages");

const router = express.Router();

const ALIASES = {
  "/about-us": "/about",
  "/contact-us": "/contact",
  "/prices": "/pricing",
  "/terms-and-conditions": "/terms",
  "/terms-of-service": "/terms",
  "/tos": "/terms",
  "/privacy-policy": "/privacy",
  "/refunds": "/refund-policy",
  "/refund": "/refund-policy",
  "/cancellation-policy": "/refund-policy",
  "/cancellation-and-refund-policy": "/refund-policy",
  "/shipping": "/shipping-policy",
  "/delivery-policy": "/shipping-policy",
  "/shipping-and-delivery": "/shipping-policy",
};

function send(res, pagePath) {
  const html = renderPage(pagePath);
  res.set("Cache-Control", "public, max-age=300");
  res.type("html").send(html);
}

PAGE_PATHS.forEach((p) => {
  router.get([p, `${p}.html`], (req, res) => send(res, p));
});
Object.entries(ALIASES).forEach(([alias, target]) => {
  router.get([alias, `${alias}.html`], (req, res) => res.redirect(301, target));
});

// ---------------------------------------------------------------------
// Footer on static pages
// ---------------------------------------------------------------------
const PUBLIC_DIR = path.join(__dirname, "..", "public");
const fileCache = new Map();

/**
 * Send a file from public/ with the site footer inserted where the page
 * has <!--SITE_FOOTER--> (or just before </body> if it doesn't).
 */
function sendPageWithFooter(res, fileName) {
  let raw = fileCache.get(fileName);
  if (raw === undefined || process.env.NODE_ENV !== "production") {
    raw = fs.readFileSync(path.join(PUBLIC_DIR, fileName), "utf8");
    fileCache.set(fileName, raw);
  }
  const block = `<style>${FOOTER_CSS}</style>${footerHtml()}`;
  const html = raw.includes("<!--SITE_FOOTER-->") ? raw.replace("<!--SITE_FOOTER-->", block) : raw.replace("</body>", `${block}\n</body>`);
  res.type("html").send(html);
}

module.exports = router;
module.exports.sendPageWithFooter = sendPageWithFooter;
module.exports.ALIASES = ALIASES;
