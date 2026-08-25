// scripts/loadPresearchedStates.js
//
// Loads MANUALLY pre-researched compliance data (data/presearched-states.json)
// straight into StateCache — no Claude API calls, no web search, no cost.
//
// This is the companion to seedStates.js: seedStates.js does LIVE research
// via the Anthropic API for whatever isn't cached yet; this script instead
// bulk-loads a JSON file you (or an assistant) already researched offline,
// using the exact same schema and the exact same upsert pattern so both
// paths write compatible documents into the same collection.
//
// Usage:
//   node scripts/loadPresearchedStates.js                        # loads data/presearched-states.json
//   node scripts/loadPresearchedStates.js --file path/to/other.json
//   node scripts/loadPresearchedStates.js --force                # overwrite even if a fresher cache entry exists
//   node scripts/loadPresearchedStates.js --dry-run               # validate + report only, writes nothing

require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { connectDB } = require("../config/db");
const StateCache = require("../models/StateCache");

const VALID_CATEGORIES = new Set(["Mandatory Annual", "Conditional", "Transfer Pricing", "Event-Based"]);
const VALID_CONFIDENCE = new Set(["high", "medium", "low"]);
const VALID_ENTITY_TYPES = new Set([
  "Corporation", "LLC", "Partnership", "Disregarded Entity",
  // Germany — see data/presearched-germany.json
  "GmbH", "UG (haftungsbeschränkt)", "AG",
  // UAE — see data/presearched-uae.json
  "Mainland LLC", "Free Zone Company (FZE/FZCO)", "Branch of Foreign Company", "Civil Company",
  // Singapore — see data/presearched-singapore.json. Was previously missing
  // from this list entirely, which meant loadPresearchedStates.js would have
  // rejected the Singapore file outright; fixed alongside the Canada rollout.
  "Private Limited Company (Pte Ltd)", "Limited Liability Partnership (LLP)", "Sole Proprietorship", "Branch Office of Foreign Company",
  // Canada — see data/presearched-canada.json. "Sole Proprietorship" is
  // shared with Singapore above, not re-declared here.
  "Federal Corporation (CBCA)", "General Partnership",
  // United Kingdom — see data/presearched-uk.json. This was missing
  // entirely until now, which meant presearched-uk.json could never be
  // loaded through this script despite having real researched data.
  "Private Limited Company (Ltd)", "Public Limited Company (PLC)", "Sole Trader",
]);

function parseArgs() {
  const args = process.argv.slice(2);
  const get = (flag, fallback) => {
    const i = args.indexOf(flag);
    return i !== -1 && args[i + 1] ? args[i + 1] : fallback;
  };
  return {
    file: get("--file", path.join(__dirname, "..", "data", "presearched-states.json")),
    force: args.includes("--force"),
    dryRun: args.includes("--dry-run"),
  };
}

function validateRecord(rec, index) {
  const errors = [];
  const label = `record #${index} (${rec.state || "?"}/${rec.entityType || "?"})`;

  if (!rec.state || typeof rec.state !== "string") errors.push(`${label}: missing/invalid "state"`);
  if (!VALID_ENTITY_TYPES.has(rec.entityType)) {
    errors.push(`${label}: entityType must be one of ${[...VALID_ENTITY_TYPES].join(", ")}, got "${rec.entityType}"`);
  }
  if (!Array.isArray(rec.items)) {
    errors.push(`${label}: "items" must be an array`);
    return errors;
  }
  rec.items.forEach((item, i) => {
    const itemLabel = `${label} item #${i}`;
    if (!item.category || !VALID_CATEGORIES.has(item.category)) {
      errors.push(`${itemLabel}: invalid category "${item.category}"`);
    }
    if (!item.compliance_name) errors.push(`${itemLabel}: missing compliance_name`);
    if (!item.due_date_rule) errors.push(`${itemLabel}: missing due_date_rule`);
    if (item.confidence && !VALID_CONFIDENCE.has(item.confidence)) {
      errors.push(`${itemLabel}: invalid confidence "${item.confidence}"`);
    }
  });
  return errors;
}

async function main() {
  const { file, force, dryRun } = parseArgs();

  if (!fs.existsSync(file)) {
    console.error(`File not found: ${file}`);
    process.exit(1);
  }

  const raw = fs.readFileSync(file, "utf8");
  let records;
  try {
    records = JSON.parse(raw);
  } catch (err) {
    console.error(`Failed to parse ${file} as JSON: ${err.message}`);
    process.exit(1);
  }
  if (!Array.isArray(records)) {
    console.error(`Expected top-level array in ${file}, got ${typeof records}`);
    process.exit(1);
  }

  console.log(`Loaded ${records.length} records from ${file}`);

  // Validate everything up front, fail loudly before writing anything.
  let allErrors = [];
  records.forEach((rec, i) => {
    allErrors = allErrors.concat(validateRecord(rec, i));
  });
  if (allErrors.length) {
    console.error(`\n${allErrors.length} validation error(s) — fix these before loading:\n`);
    allErrors.forEach((e) => console.error("  - " + e));
    process.exit(1);
  }
  console.log("All records passed schema validation.\n");

  // Check for duplicate (state, entityType) pairs within the file itself.
  const seen = new Set();
  const dupes = [];
  for (const rec of records) {
    const key = `${StateCache.normalizeState(rec.state)}::${rec.entityType}`;
    if (seen.has(key)) dupes.push(key);
    seen.add(key);
  }
  if (dupes.length) {
    console.error(`Duplicate (state, entityType) pairs found in the file itself:`);
    dupes.forEach((d) => console.error("  - " + d));
    console.error("Fix the source file before loading — last one would silently win otherwise.");
    process.exit(1);
  }

  if (dryRun) {
    console.log("--dry-run set: validation passed, nothing written to the database.");
    process.exit(0);
  }

  await connectDB();

  let created = 0;
  let updated = 0;
  let skipped = 0;

  for (const rec of records) {
    const normState = StateCache.normalizeState(rec.state);
    const existing = await StateCache.findOne({ state: normState, entityType: rec.entityType });

    if (existing && !force && StateCache.isFresh(existing)) {
      skipped++;
      continue;
    }

    const result = await StateCache.findOneAndUpdate(
      { state: normState, entityType: rec.entityType },
      {
        state: normState,
        entityType: rec.entityType,
        items: rec.items,
        generatedAt: new Date(),
        batchNumber: null, // manually loaded, not part of a seedStates.js run
      },
      { upsert: true, new: true, rawResult: true }
    );

    if (result.lastErrorObject && result.lastErrorObject.updatedExisting) {
      updated++;
    } else {
      created++;
    }
    console.log(`  ${existing ? "updated" : "created"}: ${normState} / ${rec.entityType} (${rec.items.length} items)`);
  }

  console.log(`\nDone. Created: ${created}, Updated: ${updated}, Skipped (already fresh, use --force to override): ${skipped}`);
  const total = await StateCache.countDocuments();
  console.log(`Total documents now in StateCache: ${total}`);
  process.exit(0);
}

main().catch((err) => {
  console.error("Load script crashed:", err);
  process.exit(1);
});
