// tests/canonical-host.test.js — old addresses redirect to APP_URL.
const test = require("node:test");
const assert = require("node:assert");

const { canonicalHost } = require("../lib/canonicalHost");

// Runs the middleware once and reports what it did.
function run({ host, method = "GET", url = "/", appUrl = "https://compliance.complyglobally.com", env = "production" }) {
  const before = { NODE_ENV: process.env.NODE_ENV, APP_URL: process.env.APP_URL };
  process.env.NODE_ENV = env;
  if (appUrl === null) delete process.env.APP_URL; else process.env.APP_URL = appUrl;
  const out = { next: false, redirect: null };
  const req = { method, path: url.split("?")[0], originalUrl: url, get: (h) => (h.toLowerCase() === "host" ? host : undefined) };
  const res = { redirect: (status, to) => { out.redirect = { status, to }; } };
  try {
    canonicalHost(req, res, () => { out.next = true; });
  } finally {
    for (const [k, v] of Object.entries(before)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
  return out;
}

test("a page on the old Railway address goes to the same page on APP_URL", () => {
  const out = run({ host: "compliancecalender-production.up.railway.app", url: "/calendar.html?id=abc" });
  assert.deepStrictEqual(out.redirect, { status: 301, to: "https://compliance.complyglobally.com/calendar.html?id=abc" });
  assert.strictEqual(out.next, false);
});

test("the APP_URL address itself is served normally", () => {
  assert.strictEqual(run({ host: "compliance.complyglobally.com" }).next, true);
  assert.strictEqual(run({ host: "Compliance.ComplyGlobally.com" }).next, true);
});

test("webhooks, feeds and form posts on the old address are left alone", () => {
  const host = "compliancecalender-production.up.railway.app";
  assert.strictEqual(run({ host, method: "POST", url: "/api/webhooks/razorpay" }).next, true);
  assert.strictEqual(run({ host, url: "/api/webhooks/whatsapp?hub.mode=subscribe" }).next, true);
  assert.strictEqual(run({ host, method: "POST", url: "/login.html" }).next, true);
});

test("no redirect outside production or without a usable APP_URL", () => {
  const host = "localhost:3000";
  assert.strictEqual(run({ host, env: "development" }).next, true);
  assert.strictEqual(run({ host, appUrl: null }).next, true);
  assert.strictEqual(run({ host, appUrl: "not a url" }).next, true);
});
