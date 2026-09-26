// lib/tempCleanup.js — removes upload temp files left behind by a crash
// (normally each request deletes its own; see middleware/upload.js).
const fs = require("fs");
const path = require("path");
const { TMP_DIR } = require("../middleware/upload");

function cleanOldTempFiles({ olderThanMs = 60 * 60 * 1000 } = {}) {
  try {
    const cutoff = Date.now() - olderThanMs;
    let removed = 0;
    for (const name of fs.readdirSync(TMP_DIR)) {
      const file = path.join(TMP_DIR, name);
      const st = fs.statSync(file, { throwIfNoEntry: false });
      if (st && st.isFile() && st.mtimeMs < cutoff) { fs.rmSync(file, { force: true }); removed++; }
    }
    if (removed) console.log(`[uploads] Removed ${removed} leftover temporary upload file(s).`);
  } catch (err) {
    console.warn("[uploads] Temp cleanup skipped:", err.message);
  }
}

module.exports = { cleanOldTempFiles };
