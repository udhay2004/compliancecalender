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
// S3-compatible driver (AWS S3, Cloudflare R2, DigitalOcean Spaces all
// speak this same API). NOT wired up by default — turn it on by setting
// STORAGE_DRIVER=s3 plus the S3_* env vars below, and running:
//   npm install @aws-sdk/client-s3 @aws-sdk/s3-request-presigner
// This is intentionally left as a stub with the exact shape the app
// expects, rather than half-implemented against credentials nobody has
// yet — filling this in is a same-day task once you've picked a
// provider and have real keys.
// ---------------------------------------------------------------------
const s3Driver = {
  async saveFile() {
    throw new Error(
      "STORAGE_DRIVER=s3 is set but the S3 driver isn't implemented yet. " +
        "Install @aws-sdk/client-s3, fill in lib/storage.js's s3Driver, and set " +
        "S3_BUCKET / S3_REGION / S3_ACCESS_KEY_ID / S3_SECRET_ACCESS_KEY (and " +
        "S3_ENDPOINT if using R2/Spaces instead of AWS)."
    );
  },
  getFileStream() {
    throw new Error("S3 driver not implemented yet — see lib/storage.js.");
  },
  async deleteFile() {
    throw new Error("S3 driver not implemented yet — see lib/storage.js.");
  },
};

const driver = DRIVER === "s3" ? s3Driver : localDriver;

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
