// tests/legal.test.js — public company & policy pages (Razorpay website review).
const test = require("node:test");
const assert = require("node:assert");
const http = require("node:http");
const express = require("express");

Object.assign(process.env, {
  BUSINESS_LEGAL_NAME: "ComplyGlobally Advisors Private Limited",
  BUSINESS_ADDRESS: "Plot 12, Sector 16 | Faridabad, Haryana 121002 | India",
  SUPPORT_PHONE: "+91 98100 00000",
  SUPPORT_EMAIL: "support@complyglobally.com",
  JURISDICTION_CITY: "Faridabad",
  APP_URL: "https://app.example.com",
});

const legal = require("../routes/legal.routes");
const { missingBusinessInfo } = require("../lib/businessInfo");

const app = express();
app.use(legal);
app.get("/", (req, res) => legal.sendPageWithFooter(res, "index.html"));
let base, server;
test.before(async () => { server = http.createServer(app); await new Promise((r) => server.listen(0, r)); base = `http://127.0.0.1:${server.address().port}`; });
test.after(() => server.close());

const PAGES = {
  "/contact": /Grievance Officer/,
  "/pricing": /Registered agent renewal[\s\S]*\$125/,
  "/terms": /Governing law[\s\S]*Faridabad/,
  "/privacy": /Cloudflare[\s\S]*Razorpay/,
  "/refund-policy": /Refunds go back to the original payment method/,
  "/shipping-policy": /We do not ship physical goods/,
};

test("every required page loads without login, as plain HTML a crawler can read", async () => {
  for (const [path, mustHave] of Object.entries(PAGES)) {
    const res = await fetch(base + path);
    assert.strictEqual(res.status, 200, path);
    assert.match(res.headers.get("content-type"), /html/);
    const html = await res.text();
    assert.match(html, mustHave, path);
    assert.match(html, /ComplyGlobally Advisors Private Limited/, `${path}: registered name`);
    assert.match(html, /Faridabad, Haryana 121002/, `${path}: address in footer`);
    assert.match(html, /\+91 98100 00000/, `${path}: phone`);
    for (const link of Object.keys(PAGES)) assert.ok(html.includes(`href="${link}"`), `${path} footer links to ${link}`);
    assert.ok(!/<script/i.test(html), `${path} needs no JavaScript`);
  }
});

test(".html versions and common alternative addresses work", async () => {
  let res = await fetch(`${base}/terms.html`);
  assert.strictEqual(res.status, 200);
  for (const [alias, target] of [["/privacy-policy", "/privacy"], ["/refunds", "/refund-policy"], ["/cancellation-policy", "/refund-policy"], ["/terms-and-conditions", "/terms"], ["/contact-us", "/contact"]]) {
    res = await fetch(base + alias, { redirect: "manual" });
    assert.strictEqual(res.status, 301, alias);
    assert.strictEqual(res.headers.get("location"), target);
  }
});

test("the homepage gets the same footer, with business details and all policy links", async () => {
  const html = await (await fetch(base + "/")).text();
  assert.ok(!html.includes("<!--SITE_FOOTER-->"), "placeholder replaced");
  assert.match(html, /class="site-footer"/);
  assert.match(html, /ComplyGlobally Advisors Private Limited/);
  for (const link of Object.keys(PAGES)) assert.ok(html.includes(`href="${link}"`), link);
});

test("missing business details are reported", () => {
  assert.deepStrictEqual(missingBusinessInfo(), []);
  const saved = process.env.BUSINESS_ADDRESS;
  delete process.env.BUSINESS_ADDRESS;
  try {
    assert.deepStrictEqual(missingBusinessInfo().map((m) => m.key), ["BUSINESS_ADDRESS"]);
  } finally { process.env.BUSINESS_ADDRESS = saved; }
});

// ---------------------------------------------------------------------
// The way back to the main ComplyGlobally website
// ---------------------------------------------------------------------
const MAIN = {
  home: "https://complyglobally.com/",
  about: "https://complyglobally.com/about-us/",
  countries: "https://complyglobally.com/global-presence/",
  contact: "https://complyglobally.com/contact-us/",
};

test("every public page links back to the main website: home, About, Countries, Contact", async () => {
  for (const path of ["/", "/pricing", "/contact", "/terms", "/privacy", "/refund-policy", "/shipping-policy"]) {
    const html = await (await fetch(base + path)).text();
    for (const [name, url] of Object.entries(MAIN)) assert.ok(html.includes(`href="${url}"`), `${path} links to the main site's ${name} page`);
    assert.ok(!html.includes('href="/about"'), `${path}: no link to an About page inside the tool`);
  }
  // The landing page and the sign-in page also have it in the top bar.
  const fs = require("node:fs");
  const path = require("node:path");
  for (const page of ["index.html", "login.html"]) {
    const src = fs.readFileSync(path.join(__dirname, "..", "public", page), "utf8");
    assert.match(src, /<a class="(site-link|main-site-link)" href="https:\/\/complyglobally\.com\/"/, `${page} top bar`);
  }
});

test("About and Countries addresses on this site send you to the main website", async () => {
  for (const [from, to] of [["/about", MAIN.about], ["/about.html", MAIN.about], ["/about-us", MAIN.about], ["/countries", MAIN.countries], ["/global-presence", MAIN.countries], ["/main-site", MAIN.home]]) {
    const res = await fetch(base + from, { redirect: "manual" });
    assert.strictEqual(res.status, 302, from);
    assert.strictEqual(res.headers.get("location"), to, from);
  }
  // Support, prices and policies stay here (the payment provider checks them on this site).
  for (const stays of ["/contact", "/pricing", "/terms", "/privacy", "/refund-policy", "/shipping-policy"]) {
    assert.strictEqual((await fetch(base + stays, { redirect: "manual" })).status, 200, stays);
  }
  const support = await (await fetch(base + "/contact")).text();
  assert.match(support, /Support &amp; grievances/);
  assert.ok(support.includes(`href="${MAIN.contact}"`), "points to the main site's contact page for everything else");
});

test("contact details default to the main website's, and the main-site address can't be made unsafe", () => {
  const { businessInfo } = require("../lib/businessInfo");
  const saved = { e: process.env.SUPPORT_EMAIL, p: process.env.SUPPORT_PHONE, m: process.env.MAIN_SITE_URL };
  try {
    delete process.env.SUPPORT_EMAIL; delete process.env.SUPPORT_PHONE; delete process.env.MAIN_SITE_URL;
    let b = businessInfo();
    assert.strictEqual(b.SUPPORT_EMAIL, "sales@complyglobally.com");
    assert.strictEqual(b.SUPPORT_PHONE, "+91 9999981613");
    assert.deepStrictEqual({ home: b.mainSite.home, about: b.mainSite.about, countries: b.mainSite.countries, contact: b.mainSite.contact }, MAIN);

    process.env.MAIN_SITE_URL = "https://www.example.org///";
    assert.strictEqual(businessInfo().mainSite.about, "https://www.example.org/about-us/");
    for (const bad of ["javascript:alert(1)", "//evil.example", "ftp://x", 'https://x"onmouseover="y']) {
      process.env.MAIN_SITE_URL = bad;
      assert.strictEqual(businessInfo().mainSite.home, MAIN.home, bad);
    }
  } finally {
    for (const [k, v] of [["SUPPORT_EMAIL", saved.e], ["SUPPORT_PHONE", saved.p], ["MAIN_SITE_URL", saved.m]]) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
});
