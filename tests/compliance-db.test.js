// tests/compliance-db.test.js — the compliance database (data/compliance)
// and how calendars are built from it (lib/complianceDb.js).
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const db = require("../lib/complianceDb");
const D = require("../lib/deadlines");
const { FORMS, checkProfile } = require("../lib/countries");

const CATEGORIES = ["Mandatory Annual", "Conditional", "Transfer Pricing", "Foreign Reporting (ODI/FEMA)", "Event-Based"];
const FROM = new Date(Date.UTC(2026, 8, 29)); // 29 Sep 2026

function allItems() {
  const out = [];
  for (const file of fs.readdirSync(db.DATA_DIR).filter((f) => f.endsWith(".json"))) {
    const data = JSON.parse(fs.readFileSync(path.join(db.DATA_DIR, file), "utf8"));
    const push = (items, where) => (items || []).forEach((it) => out.push({ file, where, it }));
    push(data.items, "items");
    for (const [r, region] of Object.entries(data.regions || {})) {
      for (const [k, v] of Object.entries(region)) if (Array.isArray(v)) push(v, `${r}.${k}`);
    }
    for (const [z, zone] of Object.entries(data.freeZones || {})) push(zone.items, `freeZone ${z}`);
  }
  return out;
}

function build(profile) {
  const r = db.buildFromDatabase(profile);
  assert.ok(r.covered, `expected the database to cover ${JSON.stringify(profile)}: ${r.reason}`);
  return r.items;
}
const names = (items) => items.map((i) => i.compliance_name);
const has = (items, re) => items.some((i) => re.test(i.compliance_name));
function due(items, re, profile) {
  const it = items.find((i) => re.test(i.compliance_name));
  assert.ok(it, `no item matching ${re}`);
  const next = D.nextOccurrence(D.scheduleFor(it), profile, FROM, { businessDays: false });
  return next ? next.date.toISOString().slice(0, 10) : null;
}

test("every item in the database is well-formed, with a schedule the date engine understands", () => {
  const ids = new Set();
  const items = allItems();
  assert.ok(items.length > 1000, `only ${items.length} items`);
  for (const { file, where, it } of items) {
    const at = `${file} ${where} ${it.id}`;
    assert.ok(it.id && !ids.has(it.id), `${at}: missing or duplicate id`);
    ids.add(it.id);
    assert.ok(CATEGORIES.includes(it.category), `${at}: bad category ${it.category}`);
    for (const k of ["name", "rule", "authority"]) assert.ok(it[k] && String(it[k]).trim(), `${at}: missing ${k}`);
    assert.ok(["high", "medium", "low"].includes(it.confidence), `${at}: bad confidence`);
    if (it.schedule !== null) assert.ok(D.validSchedule(it.schedule), `${at}: invalid schedule ${JSON.stringify(it.schedule)}`);
    if (it.source) assert.match(it.source, /^https?:\/\//, `${at}: source must be a web link`);
  }
});

test("every answer the forms offer is covered by the database", () => {
  let checked = 0;
  const pick = (f, p) => (f.options || f.optionsFrom.map[p[f.optionsFrom.field]] || []);
  function walk(country, fields, i, profile) {
    if (i === fields.length) {
      const c = checkProfile(profile);
      assert.ok(c.ok, `${JSON.stringify(profile)}: ${c.error}`);
      const r = db.buildFromDatabase({ ...c.profile, incorpDate: "2021-07-15", fyEnd: "Dec" });
      assert.ok(r.covered, `${JSON.stringify(c.profile)}: ${r.reason}`);
      assert.ok(r.items.length >= 3, `${JSON.stringify(c.profile)}: only ${r.items.length} items`);
      checked++;
      return;
    }
    const f = fields[i];
    const shown = !f.showIf || Object.entries(f.showIf).every(([k, v]) => v.includes(profile[k]));
    if (!shown || f.type === "multiselect") return walk(country, fields, i + 1, profile);
    const values = f.type === "yesno" ? ["Yes", "No"] : pick(f, profile);
    // All states/provinces/emirates/zones, but only the first two of the other long lists.
    const list = ["state", "freeZone", "entityType", "taxStatus", "zoneType", "incorporation"].includes(f.key) ? values : values.slice(0, 2);
    for (const v of list) walk(country, fields, i + 1, { ...profile, [f.key]: v });
  }
  for (const [country, fields] of Object.entries(FORMS)) walk(country, fields, 0, { country });
  assert.ok(checked > 1500, `only ${checked} combinations checked`);
});

test("US: Delaware C corporation — federal, state and payroll filings with the right dates", () => {
  const p = { country: "United States", state: "Delaware", entityType: "Corporation", taxStatus: "C-Corp", fyEnd: "Dec", incorpDate: "2021-07-15", hasEmployees: "Yes", employeeStates: ["California"] };
  const items = build(p);
  assert.strictEqual(due(items, /Form 1120\)/, p), "2027-04-15");
  assert.strictEqual(due(items, /Delaware.*Annual Report|Annual Report \+ Franchise Tax/, p), "2027-03-01");
  assert.strictEqual(due(items, /Delaware Corporate Income Tax/, p), "2027-04-15");
  assert.ok(has(items, /California Unemployment Insurance/), "payroll filings for the employee state");
  assert.ok(has(items, /Form 941/));
  assert.ok(!has(items, /Form 1065|1120-S/), "no filings for other tax statuses");
  assert.ok(!has(items, /5472/), "no foreign-ownership filings unless there's a foreign parent");
});

