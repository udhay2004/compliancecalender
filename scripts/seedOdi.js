// scripts/seedOdi.js
//
// Populates OdiCache with generic RBI/FEMA ODI compliance items for each
// investor type, so a company generation with odiDone = "Yes" can hit the
// database instead of calling Claude with web search every time. There
// are only 3 investor types (exactly matching the <select id="odiInvestorType">
// options in public/app.html), so this always runs in a single pass — no
// batching needed the way seedStates.js needs it for 51+ states.
//
// Usage:
//   node scripts/seedOdi.js               # any investor type missing/stale
//   node scripts/seedOdi.js --force       # re-research even if cache is fresh
//   npm run seed:odi

require("dotenv").config();
const { connectDB } = require("../config/db");
const OdiCache = require("../models/OdiCache");
const { researchOdiGeneric } = require("../lib/claude");

// Exactly matching the <select id="odiInvestorType"> options in public/app.html.
const INVESTOR_TYPES = ["Indian Company", "Resident Individual", "Other Foreign Entity"];

function parseArgs() {
  const args = process.argv.slice(2);
  return { force: args.includes("--force") };
}

async function main() {
  const { force } = parseArgs();
  await connectDB();

  const toSeed = [];
  for (const investorType of INVESTOR_TYPES) {
    const existing = await OdiCache.findOne({ investorType });
    if (!force && OdiCache.isFresh(existing)) continue;
    toSeed.push(investorType);
  }

  if (!toSeed.length) {
    console.log("Nothing left to seed — every investor type is already cached and fresh.");
    console.log("Re-run with --force to refresh anyway.");
    process.exit(0);
  }

  console.log(`Seeding ${toSeed.length} investor type(s): ${toSeed.join(", ")}\n`);

  let ok = 0;
  let failed = 0;
  for (const [i, investorType] of toSeed.entries()) {
    process.stdout.write(`[${i + 1}/${toSeed.length}] ${investorType} ... `);
    try {
      const items = await researchOdiGeneric(investorType);
      await OdiCache.findOneAndUpdate(
        { investorType },
        { investorType, items, generatedAt: new Date() },
        { upsert: true }
      );
      console.log(`done (${items.length} items)`);
      ok++;
    } catch (err) {
      console.log(`FAILED: ${err.message}`);
      failed++;
    }
  }

  const totalCached = await OdiCache.countDocuments();
  console.log(`\nBatch complete: ${ok} succeeded, ${failed} failed.`);
  console.log(`Total cached investor types so far: ${totalCached} / ${INVESTOR_TYPES.length}.`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error("Seed script crashed:", err);
  process.exit(1);
});
