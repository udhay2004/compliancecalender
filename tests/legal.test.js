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
  "/about": /About ComplyGlobally/,
  "/contact": /Grievance Officer/,
  "/pricing": /Registered agent renewal[\s\S]*\$125/,
  "/terms": /Governing law[\s\S]*Faridabad/,
  "/privacy": /Anthropic[\s\S]*Cloudflare[\s\S]*Razorpay/,
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
