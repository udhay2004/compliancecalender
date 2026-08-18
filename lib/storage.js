// lib/storage.js
//
// IMPORTANT — read this before deploying with real client documents:
//
// This defaults to a LOCAL DISK driver, which is fine for local
// development and testing, but WRONG for production if you're deploying
// to Render/Railway/most PaaS hosts — their filesystems are ephemeral,
// meaning everything written here is wiped on every redeploy/restart. A
// client's uploaded tax document silently disappearing is the kind of
// bug that ends a client relationship. See the "S3-compatible driver"
// section below before you go live with real client uploads.
//
// The whole point of this file is that nothing else in the app talks to
// the filesystem directly — routes call saveFile()/getFileStream()/
// deleteFile() and get back an opaque fileKey, so swapping the driver
// later doesn't touch route code at all.

const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const { randomUUID: uuidv4 } = require("crypto");

const DRIVER = process.env.STORAGE_DRIVER || "local";
const LOCAL_UPLOAD_DIR = process.env.LOCAL_UPLOAD_DIR || path.join(__dirname, "..", "uploads");

// ---------------------------------------------------------------------
// Local disk driver (default, works out of the box, NOT durable on
// ephemeral hosts — see warning above).
// ---------------------------------------------------------------------
const localDriver = {
  async saveFile({ buffer, fileName }) {
    await fsp.mkdir(LOCAL_UPLOAD_DIR, { recursive: true });
    const ext = path.extname(fileName || "");
    const fileKey = `${uuidv4()}${ext}`;
    await fsp.writeFile(path.join(LOCAL_UPLOAD_DIR, fileKey), buffer);
    // fileUrl is a display hint only — real access always goes through
    // an authenticated download route (see routes/calendar.routes.js /
    // routes/portal.routes.js), never served statically.
    return { fileKey, fileUrl: "" };
  },
  getFileStream(fileKey) {
    const filePath = path.join(LOCAL_UPLOAD_DIR, fileKey);
    if (!fs.existsSync(filePath)) return null;
    return fs.createReadStream(filePath);
  },
  async deleteFile(fileKey) {
    const filePath = path.join(LOCAL_UPLOAD_DIR, fileKey);
    await fsp.unlink(filePath).catch(() => {}); // already gone is fine
  },
};

// ---------------------------------------------------------------------
// S3-compatible driver — configured here for Cloudflare R2, but speaks
// the same API as AWS S3/DigitalOcean Spaces too. Turn it on with
// STORAGE_DRIVER=s3 plus the S3_* env vars below (see .env.example).
//
// NOTE on getFileStream(): unlike the local driver, this one is
// necessarily async (fetching from R2 is a network call), and it
// resolves to `null` on a missing key instead of returning null
// synchronously. Both call sites (routes/calendar.routes.js and
// routes/portal.routes.js) already `await storage.getFileStream(...)`,
// so this is a drop-in swap.
// ---------------------------------------------------------------------
const {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} = require("@aws-sdk/client-s3");

let s3Client = null;
function getClient() {
  if (!s3Client) {
    s3Client = new S3Client({
      region: process.env.S3_REGION || "auto", // R2 ignores region, "auto" is correct
      endpoint: process.env.S3_ENDPOINT, // e.g. https://<account_id>.r2.cloudflarestorage.com
      credentials: {
        accessKeyId: process.env.S3_ACCESS_KEY_ID,
        secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
      },
    });
  }
  return s3Client;
}

const s3Driver = {
  async saveFile({ buffer, fileName }) {
    const ext = path.extname(fileName || "");
    const fileKey = `${uuidv4()}${ext}`;
    await getClient().send(
      new PutObjectCommand({
        Bucket: process.env.S3_BUCKET,
        Key: fileKey,
        Body: buffer,
      })
    );
    // Real access always goes through the authenticated download routes
    // (never the bucket directly), so we don't need a public fileUrl —
    // same convention as the local driver.
    return { fileKey, fileUrl: "" };
  },
  async getFileStream(fileKey) {
    try {
      const result = await getClient().send(
        new GetObjectCommand({ Bucket: process.env.S3_BUCKET, Key: fileKey })
      );
      return result.Body; // Node.js Readable — supports .pipe(res) directly
    } catch (err) {
      if (err.name === "NoSuchKey" || err.$metadata?.httpStatusCode === 404) {
        return null;
      }
      throw err;
    }
  },
  async deleteFile(fileKey) {
    await getClient()
      .send(new DeleteObjectCommand({ Bucket: process.env.S3_BUCKET, Key: fileKey }))
      .catch(() => {}); // already gone is fine, matches local driver behavior
  },
};

const driver = DRIVER === "s3" ? s3Driver : localDriver;

if (DRIVER === "s3") {
  const required = ["S3_BUCKET", "S3_ENDPOINT", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY"];
  const missing = required.filter((key) => !process.env[key]);
  if (missing.length) {
    throw new Error(
      `STORAGE_DRIVER=s3 is set but missing required env var(s): ${missing.join(", ")}. ` +
        "See .env.example for how to fill these in from the Cloudflare R2 dashboard."
    );
  }
}

if (DRIVER === "local" && process.env.NODE_ENV === "production") {
  console.warn(
    "\n[storage warning] STORAGE_DRIVER is 'local' in production. Uploaded " +
      "client documents will be LOST on the next deploy/restart on most hosts. " +
      "See lib/storage.js for how to switch to S3/R2 before real client use.\n"
  );
}

module.exports = {
  saveFile: (...args) => driver.saveFile(...args),
  getFileStream: (...args) => driver.getFileStream(...args),
  deleteFile: (...args) => driver.deleteFile(...args),
  DRIVER,
};
