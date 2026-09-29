// tests/countries.test.js — which countries and answers the forms accept.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { checkProfile, SUPPORTED_COUNTRIES, FORMS, formDefinition } = require("../lib/countries");

const page = (f) => fs.readFileSync(path.join(__dirname, "..", "public", f), "utf8");

test("only the six covered countries are accepted", () => {
  assert.deepStrictEqual([...SUPPORTED_COUNTRIES].sort(), ["Canada", "Germany", "Singapore", "United Arab Emirates", "United Kingdom", "United States"]);
  const r = checkProfile({ country: "Other", entityType: "Corporation", state: "x" });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.field, "country");
  assert.match(r.error, /don't prepare calendars for Other yet/);
  assert.strictEqual(checkProfile({ country: "France", entityType: "SAS" }).ok, false);
});

test("US needs a state, entity type and a tax status that fits the entity", () => {
  assert.strictEqual(checkProfile({ country: "United States", entityType: "LLC", taxStatus: "Partnership", hasEmployees: "No" }).field, "state");
  assert.strictEqual(checkProfile({ country: "United States", state: "Delaware", entityType: "Corporation", taxStatus: "Partnership", hasEmployees: "No" }).field, "taxStatus");
  const ok = checkProfile({ country: "United States", state: "Delaware", entityType: "Corporation", taxStatus: "C-Corp", hasEmployees: "Yes", employeeStates: ["Texas", "Delaware", "Atlantis"] });
  assert.strictEqual(ok.ok, true);
  assert.deepStrictEqual(ok.profile.employeeStates, ["Texas"], "unknown states and the home state are dropped");
  assert.strictEqual(checkProfile({ entityType: "Corporation", state: "Texas", taxStatus: "C-Corp", hasEmployees: "No" }).profile.country, "United States", "no country means US");
});

test("national countries keep the country as the region; Germany's region is optional", () => {
  const uk = checkProfile({ country: "United Kingdom", entityType: "Private Limited Company (Ltd)", vat: "Quarterly", hasEmployees: "No" });
  assert.strictEqual(uk.ok, true);
  assert.strictEqual(uk.profile.state, "United Kingdom");
  const de = checkProfile({ country: "Germany", entityType: "GmbH", vat: "Monthly", hasEmployees: "No", state: "" });
  assert.strictEqual(de.ok, true);
  assert.strictEqual(de.profile.state, "Germany");
  assert.strictEqual(checkProfile({ country: "Germany", entityType: "LLC", vat: "Monthly", hasEmployees: "No" }).field, "entityType");
});

test("UAE: the free zone must belong to the emirate, and the entity type to the zone", () => {
  const base = { country: "United Arab Emirates", vat: "Quarterly", hasEmployees: "No" };
  assert.strictEqual(checkProfile({ ...base, state: "Dubai", zoneType: "Free Zone", freeZone: "DMCC", entityType: "Free Zone Company (FZE/FZCO)" }).ok, true);
  assert.strictEqual(checkProfile({ ...base, state: "Abu Dhabi", zoneType: "Free Zone", freeZone: "DMCC", entityType: "Free Zone Company (FZE/FZCO)" }).field, "freeZone");
  assert.strictEqual(checkProfile({ ...base, state: "Dubai", zoneType: "Mainland", entityType: "Free Zone Company (FZE/FZCO)" }).field, "entityType");
  const mainland = checkProfile({ ...base, state: "Sharjah", zoneType: "Mainland", entityType: "Mainland LLC", freeZone: "SHAMS" });
  assert.strictEqual(mainland.ok, true);
  assert.strictEqual(mainland.profile.freeZone, undefined, "a free zone answer is dropped for mainland companies");
  assert.strictEqual(checkProfile({ ...base, state: "Dubai", zoneType: "Mainland", entityType: "Mainland LLC", hasEmployees: "Yes" }).field, "employeeBand");
});

test("Canada: incorporation is asked for corporations only; older 'Federal Corporation (CBCA)' profiles still work", () => {
  const base = { country: "Canada", state: "Ontario", salesTax: "Annual", hasEmployees: "No" };
  assert.strictEqual(checkProfile({ ...base, entityType: "Corporation" }).field, "incorporation");
  assert.strictEqual(checkProfile({ ...base, entityType: "Sole Proprietorship", incorporation: "Federal" }).profile.incorporation, undefined);
  const old = checkProfile({ ...base, entityType: "Federal Corporation (CBCA)" });
  assert.strictEqual(old.ok, true);
  assert.strictEqual(old.profile.entityType, "Corporation");
  assert.strictEqual(old.profile.incorporation, "Federal");
});

test("regenerating an older calendar: missing answers are allowed, wrong ones are not", () => {
  const old = { country: "United States", state: "Delaware", entityType: "Corporation" };
  assert.strictEqual(checkProfile(old).ok, false);
  assert.strictEqual(checkProfile(old, { requireAll: false }).ok, true);
  assert.strictEqual(checkProfile({ ...old, taxStatus: "Partnership" }, { requireAll: false }).field, "taxStatus");
});

test("every form renders the questions from the one definition (no hard-coded country lists)", () => {
  const def = formDefinition();
  assert.deepStrictEqual(def.countries, SUPPORTED_COUNTRIES);
  assert.deepStrictEqual(Object.keys(def.fields), SUPPORTED_COUNTRIES);
  for (const f of ["index.html", "app.html", "portal.html"]) {
    const html = page(f);
    assert.ok(html.includes('src="/js/company-form.js"'), `${f} loads the shared form`);
    assert.ok(!/const COUNTRIES = \[/.test(html), `${f} doesn't hard-code the country list`);
  }
  for (const [country, fields] of Object.entries(FORMS)) {
    assert.ok(fields.some((f) => f.key === "entityType"), `${country} asks for the entity type`);
    assert.ok(fields.some((f) => f.key === "hasEmployees"), `${country} asks about payroll`);
  }
});
