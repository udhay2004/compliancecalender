// tests/countries.test.js — which countries the public tool accepts.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { checkProfile, SUPPORTED_COUNTRIES, ENTITY_TYPES } = require("../lib/countries");

test("only the six covered countries are accepted", () => {
  assert.deepStrictEqual(SUPPORTED_COUNTRIES.sort(), ["Canada", "Germany", "Singapore", "United Arab Emirates", "United Kingdom", "United States"]);
  const r = checkProfile({ country: "Other", entityType: "Corporation", state: "x" });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.field, "country");
  assert.match(r.error, /don't prepare calendars for Other yet/);
  assert.strictEqual(checkProfile({ country: "France", entityType: "SAS" }).ok, false);
});

test("US needs a state; other countries don't (region defaults to the country)", () => {
  assert.strictEqual(checkProfile({ country: "United States", entityType: "LLC" }).field, "state");
  const us = checkProfile({ country: "United States", entityType: "LLC", state: "Delaware" });
  assert.strictEqual(us.ok, true);
  assert.strictEqual(us.profile.state, "Delaware");
  const de = checkProfile({ country: "Germany", entityType: "GmbH", state: "" });
  assert.strictEqual(de.ok, true, "a German company without a region used to be refused");
  assert.strictEqual(de.profile.state, "Germany");
  assert.strictEqual(checkProfile({ entityType: "Corporation", state: "Texas" }).profile.country, "United States", "no country means US");
});

test("the entity type must belong to the chosen country", () => {
  const r = checkProfile({ country: "Germany", entityType: "LLC" });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.field, "entityType");
});

test("the website form offers exactly the same countries and entity types, and no 'Other'", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");
  const list = JSON.parse(/const COUNTRIES = (\[[^\]]*\])/.exec(html)[1]);
  assert.deepStrictEqual([...list].sort(), [...SUPPORTED_COUNTRIES].sort());
  assert.ok(!list.includes("Other"));
  for (const [country, types] of Object.entries(ENTITY_TYPES)) {
    types.forEach((t) => assert.ok(html.includes(JSON.stringify(t)), `${country}: "${t}" missing from the form`));
  }
});

test("every covered country has researched data whose entity types match", () => {
  const files = { "United Kingdom": "uk", Canada: "canada", Germany: "germany", Singapore: "singapore", "United Arab Emirates": "uae" };
  for (const [country, f] of Object.entries(files)) {
    const data = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "data", `presearched-${f}.json`), "utf8"));
    const inData = new Set(data.map((d) => d.entityType));
    ENTITY_TYPES[country].forEach((t) => assert.ok(inData.has(t), `${country}: "${t}" has no researched data`));
  }
});
