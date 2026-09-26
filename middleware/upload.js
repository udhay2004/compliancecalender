// middleware/upload.js
//
// One shared upload setup for every upload route (client documents, staff
// proof of completion).
//
// FILES GO TO A TEMPORARY FILE ON DISK, NOT INTO MEMORY. Holding uploads in
// memory meant a few clients uploading 10 × 15 MB at once could use up the
// server's memory and crash it. From the temp file, lib/storage.js streams
// the upload to R2, and the temp file is deleted as soon as the request ends
// (success or error).
//
// FILE TYPES ARE CHECKED BY CONTENT, NOT JUST BY NAME. The browser's
// "this is a PDF" label can be faked, so after the upload the first bytes
// of each file are compared with what that type must start with (e.g. every
// PDF starts with "%PDF"). A mismatch is refused with a clear message.
//
// Usage in a route:
//   router.post("/x", acceptUploads(upload.single("file")), handler)
// handler gets req.file / req.files with .path (temp file) and .size.

const fs = require("fs");
const fsp = fs.promises;
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const multer = require("multer");

const MAX_FILE_SIZE_MB = 15;
const TMP_DIR = path.join(os.tmpdir(), "cc-uploads");
fs.mkdirSync(TMP_DIR, { recursive: true });

// type -> allowed file name endings, and how the file's content must start.
const TYPES = {
  "application/pdf": { ext: [".pdf"], check: (b) => b.slice(0, 1024).includes("%PDF") },
  "image/png": { ext: [".png"], check: (b) => b.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  "image/jpeg": { ext: [".jpg", ".jpeg"], check: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  "image/jpg": { ext: [".jpg", ".jpeg"], check: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  "image/webp": { ext: [".webp"], check: (b) => b.slice(0, 4).toString("latin1") === "RIFF" && b.slice(8, 12).toString("latin1") === "WEBP" },
  // Old Office formats (.doc/.xls) share one container signature…
  "application/msword": { ext: [".doc"], check: isOle },
  "application/vnd.ms-excel": { ext: [".xls"], check: isOle },
  // …and new ones (.docx/.xlsx) are zip files.
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": { ext: [".docx"], check: isZip },
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": { ext: [".xlsx"], check: isZip },
};
function isOle(b) { return b.slice(0, 8).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])); }
function isZip(b) { return b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04; }

const FRIENDLY_TYPES = "a PDF, an image (PNG, JPG or WEBP), or a Word or Excel file";

const upload = multer({
  storage: multer.diskStorage({
    destination: TMP_DIR,
    filename: (req, file, cb) => cb(null, crypto.randomUUID()),
  }),
  limits: { fileSize: MAX_FILE_SIZE_MB * 1024 * 1024, files: 11, fields: 30, fieldSize: 64 * 1024 },
  fileFilter: (req, file, cb) => {
    const t = TYPES[file.mimetype];
    const ext = path.extname(file.originalname || "").toLowerCase();
    if (!t || !t.ext.includes(ext)) {
      const err = new Error(`File type not allowed: ${file.mimetype} ${ext}`);
      err.code = "TYPE_NOT_ALLOWED";
      return cb(err);
    }
    cb(null, true);
  },
});

function uploadedFiles(req) {
  const out = [];
  if (req.file) out.push(req.file);
  if (Array.isArray(req.files)) out.push(...req.files);
  else if (req.files && typeof req.files === "object") Object.values(req.files).forEach((list) => out.push(...list));
  return out;
}

async function removeTempFiles(req) {
  await Promise.all(uploadedFiles(req).map((f) => (f.path ? fsp.unlink(f.path).catch(() => {}) : null)));
}

async function firstBytes(file, n = 1024) {
  const fh = await fsp.open(file.path, "r");
  try {
    const buf = Buffer.alloc(n);
    const { bytesRead } = await fh.read(buf, 0, n, 0);
    return buf.subarray(0, bytesRead);
  } finally {
    await fh.close();
  }
}

/** Returns an error message for the first file whose content doesn't match its type, or null. */
async function contentProblem(files) {
  for (const f of files) {
    if (!f.size) return `"${f.originalname}" is empty.`;
    const t = TYPES[f.mimetype];
    const head = await firstBytes(f);
    if (!t || !t.check(head)) {
      return `"${f.originalname}" doesn't look like a real ${path.extname(f.originalname).slice(1).toUpperCase() || "file"} file. Please upload ${FRIENDLY_TYPES}.`;
    }
  }
  return null;
}

/**
 * Wraps a multer middleware (upload.single / upload.fields / upload.array):
 *  - turns upload errors into clear 400 messages,
 *  - checks every file's content matches its type,
 *  - deletes the temporary files when the response ends, whatever happens.
 */
function acceptUploads(multerMiddleware, { maxFilesMessage = "You can upload up to 10 files at once." } = {}) {
  return (req, res, next) => {
    let cleaned = false;
    const cleanup = () => { if (!cleaned) { cleaned = true; removeTempFiles(req); } };
    res.on("finish", cleanup);
    res.on("close", cleanup);
    multerMiddleware(req, res, async (err) => {
      if (err) {
        const msg = err.code === "LIMIT_FILE_SIZE" ? `Each file must be under ${MAX_FILE_SIZE_MB} MB.`
          : err.code === "LIMIT_UNEXPECTED_FILE" || err.code === "LIMIT_FILE_COUNT" ? maxFilesMessage
          : err.code === "TYPE_NOT_ALLOWED" ? `Please upload ${FRIENDLY_TYPES}.`
          : "The upload failed. Please try again.";
        if (!["LIMIT_FILE_SIZE", "LIMIT_UNEXPECTED_FILE", "LIMIT_FILE_COUNT", "TYPE_NOT_ALLOWED"].includes(err.code)) {
          console.error("[upload] failed:", err.message);
        }
        return res.status(400).json({ error: msg });
      }
      try {
        const problem = await contentProblem(uploadedFiles(req));
        if (problem) return res.status(400).json({ error: problem });
      } catch (e) {
        console.error("[upload] could not check file contents:", e.message);
        return res.status(400).json({ error: "The upload failed. Please try again." });
      }
      next();
    });
  };
}

module.exports = { upload, acceptUploads, MAX_FILE_SIZE_MB, TMP_DIR, _internals: { TYPES, contentProblem } };
