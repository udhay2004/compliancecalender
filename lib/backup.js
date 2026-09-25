// lib/backup.js
//
// Nightly database backups to the same R2 bucket as client documents,
// under backups/ (scheduled in server.js; Admin → Backups shows them and
// can run one now).
//
// FORMAT: one gzip file per backup, newline-delimited JSON:
//   line 1:  {"manifest": {...}}                       what's inside
//   then:    {"c": "<collection>", "d": <document>}    one per document
// Documents are MongoDB Extended JSON (canonical), the same format
// mongoexport writes, so ObjectIds, dates and numbers restore exactly.
//
// KEEPS: every backup from the last 7 days, the newest backup of each day
// for 30 days, and the first backup of each month for 12 months.
//
// RESTORE: scripts/restoreBackup.js (read the header there first).

const zlib = require("zlib");
const mongoose = require("mongoose");
const storage = require("./storage");

const EJSON = mongoose.mongo.BSON.EJSON;
const PREFIX = "backups/";
const FORMAT = "complyglobally-backup-v1";

// Collections that aren't worth backing up (rebuildable caches).
const SKIP = new Set((process.env.BACKUP_SKIP_COLLECTIONS || "").split(",").map((s) => s.trim()).filter(Boolean));

function stampKey(date = new Date()) {
  return `${PREFIX}${date.toISOString().replace(/[:.]/g, "-")}.ndjson.gz`;
}