test("US: no payroll without employees; S corporation and foreign-owned single-member LLC filings", () => {
  const noStaff = build({ country: "United States", state: "Texas", entityType: "Corporation", taxStatus: "S-Corp", hasEmployees: "No", fyEnd: "Dec" });
  assert.ok(!has(noStaff, /Form 941|Unemployment Insurance|W-2/));
  assert.ok(has(noStaff, /1120-S/));
  const llc = build({ country: "United States", state: "Wyoming", entityType: "LLC", taxStatus: "Disregarded Entity", hasEmployees: "No", hasForeignParent: true, fyEnd: "Dec" });
  assert.ok(has(llc, /Form 5472 with Pro Forma/));
  assert.ok(!has(llc, /Schedule C/), "a foreign owner doesn't file a US Schedule C");
});

test("US: biennial and anniversary-month filings land in the right years", () => {
  const p = { country: "United States", state: "New York", entityType: "LLC", taxStatus: "Partnership", hasEmployees: "No", fyEnd: "Dec", incorpDate: "2021-07-15" };
  assert.strictEqual(due(build(p), /Biennial Statement/, p), "2027-07-31", "every 2 years from formation, end of the anniversary month");
  const ia = { country: "United States", state: "Iowa", entityType: "Corporation", taxStatus: "C-Corp", hasEmployees: "No", fyEnd: "Dec" };
  assert.strictEqual(due(build(ia), /Iowa Biennial/, ia), "2028-04-01", "Iowa corporations file in even years");
});

