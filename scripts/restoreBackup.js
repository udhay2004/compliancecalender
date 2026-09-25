#!/usr/bin/env node
// scripts/restoreBackup.js — restore a database backup made by lib/backup.js.
//
// SAFE WAY TO RESTORE (recommended):
//   1. See what's there:
//        node scripts/restoreBackup.js --list
//   2. Look inside one without changing anything:
//        node scripts/restoreBackup.js backups/2026-09-24T02-30-00-000Z.ndjson.gz --dry-run
//   3. Restore into a NEW, empty database (e.g. create "compliance_restore"
//      in MongoDB Atlas) and check the data there:
//        node scripts/restoreBackup.js <backup> --into "mongodb+srv://…/compliance_restore"
//   4. When happy, point MONGODB_URI (Railway → Variables) at that database
//      and redeploy.
//
// Restoring over live data is possible but deliberate:
//        node scripts/restoreBackup.js <backup> --into "<uri>" --drop
// --only calendars,users   restores just those collections.
//
// <backup> is a key in the bucket (backups/…) or a local .ndjson.gz file
// (e.g. one downloaded from Admin → Backups). Needs the same R2 settings
// as the app (put them in .env) when reading from the bucket.

require("dotenv").config();
const fs = require("fs");
const mongoose = require("mongoose");
const storage = require("../lib/storage");
const { parseBackup, restoreInto, listBackups } = require("../lib/backup");

function arg(name) {
  const i = process.argv.indexOf(name);
  return i !== -1 ? process.argv[i + 1] : undefined;
}
const has = (name) => process.argv.includes(name);

async function readBackup(source) {
  if (fs.existsSync(source)) return fs.readFileSync(source);
  const f = await storage.getFile(source);
  if (!f) throw new Error(`No backup found at "${source}". Run with --list to see available backups.`);
  const chunks = [];
  for await (const c of f.stream) chunks.push(Buffer.from(c));
  return Buffer.concat(chunks);
}

(async () => {
  if (has("--list")) {
    const list = await listBackups();
    if (!list.length) console.log("No backups found in", storage.describe());
    list.forEach((b) => console.log(`${b.key}   ${(b.size / 1024).toFixed(0)} KB`));
    return;
  }
  const source = process.argv[2];
  if (!source || source.startsWith("--")) {
    console.log("Usage: node scripts/restoreBackup.js <backup-key-or-file> (--dry-run | --into <mongodb-uri> [--drop] [--only a,b])\n       node scripts/restoreBackup.js --list");
    process.exit(1);
  }
  const parsed = parseBackup(await readBackup(source));
  console.log(`Backup from ${parsed.manifest.createdAt} (database "${parsed.manifest.database}"):`);
  Object.entries(parsed.manifest.collections).forEach(([c, n]) => console.log(`  ${c}: ${n}`));
  if (has("--dry-run")) return console.log("\nDry run: nothing was changed.");

  const into = arg("--into");
  if (!into) throw new Error("Say where to restore with --into \"<mongodb uri>\" (use a new, empty database first).");
  if (into === process.env.MONGODB_URI && !has("--drop")) {
    console.log("\nNote: that's the live database. Existing collections will not be overwritten without --drop.");
  }
  await mongoose.connect(into);
  console.log(`\nRestoring into "${mongoose.connection.db.databaseName}"…`);
  const only = arg("--only") ? arg("--only").split(",").map((s) => s.trim()) : null;
  await restoreInto(mongoose.connection.db, parsed, { drop: has("--drop"), only, log: console.log });
  console.log("Done.");
  await mongoose.disconnect();
})().catch(async (err) => {
  console.error("Restore failed:", err.message);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