/** Date encoded in a backup key, or null. */
function dateFromKey(key) {
  const m = /backups\/(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z/.exec(key);
  return m ? new Date(`${m[1]}T${m[2]}:${m[3]}:${m[4]}.${m[5]}Z`) : null;
}

/**
 * Serialize every collection of `db` (a MongoDB Db, or anything with the
 * same listCollections/collection().find() shape) into a gzip buffer.
 */
async function dumpDatabase(db, { now = new Date() } = {}) {
  const infos = await db.listCollections({}, { nameOnly: true }).toArray();
  const names = infos.map((c) => c.name).filter((n) => !n.startsWith("system.") && !SKIP.has(n)).sort();
  const counts = {};
  const lines = [];
  for (const name of names) {
    let n = 0;
    const cursor = db.collection(name).find({});
    for await (const doc of cursor) {
      lines.push(JSON.stringify({ c: name, d: JSON.parse(EJSON.stringify(doc, { relaxed: false })) }));
      n++;
    }
    counts[name] = n;
  }
  const manifest = { format: FORMAT, createdAt: now.toISOString(), database: db.databaseName || "", collections: counts };
  const body = [JSON.stringify({ manifest }), ...lines].join("\n") + "\n";
  return { buffer: zlib.gzipSync(Buffer.from(body, "utf8"), { level: 9 }), manifest, rawBytes: Buffer.byteLength(body) };
}

/** Parse a backup buffer back into { manifest, collections: { name: [docs] } }. */
function parseBackup(buffer) {
  const text = zlib.gunzipSync(buffer).toString("utf8");
  const lines = text.split("\n").filter(Boolean);
  const first = JSON.parse(lines.shift());
  if (!first.manifest || first.manifest.format !== FORMAT) throw new Error("This isn't a ComplyGlobally backup file.");
  const collections = {};
  Object.keys(first.manifest.collections).forEach((c) => { collections[c] = []; });
  for (const line of lines) {
    const { c, d } = JSON.parse(line);
    // relaxed: plain JS numbers (types are exact in the file; ObjectIds and
    // dates still come back as ObjectId and Date).
    (collections[c] = collections[c] || []).push(EJSON.parse(JSON.stringify(d), { relaxed: true }));
  }
  for (const [c, n] of Object.entries(first.manifest.collections)) {
    if ((collections[c] || []).length !== n) throw new Error(`Backup is incomplete: ${c} has ${(collections[c] || []).length} of ${n} documents.`);
  }
  return { manifest: first.manifest, collections };
}

/**
 * Write documents back. By default refuses to touch a collection that
 * already has data; with { drop: true } replaces it.
 */
async function restoreInto(db, parsed, { drop = false, only = null, log = () => {} } = {}) {
  const results = {};
  for (const [name, docs] of Object.entries(parsed.collections)) {
    if (only && !only.includes(name)) continue;
    const col = db.collection(name);
    const existing = await col.countDocuments({});
    if (existing > 0 && !drop) throw new Error(`Collection "${name}" already has ${existing} documents. Restore into an empty database, or use --drop to replace.`);
    if (existing > 0 && drop) await col.deleteMany({});
    for (let i = 0; i < docs.length; i += 500) await col.insertMany(docs.slice(i, i + 500), { ordered: true });
    results[name] = docs.length;
    log(`  ${name}: ${docs.length}`);
  }
  return results;
}

/** Which backup keys to delete under the retention rules. */
function keysToPrune(keys, now = new Date()) {
  const dated = keys.map((key) => ({ key, date: dateFromKey(key) })).filter((x) => x.date).sort((a, b) => b.date - a.date);
  const keep = new Set(dated.slice(0, 3).map((x) => x.key)); // always the newest three
  const seenDay = new Set();
  const seenMonth = new Set();
  const DAY = 86400000;
  // Oldest first for "first of month", newest first for "newest of day".
  for (const x of dated) {
    const age = (now - x.date) / DAY;
    if (age <= 7) keep.add(x.key);
    const day = x.date.toISOString().slice(0, 10);
    if (age <= 30 && !seenDay.has(day)) { seenDay.add(day); keep.add(x.key); }
  }
  for (const x of [...dated].reverse()) {
    const age = (now - x.date) / DAY;
    const month = x.date.toISOString().slice(0, 7);
    if (age <= 366 && !seenMonth.has(month)) { seenMonth.add(month); keep.add(x.key); }
  }
  return dated.filter((x) => !keep.has(x.key)).map((x) => x.key);
}

let lastRun = null; // { ok, at, key, bytes, error }

/** Take a backup now, store it, prune old ones. */
async function runBackup({ reason = "scheduled" } = {}) {
  const started = Date.now();
  try {
    if (mongoose.connection.readyState !== 1) throw new Error("Database is not connected.");
    const db = mongoose.connection.db;
    const { buffer, manifest, rawBytes } = await dumpDatabase(db);
    const key = stampKey(new Date(manifest.createdAt));
    await storage.putObject(key, buffer, "application/gzip");
    let pruned = 0;
    try {
      const list = await storage.listObjects(PREFIX);
      const doomed = keysToPrune(list.map((o) => o.key));
      for (const k of doomed) { await storage.deleteFile(k); pruned++; }
    } catch (err) {
      console.error("[backup] pruning old backups failed (non-fatal):", err.message);
    }
    const total = Object.values(manifest.collections).reduce((a, b) => a + b, 0);
    lastRun = { ok: true, at: new Date(), key, bytes: buffer.length, documents: total, reason };
    console.log(`[backup] ${key}: ${total} documents, ${(buffer.length / 1024).toFixed(0)} KB compressed (${(rawBytes / 1024).toFixed(0)} KB raw), ${pruned} old backup(s) removed, ${Date.now() - started} ms.`);
    try {
      require("./auditLog").logActivity({ action: "backup_created", actor: null, summary: `Database backup (${reason}): ${total} documents, ${(buffer.length / 1024).toFixed(0)} KB.`, meta: { key, collections: manifest.collections } });
    } catch { /* logging is best-effort */ }
    return { ...lastRun, collections: manifest.collections, pruned };
  } catch (err) {
    lastRun = { ok: false, at: new Date(), error: err.message, reason };
    console.error("[backup] FAILED:", err.message);
    try {
      require("./auditLog").logActivity({ action: "backup_failed", actor: null, summary: `Database backup failed: ${err.message}` });
      require("./notify").notifyStaff({ type: "status_changed", title: "Database backup failed", body: `Tonight's database backup failed: ${err.message}\n\nOpen Admin → Backups to run it again.`, link: "/admin.html" });
    } catch { /* best-effort */ }
    throw err;
  }
}

async function listBackups() {
  const list = await storage.listObjects(PREFIX);
  return list
    .map((o) => ({ ...o, createdAt: dateFromKey(o.key) }))
    .filter((o) => o.createdAt)
    .sort((a, b) => b.createdAt - a.createdAt);
}

module.exports = {
  runBackup, listBackups, dumpDatabase, parseBackup, restoreInto, keysToPrune, dateFromKey, stampKey,
  lastRun: () => lastRun, PREFIX,
};
