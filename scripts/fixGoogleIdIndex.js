// scripts/fixGoogleIdIndex.js
//
// One-time repair for a bug in an earlier version of models/User.js: the
// googleId field had `default: null`, which defeats a sparse unique
// index (sparse only skips fields that are genuinely ABSENT, not fields
// set to null). The result: the first non-Google account created ever
// claimed the single allowed "null", and every account after it hit a
// duplicate-key error on googleId_1 and was never created.
//
// The schema itself is already fixed (no more `default: null`), but
// that doesn't retroactively fix:
//   1. The index Mongo already built, which still enforces the old
//      (broken) behavior until rebuilt.
//   2. Any account that already has an explicit `googleId: null` sitting
//      in its document from before the fix.
//
// This script fixes both, then exits. Safe to run more than once —
// dropping an index that's already gone, or unsetting a field that's
// already unset, are both harmless no-ops.
//
// Run it once, in the Railway Console:
//   node scripts/fixGoogleIdIndex.js

require("dotenv").config();
const mongoose = require("mongoose");
const { connectDB } = require("../config/db");

async function main() {
  await connectDB();
  const db = mongoose.connection.db;
  const users = db.collection("users");

  try {
    await users.dropIndex("googleId_1");
    console.log("Dropped the old googleId_1 index.");
  } catch (err) {
    console.log("Nothing to drop (index was already gone):", err.message);
  }

  const result = await users.updateMany(
    { googleId: null },
    { $unset: { googleId: "" } }
  );
  console.log(`Removed the stray null from ${result.modifiedCount} account(s).`);

  await users.createIndex({ googleId: 1 }, { unique: true, sparse: true });
  console.log("Rebuilt googleId_1 as a proper sparse unique index.");

  console.log("\nDone. Now run: npm run seed:team");
  process.exit(0);
}

main().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