test("Canada: federal vs provincial incorporation and extra-provincial registrations", () => {
  const fed = { country: "Canada", state: "Ontario", entityType: "Corporation", incorporation: "Federal", operatingRegions: ["Alberta"], salesTax: "Quarterly", hasEmployees: "No", fyEnd: "Dec", incorpDate: "2021-07-15" };
  const f = build(fed);
  assert.strictEqual(due(f, /^T2 Corporation/, fed), "2027-06-30");
  assert.strictEqual(due(f, /CBCA Annual Return/, fed), "2027-09-13", "60 days after the 15 July anniversary");
  assert.ok(!has(f, /^Ontario Annual Return/), "federal corporations don't file an Ontario annual return");
  assert.ok(has(f, /Alberta Extra-Provincial Annual Return/));
  assert.ok(has(f, /Alberta Corporate Income Tax Return \(AT1\)/));
  assert.strictEqual(due(f, /GST\/HST Return \(quarterly/, fed), "2026-10-31");

  const bc = build({ country: "Canada", state: "British Columbia", entityType: "Corporation", incorporation: "Provincial", operatingRegions: ["Alberta"], salesTax: "Annual", hasEmployees: "No" });
  assert.ok(has(bc, /BC Annual Report/));
  assert.ok(!has(bc, /CBCA/));
  assert.ok(!has(bc, /Alberta Extra-Provincial Annual Return/), "New West Partnership: BC corporations don't file Alberta annual returns");

  const qc = build({ country: "Canada", state: "Quebec", entityType: "Corporation", incorporation: "Provincial", salesTax: "Monthly", hasEmployees: "Yes" });
  assert.ok(has(qc, /Quebec Annual Updating Declaration/));
  assert.ok(has(qc, /CO-17/));
  assert.ok(has(qc, /RL-1/));
});

test("UK: accounts, Corporation Tax and quarterly VAT dates", () => {
  const p = { country: "United Kingdom", entityType: "Private Limited Company (Ltd)", vat: "Quarterly", hasEmployees: "Yes", fyEnd: "Dec", incorpDate: "2021-07-15" };
  const items = build(p);
  assert.strictEqual(due(items, /Annual Accounts to Companies House$/, p), "2026-09-30");
  assert.strictEqual(due(items, /Corporation Tax Payment/, p), "2026-10-01");
  assert.strictEqual(due(items, /CT600/, p), "2026-12-31");
  assert.strictEqual(due(items, /Confirmation Statement/, p), "2027-07-29");
  assert.strictEqual(due(items, /VAT Return and Payment \(quarterly\)/, p), "2026-11-07");
  assert.ok(has(items, /P60/));
  const trader = build({ country: "United Kingdom", entityType: "Sole Trader", vat: "Not registered", hasEmployees: "No" });
  assert.ok(has(trader, /Self Assessment Tax Return/));
  assert.ok(has(trader, /VAT Registration/));
  assert.ok(!has(trader, /CT600|Confirmation Statement/));
});

test("Singapore: ACRA and IRAS dates", () => {
  const p = { country: "Singapore", entityType: "Private Limited Company (Pte Ltd)", gst: "Quarterly", hasEmployees: "Yes", fyEnd: "Dec" };
  const items = build(p);
  assert.strictEqual(due(items, /Annual Return to ACRA/, p), "2027-07-31");
  assert.strictEqual(due(items, /Estimated Chargeable Income/, p), "2027-03-31");
  assert.strictEqual(due(items, /Form C-S/, p), "2026-11-30");
  assert.ok(has(items, /CPF Contributions/));
});

test("UAE: emirate, mainland or free zone, and the free zone decide the filings", () => {
  const dmcc = build({ country: "United Arab Emirates", state: "Dubai", zoneType: "Free Zone", freeZone: "DMCC", entityType: "Free Zone Company (FZE/FZCO)", vat: "Quarterly", hasEmployees: "No" });
  assert.ok(has(dmcc, /DMCC Licence Renewal/));
  assert.ok(has(dmcc, /Audited Financial Statements to DMCC/));
  assert.ok(has(dmcc, /Qualifying Free Zone Person/));
  assert.ok(!has(dmcc, /Trade Licence Renewal \(Dubai/), "no mainland licence for a free zone company");
  assert.ok(!has(dmcc, /ADGM/));

  const adgm = { country: "United Arab Emirates", state: "Abu Dhabi", zoneType: "Free Zone", freeZone: "ADGM", entityType: "Free Zone Company (FZE/FZCO)", vat: "Not registered", hasEmployees: "No", fyEnd: "Dec" };
  assert.strictEqual(due(build(adgm), /ADGM Annual Accounts/, adgm), "2026-09-30");

  const mainland = build({ country: "United Arab Emirates", state: "Dubai", zoneType: "Mainland", entityType: "Mainland LLC", vat: "Quarterly", hasEmployees: "Yes", employeeBand: "50 or more" });
  assert.ok(has(mainland, /Trade Licence Renewal \(Dubai Department of Economy and Tourism/));
  assert.ok(has(mainland, /Emiratisation Targets \(50\+/));
  assert.ok(has(mainland, /Wage Protection System/));
  const small = build({ country: "United Arab Emirates", state: "Sharjah", zoneType: "Mainland", entityType: "Mainland LLC", vat: "Quarterly", hasEmployees: "Yes", employeeBand: "Fewer than 20" });
  assert.ok(!has(small, /Emiratisation/));
  assert.ok(!names(small).some((n) => /Economic Substance/i.test(n)), "Economic Substance Regulations were repealed");
});

test("ODI filings are added for an Indian investor, and the FLA return only for an Indian company", () => {
  const base = { country: "Singapore", entityType: "Private Limited Company (Pte Ltd)", gst: "Not registered", hasEmployees: "No", hasForeignParent: true, odiDone: "Yes" };
  const company = build({ ...base, odiInvestorType: "Indian Company" });
  assert.ok(has(company, /Annual Performance Report/) && has(company, /FLA/));
  const person = build({ ...base, odiInvestorType: "Resident Individual" });
  assert.ok(has(person, /Annual Performance Report/) && !has(person, /FLA/));
  assert.ok(!has(build({ ...base, odiDone: "No" }), /Annual Performance Report/));
});

test("calendars come only from the database; anything outside it is refused with the reason", async () => {
  const { generateCompanyCalendar, NotCoveredError } = require("../lib/generateCalendar");
  const r = await generateCompanyCalendar({ country: "United Kingdom", entityType: "Private Limited Company (Ltd)", vat: "Quarterly", hasEmployees: "No", fyEnd: "Dec" });
  assert.strictEqual(r.sourceMode, "database");
  assert.ok(r.items.length > 5);
  await assert.rejects(generateCompanyCalendar({ country: "Brazil", entityType: "Ltda" }), (e) => e instanceof NotCoveredError && e.status === 400 && /Brazil/.test(e.message));
  await assert.rejects(generateCompanyCalendar({ country: "United States", state: "Texas", entityType: "Corporation", taxStatus: "Not sure" }), /tax status/);
  assert.ok(!fs.existsSync(path.join(__dirname, "..", "lib", "claude.js")), "no AI research module");
});

test("US general partnerships and Canadian territories are covered", () => {
  const gp = build({ country: "United States", state: "California", entityType: "Partnership", taxStatus: "Partnership", hasEmployees: "No", fyEnd: "Dec" });
  assert.ok(has(gp, /Form 1065/) && has(gp, /California Partnership/));
  assert.ok(!has(gp, /Statement of Information|Form 1120/), "no corporation or LLC filings");
  const p = { country: "Canada", state: "Nunavut", entityType: "Corporation", incorporation: "Provincial", salesTax: "Not registered", hasEmployees: "Yes", fyEnd: "Dec", incorpDate: "2021-07-15" };
  const nu = build(p);
  assert.strictEqual(due(nu, /Nunavut Annual Return/, p), "2027-08-31");
  assert.ok(has(nu, /Nunavut Payroll Tax Remittances/) && has(nu, /WSCC/));
  const yk = build({ country: "Canada", state: "Ontario", entityType: "Corporation", incorporation: "Federal", operatingRegions: ["Yukon"], salesTax: "Annual", hasEmployees: "No" });
  assert.ok(has(yk, /Yukon Extra-Territorial Annual Return/));
});

test("older calendars without the new answers still build (with sensible defaults)", () => {
  const items = build({ country: "Canada", state: "Ontario", entityType: "Federal Corporation (CBCA)" });
  assert.ok(has(items, /CBCA Annual Return/), "old Canadian entity type maps to a federal corporation");
  assert.ok(has(items, /T4 Slips/), "payroll kept when the old profile never answered the question");
});

// ---------------------------------------------------------------------
// The countries added in October 2026
// ---------------------------------------------------------------------
function staffSetsDate(items, re, profile) {
  const it = items.find((i) => re.test(i.compliance_name));
  assert.ok(it, `no item matching ${re}`);
  return D.nextOccurrence(D.scheduleFor(it), profile, FROM, { businessDays: false }) === null;
}

test("Australia: the state decides payroll tax, and a 30 June year end the tax return date", () => {
  const p = { country: "Australia", state: "New South Wales", entityType: "Proprietary Company (Pty Ltd)", gst: "Quarterly", hasEmployees: "Yes", employeeStates: ["Northern Territory"], fyEnd: "Jun", incorpDate: "2021-07-15" };
  const items = build(p);
  assert.strictEqual(due(items, /^Company Tax Return$/, p), "2027-02-28");
  assert.strictEqual(due(items, /Business Activity Statement \(quarterly/, p), "2026-10-28");
  assert.strictEqual(due(items, /ASIC Annual Review/, p), "2027-09-15");
  assert.strictEqual(due(items, /New South Wales Payroll Tax Return/, p), "2026-10-07");
  assert.strictEqual(due(items, /Northern Territory Payroll Tax Return/, p), "2026-10-21");
  assert.ok(!has(items, /Victoria|substituted accounting period/));
  const dec = { ...p, fyEnd: "Dec", hasEmployees: "No", employeeStates: [] };
  assert.strictEqual(due(build(dec), /substituted accounting period/, dec), "2027-07-15");
  assert.ok(!has(build(dec), /Payroll Tax|Superannuation/));
  const trader = build({ country: "Australia", state: "Victoria", entityType: "Sole Trader", gst: "Not registered", hasEmployees: "No" });
  assert.ok(has(trader, /GST Registration/) && has(trader, /Income Tax Return \(individual/) && !has(trader, /ASIC Annual Review/));
});

test("Spain: the Basque Country and Navarre file with their own tax offices; the Canary Islands use IGIC", () => {
  const base = { country: "Spain", entityType: "Sociedad Limitada (S.L.)", vat: "Quarterly", hasEmployees: "Yes", fyEnd: "Dec" };
  const madrid = build({ ...base, state: "Madrid" });
  assert.strictEqual(due(madrid, /Modelo 200/, { ...base, state: "Madrid" }), "2027-07-25");
  assert.strictEqual(due(madrid, /Modelo 303, quarterly/, base), "2026-10-20");
  assert.ok(has(madrid, /Modelo 111/) && !has(madrid, /IGIC|Basque|Navarre/));
  const basque = build({ ...base, state: "Basque Country" });
  assert.ok(has(basque, /Corporate Income Tax Return — Basque Country/) && has(basque, /TicketBAI/) && has(basque, /Payroll Withholding Tax Returns — Basque/));
  assert.ok(!has(basque, /Modelo (200|202|303|390|347|111|190)/), "no state tax agency returns");
  assert.ok(has(basque, /Annual Accounts Deposited/) && has(basque, /Social Security Contributions/), "company law and social security are national");
  const canary = build({ ...base, state: "Canary Islands" });
  assert.ok(has(canary, /IGIC Return \(Modelo 420/) && has(canary, /Modelo 200/) && !has(canary, /Modelo 303|Modelo 390/));
  assert.ok(has(build({ ...base, state: "Ceuta" }), /IPSI/));
});

test("Switzerland: each canton has its own tax return, with the date left for staff", () => {
  const p = { country: "Switzerland", state: "Zurich", entityType: "AG / SA (company limited by shares)", vat: "Quarterly", hasEmployees: "Yes", employeeStates: ["Geneva"], fyEnd: "Dec" };
  const items = build(p);
  assert.ok(staffSetsDate(items, /Corporate Tax Return — Canton of Zurich/, p), "no automatic date for a cantonal return");
  assert.ok(has(items, /Quellensteuer\) — Zurich/) && has(items, /Quellensteuer\) — Geneva/) && !has(items, /Canton of Geneva|Bern/));
  assert.strictEqual(due(items, /VAT Return \(quarterly\)/, p), "2026-11-30");
  assert.strictEqual(due(items, /Annual Salary Declaration/, p), "2027-01-30");
  const sole = { country: "Switzerland", state: "Vaud", entityType: "Sole Proprietorship (Einzelunternehmen)", vat: "Not registered", hasEmployees: "No" };
  assert.ok(staffSetsDate(build(sole), /Personal Tax Return — Canton of Vaud/, sole));
  assert.strictEqual(checkProfile({ ...p, state: "Bavaria" }).field, "state");
});

test("Japan, Italy, Portugal and Austria: regional filings follow the region chosen", () => {
  const jp = { country: "Japan", state: "Tokyo", entityType: "Kabushiki Kaisha (KK)", vat: "Annual", hasEmployees: "Yes", fyEnd: "Mar" };
  const tokyo = build(jp);
  assert.strictEqual(due(tokyo, /^Corporation Tax and Local Corporation Tax Return/, jp), "2027-05-31");
  assert.strictEqual(due(tokyo, /Tokyo Corporate Inhabitant Tax/, jp), "2027-05-31");
  assert.ok(has(tokyo, /Depreciable Assets Tax Return \(Tokyo\)/) && !has(tokyo, /Osaka|Individual Enterprise Tax/));
  assert.ok(has(build({ ...jp, state: "Osaka", entityType: "Sole Proprietorship (kojin jigyo)" }), /Osaka Individual Enterprise Tax/));

  const it = { country: "Italy", state: "Lombardy", entityType: "S.r.l.", vat: "Monthly", hasEmployees: "No", fyEnd: "Dec" };
  assert.ok(has(build(it), /IRAP — Regional Tax on Productive Activities \(Lombardy\)/));
  assert.strictEqual(due(build(it), /Redditi SC/, it), "2026-10-31");
  assert.ok(!has(build({ ...it, entityType: "Sole Proprietorship (ditta individuale)" }), /IRAP —|IRES/), "sole proprietors pay neither IRAP nor IRES");

  const pt = { country: "Portugal", entityType: "Lda (sociedade por quotas)", vat: "Quarterly", hasEmployees: "No", fyEnd: "Dec" };
  assert.ok(has(build({ ...pt, state: "Madeira" }), /Madeira Regional Rate/));
  assert.ok(!has(build({ ...pt, state: "Mainland Portugal" }), /Regional Rate/));
  assert.strictEqual(due(build({ ...pt, state: "Azores" }), /Modelo 22\) and Payment/, pt), "2027-05-31");

  const at = { country: "Austria", entityType: "GmbH", vat: "Monthly", hasEmployees: "Yes" };
  assert.ok(has(build({ ...at, state: "Vienna" }), /U-Bahn-Steuer/));
  const tyrol = build({ ...at, state: "Tyrol" });
  assert.ok(has(tyrol, /Tyrol Tourism Contribution/) && !has(tyrol, /U-Bahn-Steuer/) && has(tyrol, /Kommunalsteuer/));
});

test("Hong Kong, Sweden and Belgium: the financial year end decides the tax return date", () => {
  const hk = { country: "Hong Kong", entityType: "Private Company Limited by Shares", hasEmployees: "Yes", fyEnd: "Dec", incorpDate: "2021-07-15" };
  assert.strictEqual(due(build(hk), /Profits Tax Return/, hk), "2027-08-15");
  assert.strictEqual(due(build({ ...hk, fyEnd: "Mar" }), /Profits Tax Return/, { ...hk, fyEnd: "Mar" }), "2026-11-15");
  assert.strictEqual(names(build(hk)).filter((n) => /Profits Tax Return/.test(n)).length, 1);
  assert.strictEqual(due(build(hk), /Form NAR1/, hk), "2027-08-26", "42 days after the 15 July anniversary");
  assert.ok(has(build(hk), /MPF Contributions/));

  const se = { country: "Sweden", entityType: "Aktiebolag (AB)", vat: "Quarterly", hasEmployees: "No", fyEnd: "Jun" };
  assert.strictEqual(due(build(se), /Inkomstdeklaration 2/, se), "2026-12-15");
  assert.strictEqual(due(build({ ...se, fyEnd: "Dec" }), /Inkomstdeklaration 2/, { ...se, fyEnd: "Dec" }), "2027-07-01");

  const be = { country: "Belgium", entityType: "BV / SRL (private limited company)", vat: "Quarterly", hasEmployees: "No", fyEnd: "Dec" };
  assert.strictEqual(due(build(be), /Biztax/, be), "2026-09-30");
  assert.strictEqual(due(build({ ...be, fyEnd: "Mar" }), /Biztax/, { ...be, fyEnd: "Mar" }), "2026-10-31");
});

test("France, Ireland and the other national countries: answers decide the filings", () => {
  const fr = { country: "France", entityType: "SAS", vat: "Monthly", hasEmployees: "Yes", employeeBand: "50 or more", fyEnd: "Dec" };
  const big = build(fr);
  assert.strictEqual(due(big, /Monthly Payroll Declaration \(DSN\)/, fr), "2026-10-05");
  assert.ok(has(big, /Gender Equality Index/) && has(big, /CSE/));
  const small = build({ ...fr, employeeBand: "Fewer than 11" });
  assert.strictEqual(due(small, /Monthly Payroll Declaration \(DSN\)/, fr), "2026-10-15");
  assert.ok(!has(small, /Gender Equality Index|CSE/));
  assert.strictEqual(checkProfile({ ...fr, employeeBand: undefined }).field, "employeeBand");

  const ie = { country: "Ireland", entityType: "Private Company Limited by Shares (LTD)", vat: "Bi-monthly", hasEmployees: "No", fyEnd: "Dec", incorpDate: "2021-07-15" };
  assert.strictEqual(due(build(ie), /CT1/, ie), "2027-09-23");
  assert.strictEqual(due(build(ie), /Form B1/, ie), "2027-03-12", "56 days after the 15 January return date");
  assert.strictEqual(due(build(ie), /Preliminary Corporation Tax/, ie), "2026-11-23");

  const checks = [
    [{ country: "Netherlands", entityType: "BV (private limited company)", vat: "Quarterly", hasEmployees: "No", fyEnd: "Dec" }, /vennootschapsbelasting/, "2027-05-31"],
    [{ country: "Norway", entityType: "AS (private limited company)", vat: "Bi-monthly", hasEmployees: "No", fyEnd: "Dec" }, /Shareholder Register Statement/, "2027-01-31"],
    [{ country: "Denmark", entityType: "ApS (private limited company)", vat: "Half-yearly", hasEmployees: "No", fyEnd: "Dec" }, /Annual Report Filed/, "2027-06-30"],
    [{ country: "South Korea", entityType: "Yuhan Hoesa (limited company)", hasEmployees: "No", fyEnd: "Dec" }, /^Corporate Income Tax Return/, "2027-03-31"],
  ];
  for (const [p, re, date] of checks) assert.strictEqual(due(build(p), re, p), date, p.country);
  assert.ok(has(build({ country: "South Korea", entityType: "Sole Proprietorship", hasEmployees: "No" }), /VAT Returns \(half-yearly\)/));
});

test("a region is required where the country has regional filings", () => {
  for (const country of ["Australia", "Austria", "Italy", "Japan", "Portugal", "Spain", "Switzerland"]) {
    const entityType = FORMS[country].find((f) => f.key === "entityType").options[0];
    assert.strictEqual(checkProfile({ country, entityType }).field, "state", country);
    assert.strictEqual(db.buildFromDatabase({ country, entityType }).covered, false, country);
  }
});
