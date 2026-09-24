// tests/storage-config.test.js
//
// lib/storage.js must pick up Cloudflare R2 settings under EITHER naming
// scheme. The R2_* names were being ignored before, which silently sent
// every upload to the server's disk (wiped on deploy).

const test = require("node:test");
const assert = require("node:assert");
const path = require("node:path");

const STORAGE = path.join(__dirname, "..", "lib", "storage.js");
const KEYS = ["STORAGE_DRIVER", "S3_ENDPOINT", "S3_BUCKET", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY",
  "R2_ACCOUNT_ID", "R2_BUCKET_NAME", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY"];

function load(env) {
  const saved = {};
  KEYS.forEach((k) => { saved[k] = process.env[k]; delete process.env[k]; });
  Object.assign(process.env, env);
  delete require.cache[require.resolve(STORAGE)];
  try { return require(STORAGE); }
  finally { KEYS.forEach((k) => { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }); }
}

test("R2_* settings switch storage to the bucket automatically", () => {
  const s = load({ R2_ACCOUNT_ID: "abc123", R2_BUCKET_NAME: "docs", R2_ACCESS_KEY_ID: "id", R2_SECRET_ACCESS_KEY: "secret" });
  assert.strictEqual(s.DRIVER, "s3");
  assert.match(s.describe(), /docs/);
});

test("S3_* settings work too", () => {
  const s = load({ S3_ENDPOINT: "https://abc.r2.cloudflarestorage.com", S3_BUCKET: "b", S3_ACCESS_KEY_ID: "i", S3_SECRET_ACCESS_KEY: "s" });
  assert.strictEqual(s.DRIVER, "s3");
});

test("with no bucket settings it falls back to local disk and says so", () => {
  const s = load({});
  assert.strictEqual(s.DRIVER, "local");
  assert.match(s.describe(), /LOCAL DISK/);
});

test("forcing s3 with incomplete settings fails loudly at startup", () => {
  assert.throws(() => load({ STORAGE_DRIVER: "s3", R2_BUCKET_NAME: "docs" }), /R2_ACCOUNT_ID/);
});

test("health check reports each step against a working driver", async () => {
  const s = load({});
  const files = new Map();
  const { Readable } = require("node:stream");
  s._setDriverForTests({
    saveFile: async ({ buffer }) => { files.set("t", buffer); return { fileKey: "t" }; },
    getFile: async (k) => (files.has(k) ? { stream: Readable.from([files.get(k)]) } : null),
    exists: async (k) => files.has(k),
    deleteFile: async (k) => { files.delete(k); },
  });
  const r = await s.healthCheck();
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.steps.map((x) => x.ok), [true, true, true]);
  assert.strictEqual(r.durable, false, "local disk is never reported as durable");
});

test("health check names the failing step", async () => {
  const s = load({});
  s._setDriverForTests({
    saveFile: async () => { const e = new Error("Access Denied"); e.name = "AccessDenied"; throw e; },
    getFile: async () => null, exists: async () => false, deleteFile: async () => {},
  });
  const r = await s.healthCheck();
  assert.strictEqual(r.ok, false);
  assert.match(r.steps[0].error, /AccessDenied/);
});

test("file types are set so downloads open correctly", () => {
  const s = load({});
  const { contentTypeFor } = s._internals;
  assert.strictEqual(contentTypeFor("scan.PDF"), "application/pdf");
  assert.strictEqual(contentTypeFor("photo.jpeg", "application/octet-stream"), "image/jpeg");
  assert.strictEqual(contentTypeFor("x.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"), "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
});
