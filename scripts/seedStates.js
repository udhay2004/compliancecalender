// scripts/seedStates.js
//
// Populates StateCache with generic, company-agnostic compliance items
// for every US state (+ DC) x entity type, so live company generation can
// hit the database instead of calling Claude every time.
//
// Runs in batches so you don't have to burn through 51 x N-entity-types
// worth of web-search calls in one sitting, and so a crash halfway
// through doesn't lose earlier progress (each state is saved as soon as
// it's researched).
//
// Usage:
//   node scripts/seedStates.js                 # next 15 un-cached (state, entityType) pairs
//   node scripts/seedStates.js --batch 15       # explicit batch size
//   node scripts/seedStates.js --entity "C-Corp"     # only this entity type
//   node scripts/seedStates.js --force          # re-research even if cache is fresh
//   node scripts/seedStates.js --states "Texas,Delaware,Wyoming"   # only these states (+ FEDERAL)
//   npm run seed:states -- --batch 20
//
// Run it repeatedly (e.g. once a day, or via a cron/CI job) until it
// reports "Nothing left to seed" — that's a full pass over all states.

require("dotenv").config();
const { connectDB } = require("../config/db");
const StateCache = require("../models/StateCache");
const { researchStateGeneric } = require("../lib/claude");

// Full state names, exactly matching the <select id="state"> options in
// public/app.html — the cache key must match what the form actually sends.
const ALL_STATES = [
  "Delaware","California","Texas","Florida","Wyoming","New York","Illinois","Washington","Massachusetts",
  "Alabama","Alaska","Arizona","Arkansas","Colorado","Connecticut","Georgia","Hawaii","Idaho","Indiana","Iowa","Kansas",
  "Kentucky","Louisiana","Maine","Maryland","Michigan","Minnesota","Mississippi","Missouri","Montana","Nebraska","Nevada",
  "New Hampshire","New Jersey","New Mexico","North Carolina","North Dakota","Ohio","Oklahoma","Oregon","Pennsylvania",
  "Rhode Island","South Carolina","South Dakota","Tennessee","Utah","Vermont","Virginia","West Virginia","Wisconsin",
  "District of Columbia",
];

// The entity types the intake form offers. Keep in sync with public/app.html.
const DEFAULT_ENTITY_TYPES = ["Corporation", "LLC", "Partnership", "Disregarded Entity"];

function parseArgs() {
  const args = process.argv.slice(2);
  const get = (flag, fallback) => {
    const i = args.indexOf(flag);
    return i !== -1 && args[i + 1] ? args[i + 1] : fallback;
  };
  const statesArg = get("--states", null);
  return {
    // When targeting a specific state list, default the batch size to
    // "cover everything requested" instead of the usual 15, since the
    // whole point of --states is "do exactly this list in one run."
    batchSize: parseInt(get("--batch", statesArg ? "9999" : "15"), 10),
    entityFilter: get("--entity", null),
    force: args.includes("--force"),
    statesArg,
  };
}

async function main() {
  const { batchSize, entityFilter, force, statesArg } = parseArgs();
  await connectDB();

  const entityTypes = entityFilter ? [entityFilter] : DEFAULT_ENTITY_TYPES;

  let jurisdictions = ["FEDERAL", ...ALL_STATES];
  if (statesArg) {
    const requested = statesArg.split(",").map((s) => s.trim()).filter(Boolean);
    const validNames = new Set(ALL_STATES.map((s) => s.toLowerCase()));
    const matched = [];
    const unknown = [];
    for (const name of requested) {
      const hit = ALL_STATES.find((s) => s.toLowerCase() === name.toLowerCase());
      if (hit) matched.push(hit);
      else unknown.push(name);
    }
    if (unknown.length) {
      console.log(`⚠️  Ignoring unrecognized state name(s): ${unknown.join(", ")}`);
      console.log(`   (Must exactly match the app's state list — check spelling.)`);
    }
    if (!matched.length) {
      console.log("No valid states matched --states. Nothing to do.");
      process.exit(1);
    }
    // Always include FEDERAL — every state pair needs it to form a
    // complete cache hit (generateCompanyCalendar checks both).
    jurisdictions = ["FEDERAL", ...matched];
  }

  // Build the full worklist of (jurisdiction, entityType) pairs, in a
  // stable order, so repeated runs naturally continue where the last one
  // left off (FEDERAL first, then states alphabetically, per entity type).
  const worklist = [];
  for (const entityType of entityTypes) {
    for (const jurisdiction of jurisdictions) {
      worklist.push({ state: jurisdiction, entityType });
    }
  }

  const toSeed = [];
  for (const pair of worklist) {
    if (toSeed.length >= batchSize) break;
    const normState = StateCache.normalizeState(pair.state);
    const existing = await StateCache.findOne({ state: normState, entityType: pair.entityType });
    if (!force && StateCache.isFresh(existing)) continue; // already cached and fresh, skip
    toSeed.push(pair);
  }

  if (!toSeed.length) {
    console.log("Nothing left to seed — every (state, entityType) pair is already cached and fresh.");
    console.log(`Total pairs tracked: ${worklist.length}. Re-run with --force to refresh anyway.`);
    process.exit(0);
  }

  console.log(`Seeding ${toSeed.length} (jurisdiction, entityType) pairs this run:`);
  toSeed.forEach((p) => console.log(`  - ${p.state} / ${p.entityType}`));
  console.log("");

  let ok = 0;
  let failed = 0;
  for (const [i, pair] of toSeed.entries()) {
    process.stdout.write(`[${i + 1}/${toSeed.length}] ${pair.state} / ${pair.entityType} ... `);
    try {
      const items = await researchStateGeneric(pair.state, pair.entityType);
      const normState = StateCache.normalizeState(pair.state);
      await StateCache.findOneAndUpdate(
        { state: normState, entityType: pair.entityType },
        { state: normState, entityType: pair.entityType, items, generatedAt: new Date() },
        { upsert: true }
      );
      console.log(`done (${items.length} items)`);
      ok++;
    } catch (err) {
      console.log(`FAILED: ${err.message}`);
      failed++;
    }
  }

  // Scope the "how much is done" count to just this run's jurisdiction
  // list when --states was used, so it doesn't get compared against the
  // full 51-state universe and look misleadingly incomplete.
  const totalCached = await StateCache.countDocuments({
    state: { $in: jurisdictions.map((j) => StateCache.normalizeState(j)) },
    entityType: { $in: entityTypes },
  });
  console.log(`\nBatch complete: ${ok} succeeded, ${failed} failed.`);
  console.log(`Total cached (state/entityType) pairs so far: ${totalCached} / ${worklist.length}.`);
  if (totalCached < worklist.length) {
    console.log("Run this script again to continue seeding the next batch.");
  }
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error("Seed script crashed:", err);
  process.exit(1);
});
