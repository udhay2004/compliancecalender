// lib/storage.js
//
// Where client documents and filed certificates live. Nothing else in the
// app touches files directly: routes call saveFile() / getFileStream() /
// fileExists() / deleteFile() and only ever see an opaque fileKey, so the
// driver can change without touching route code.
//
// DRIVERS
//   "s3"    - Cloudflare R2 (or any S3-compatible bucket). DURABLE. Use this
//             in production.
//   "local" - the server's own disk. Fine on a laptop; on Railway/Render/
//             Heroku that disk is wiped on every deploy, so files VANISH and
//             downloads fail with "file not found". This was the cause of
//             missing downloads when R2 was set up under R2_* names but this
//             file only read S3_* names.
//
// CONFIGURATION — either naming scheme works:
//
//   Cloudflare R2 names:              Generic S3 names:
//     R2_ACCOUNT_ID                     S3_ENDPOINT (https://<acct>.r2.cloudflarestorage.com)
//     R2_ACCESS_KEY_ID                  S3_ACCESS_KEY_ID
//     R2_SECRET_ACCESS_KEY              S3_SECRET_ACCESS_KEY
//     R2_BUCKET_NAME                    S3_BUCKET
//
// If those are present the bucket is used automatically. STORAGE_DRIVER is
// only needed to force a choice ("local" for development, "s3" to fail loudly
// at startup when settings are incomplete).

const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const { randomUUID } = require("crypto");

function bucketConfig() {
  const env = process.env;
  const endpoint =
    env.S3_ENDPOINT || (env.R2_ACCOUNT_ID ? `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com` : "");
  return {
    endpoint,
    bucket: env.S3_BUCKET || env.R2_BUCKET_NAME || env.R2_BUCKET || "",
    accessKeyId: env.S3_ACCESS_KEY_ID || env.R2_ACCESS_KEY_ID || "",
    secretAccessKey: env.S3_SECRET_ACCESS_KEY || env.R2_SECRET_ACCESS_KEY || "",
    region: env.S3_REGION || "auto", // R2 ignores region; "auto" is correct
  };
}

function missingBucketSettings(cfg = bucketConfig()) {
  const missing = [];
  if (!cfg.endpoint) missing.push("R2_ACCOUNT_ID (or S3_ENDPOINT)");
  if (!cfg.bucket) missing.push("R2_BUCKET_NAME (or S3_BUCKET)");
  if (!cfg.accessKeyId) missing.push("R2_ACCESS_KEY_ID (or S3_ACCESS_KEY_ID)");
  if (!cfg.secretAccessKey) missing.push("R2_SECRET_ACCESS_KEY (or S3_SECRET_ACCESS_KEY)");
  return missing;
}

function chooseDriver() {
  const forced = (process.env.STORAGE_DRIVER || "").toLowerCase();
  if (forced === "local") return "local";
  if (forced === "s3" || forced === "r2") return "s3";
  // Not forced: use the bucket whenever its settings are all there.
  return missingBucketSettings().length === 0 ? "s3" : "local";
}

const DRIVER = chooseDriver();
// Read once at startup; every later call uses the same settings.
const CONFIG = bucketConfig();

// A small map so downloads open with the right type even for files whose
// type the uploading browser didn't report.
const TYPES = {
  ".pdf": "application/pdf", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".gif": "image/gif", ".webp": "image/webp", ".heic": "image/heic", ".txt": "text/plain", ".csv": "text/csv",
  ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xls": "application/vnd.ms-excel",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".zip": "application/zip",
};
function contentTypeFor(fileName, reported) {
  if (reported && reported !== "application/octet-stream") return reported;
  return TYPES[path.extname(fileName || "").toLowerCase()] || "application/octet-stream";
}

// ---------------------------------------------------------------------
// Local disk driver (development only — see header)
// ---------------------------------------------------------------------
const LOCAL_UPLOAD_DIR = process.env.LOCAL_UPLOAD_DIR || path.join(__dirname, "..", "uploads");

