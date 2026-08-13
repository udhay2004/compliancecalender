// middleware/upload.js
//
// Single shared multer config for every upload route (client document
// uploads, staff certificate uploads). Memory storage — we hand the
// buffer straight to lib/storage.js's saveFile() rather than letting
// multer write to disk itself, so switching storage drivers later
// doesn't require touching this file.

const multer = require("multer");

const MAX_FILE_SIZE_MB = 15;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_SIZE_MB * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    // Reasonable allowlist for compliance documents/certificates — not
    // meant to be exhaustive, just to block obviously wrong uploads
    // (executables, etc.). Extend if a legitimate format is missing.
    const allowed = [
      "application/pdf",
      "image/png",
      "image/jpeg",
      "image/jpg",
      "image/webp",
      "application/msword",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "application/vnd.ms-excel",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ];
    if (!allowed.includes(file.mimetype)) {
      return cb(new Error(`File type ${file.mimetype} not allowed.`));
    }
    cb(null, true);
  },
});

module.exports = { upload, MAX_FILE_SIZE_MB };