const localDriver = {
  // Either `buffer` (small, in memory) or `filePath` (an upload's temp file).
  async saveFile({ buffer, filePath, fileName }) {
    await fsp.mkdir(LOCAL_UPLOAD_DIR, { recursive: true });
    const fileKey = `${randomUUID()}${path.extname(fileName || "")}`;
    const dest = path.join(LOCAL_UPLOAD_DIR, fileKey);
    if (filePath) await fsp.copyFile(filePath, dest);
    else await fsp.writeFile(dest, buffer);
    return { fileKey, fileUrl: "" };
  },
  async putFile(key, filePath) {
    const file = localPath(key);
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.copyFile(filePath, file);
  },
  async getFile(fileKey) {
    const filePath = localPath(fileKey);
    const stat = await fsp.stat(filePath).catch(() => null);
    if (!stat) return null;
    return { stream: fs.createReadStream(filePath), contentType: contentTypeFor(fileKey), contentLength: stat.size };
  },
  async exists(fileKey) {
    return Boolean(await fsp.stat(localPath(fileKey)).catch(() => null));
  },
  async deleteFile(fileKey) {
    await fsp.unlink(localPath(fileKey)).catch(() => {});
  },
  async putObject(key, buffer) {
    const file = localPath(key);
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.writeFile(file, buffer);
  },
  async listObjects(prefix) {
    const dir = path.join(LOCAL_UPLOAD_DIR, path.dirname(`${prefix}x`));
    const names = await fsp.readdir(dir).catch(() => []);
    const out = [];
    for (const n of names) {
      const key = path.posix.join(path.posix.dirname(`${prefix}x`), n);
      if (!key.startsWith(prefix)) continue;
      const st = await fsp.stat(path.join(dir, n)).catch(() => null);
      if (st && st.isFile()) out.push({ key, size: st.size, lastModified: st.mtime });
    }
    return out;
  },
};

// Plain uploads are flat files; named objects (backups/…) keep their folder.
function localPath(key) {
  const parts = String(key).split("/").filter((p) => p && p !== "." && p !== "..");
  return path.join(LOCAL_UPLOAD_DIR, ...parts);
}

// ---------------------------------------------------------------------
// S3-compatible driver (Cloudflare R2)
// ---------------------------------------------------------------------
let s3 = null;
function client() {
  if (!s3) {
    const { S3Client } = require("@aws-sdk/client-s3");
    const cfg = CONFIG;
    s3 = new S3Client({
      region: cfg.region,
      endpoint: cfg.endpoint,
      credentials: { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey },
    });
  }
  return s3;
}
const isNotFound = (err) => err && (err.name === "NoSuchKey" || err.name === "NotFound" || err.$metadata?.httpStatusCode === 404);

const s3Driver = {
  // Either `buffer` (small, in memory) or `filePath` (an upload's temp file,
  // streamed to the bucket so large files never sit in memory).
  async saveFile({ buffer, filePath, fileName, contentType }) {
    const { PutObjectCommand } = require("@aws-sdk/client-s3");
    const fileKey = `${randomUUID()}${path.extname(fileName || "")}`;
    const body = filePath ? fs.createReadStream(filePath) : buffer;
    const length = filePath ? (await fsp.stat(filePath)).size : undefined;
    await client().send(
      new PutObjectCommand({
        Bucket: CONFIG.bucket,
        Key: fileKey,
        Body: body,
        ...(length !== undefined ? { ContentLength: length } : {}),
        ContentType: contentTypeFor(fileName, contentType),
      })
    );
    return { fileKey, fileUrl: "" };
  },
  async putFile(key, filePath, contentType = "application/octet-stream") {
    const { PutObjectCommand } = require("@aws-sdk/client-s3");
    const { size } = await fsp.stat(filePath);
    await client().send(new PutObjectCommand({ Bucket: CONFIG.bucket, Key: key, Body: fs.createReadStream(filePath), ContentLength: size, ContentType: contentType }));
  },
  async getFile(fileKey) {
    const { GetObjectCommand } = require("@aws-sdk/client-s3");
    try {
      const r = await client().send(new GetObjectCommand({ Bucket: CONFIG.bucket, Key: fileKey }));
      return { stream: r.Body, contentType: r.ContentType || contentTypeFor(fileKey), contentLength: r.ContentLength };
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  },
  async exists(fileKey) {
    const { HeadObjectCommand } = require("@aws-sdk/client-s3");
    try {
      await client().send(new HeadObjectCommand({ Bucket: CONFIG.bucket, Key: fileKey }));
      return true;
    } catch (err) {
      if (isNotFound(err)) return false;
      throw err;
    }
  },
  async putObject(key, buffer, contentType = "application/octet-stream") {
    const { PutObjectCommand } = require("@aws-sdk/client-s3");
    await client().send(new PutObjectCommand({ Bucket: CONFIG.bucket, Key: key, Body: buffer, ContentType: contentType }));
  },
  async listObjects(prefix) {
    const { ListObjectsV2Command } = require("@aws-sdk/client-s3");
    const out = [];
    let token;
    do {
      const r = await client().send(new ListObjectsV2Command({ Bucket: CONFIG.bucket, Prefix: prefix, ContinuationToken: token }));
      (r.Contents || []).forEach((o) => out.push({ key: o.Key, size: o.Size, lastModified: o.LastModified }));
      token = r.IsTruncated ? r.NextContinuationToken : undefined;
    } while (token);
    return out;
  },
  async deleteFile(fileKey) {
    const { DeleteObjectCommand } = require("@aws-sdk/client-s3");
    await client().send(new DeleteObjectCommand({ Bucket: CONFIG.bucket, Key: fileKey })).catch(() => {});
  },
};

let driver = DRIVER === "s3" ? s3Driver : localDriver;

if (DRIVER === "s3") {
  const missing = missingBucketSettings(CONFIG);
  if (missing.length) {
    throw new Error(
      `STORAGE_DRIVER=s3 is set but these settings are missing: ${missing.join(", ")}. ` +
        "Copy them from Cloudflare dashboard → R2 → Manage API tokens (see .env.example)."
    );
  }
}

// ---------------------------------------------------------------------
// "Is this file still there?" — cached, because the staff screen asks
// for every uploaded document each time it opens. A file that exists
// is remembered for 10 minutes; a missing one is re-checked every time
// (so a re-upload or a fixed setting shows up immediately).
// ---------------------------------------------------------------------
const existsCache = new Map();
async function fileExists(fileKey) {
  if (!fileKey) return false;
  const hit = existsCache.get(fileKey);
  if (hit && Date.now() - hit < 10 * 60 * 1000) return true;
  let ok;
  try {
    ok = await driver.exists(fileKey);
  } catch (err) {
    // Can't reach storage right now: don't wrongly tell staff a file is lost.
    console.error("[storage] existence check failed:", err.message);
    return true;
  }
  if (ok) existsCache.set(fileKey, Date.now());
  return ok;
}

/** Of these keys, which are missing from storage? Checks in small batches. */
async function findMissing(fileKeys) {
  const unique = [...new Set(fileKeys.filter(Boolean))];
  const missing = new Set();
  for (let i = 0; i < unique.length; i += 10) {
    const batch = unique.slice(i, i + 10);
    const results = await Promise.all(batch.map(fileExists));
    batch.forEach((k, j) => { if (!results[j]) missing.add(k); });
  }
  return missing;
}

/**
 * Round-trip test for the admin "Check storage" button: write, read back,
 * delete a tiny file. Reports exactly which step failed, in plain words.
 */
async function healthCheck() {
  const cfg = CONFIG;
  const report = {
    driver: DRIVER,
    durable: DRIVER === "s3",
    bucket: DRIVER === "s3" ? cfg.bucket : null,
    endpointHost: DRIVER === "s3" ? (() => { try { return new URL(cfg.endpoint).host; } catch { return cfg.endpoint; } })() : null,
    missingSettings: DRIVER === "s3" ? [] : missingBucketSettings(CONFIG),
    steps: [],
    ok: false,
  };
  const step = async (name, fn) => {
    try { await fn(); report.steps.push({ name, ok: true }); return true; }
    catch (err) { report.steps.push({ name, ok: false, error: err.name ? `${err.name}: ${err.message}` : String(err) }); return false; }
  };
  let key;
  const body = Buffer.from(`storage check ${new Date().toISOString()}`);
  const wrote = await step("upload a test file", async () => { key = (await driver.saveFile({ buffer: body, fileName: "healthcheck.txt", contentType: "text/plain" })).fileKey; });
  const read = wrote && await step("download it again", async () => {
    const f = await driver.getFile(key);
    if (!f) throw new Error("uploaded file could not be found straight after uploading");
    const chunks = [];
    for await (const c of f.stream) chunks.push(Buffer.from(c));
    if (!Buffer.concat(chunks).equals(body)) throw new Error("downloaded content didn't match");
  });
  if (wrote) await step("delete it", () => driver.deleteFile(key));
  report.ok = Boolean(wrote && read);
  return report;
}

function describe() {
  if (DRIVER === "s3") return `Cloudflare R2 / S3 bucket "${CONFIG.bucket}"`;
  return `LOCAL DISK (${LOCAL_UPLOAD_DIR}) — not durable on hosted servers`;
}

// Legacy shape kept for any caller that only wants the stream.
async function getFileStream(fileKey) {
  const f = await driver.getFile(fileKey);
  return f ? f.stream : null;
}

module.exports = {
  saveFile: (args) => driver.saveFile(args),
  getFile: (fileKey) => driver.getFile(fileKey),
  getFileStream,
  deleteFile: (fileKey) => driver.deleteFile(fileKey),
  putObject: (key, buffer, contentType) => driver.putObject(key, buffer, contentType),
  putFile: (key, filePath, contentType) => driver.putFile(key, filePath, contentType),
  listObjects: (prefix) => driver.listObjects(prefix),
  fileExists,
  findMissing,
  healthCheck,
  describe,
  DRIVER,
  // tests only
  _setDriverForTests: (d) => { driver = d; existsCache.clear(); },
  _internals: { chooseDriver, bucketConfig, missingBucketSettings, contentTypeFor },
};
