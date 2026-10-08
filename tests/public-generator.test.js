// tests/public-generator.test.js
//
// The free calendar generator, driven the way the website drives it: the
// REAL public routes, the REAL questions per country (lib/countries.js) and
// the REAL compliance database (data/compliance), over real HTTP. Replaced
// with in-memory stand-ins (via the require cache, as in the other suites):
// the Calendar model, email, notifications, the session check and
// Cloudflare's "verify you are human" service.
//
// Covers what a visitor (or a bot) can do without an account:
//   - every country and every entity type the form offers builds a calendar
//   - the page (public/index.html) and the server agree on what is sent
//   - locked filings give nothing away
//   - the per-address limit and the human check actually stop abuse
//   - "Talk to an expert" can't be used to flood the team's inbox
//
//   node --test tests/

const test = require("node:test");
const assert = require("node:assert");
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

process.env.JWT_SECRET = "public-generator-test-secret";
process.env.NODE_ENV = "test";
process.env.ADMIN_EMAIL = "team@firm.example";
delete process.env.TURNSTILE_SITE_KEY;
delete process.env.TURNSTILE_SECRET_KEY;

const root = path.join(__dirname, "..");
const stub = (rel, exports) => {
  const file = require.resolve(path.join(root, rel));
  require.cache[file] = { id: file, filename: file, loaded: true, exports };
};

// ---------------------------------------------------------------------
// In-memory stand-ins
// ---------------------------------------------------------------------
let calendars = [];
let seq = 0;
const oid = () => (++seq).toString(16).padStart(24, "0");
const emails = [];
const then = (value) => ({ then: (res, rej) => Promise.resolve(value).then(res, rej) });

stub("models/Calendar.js", {
  create: async (doc) => { const d = { _id: oid(), ...doc }; calendars.push(d); return d; },
  findOne: (q) => {
    // What Mongoose does with an id that isn't one.
    if (!/^[a-f0-9]{24}$/i.test(String(q._id))) {
      const err = new Error(`Cast to ObjectId failed for value "${q._id}"`);
      err.name = "CastError";
      return { then: (res, rej) => Promise.reject(err).then(res, rej) };
    }
    return then(calendars.find((c) => String(c._id) === String(q._id) && (!q.source || c.source === q.source)) || null);
  },
});
stub("lib/mailer.js", { sendEmail: async (m) => { emails.push(m); return {}; } });
stub("lib/notify.js", { notifyStaff: () => {}, notifyClient: () => {} });
stub("middleware/auth.js", { loadUserFromRequest: async () => { throw new Error("no session"); } });

// Cloudflare Turnstile: the route calls fetch() for it and nothing else.
const realFetch = global.fetch;
let turnstile = { calls: [], answer: { success: true }, down: false };
global.fetch = async (url, opts) => {
  if (String(url).startsWith("https://challenges.cloudflare.com/")) {
    turnstile.calls.push(Object.fromEntries(opts.body));
    if (turnstile.down) throw new Error("ECONNRESET");
    return { json: async () => turnstile.answer };
  }
  return realFetch(url, opts);
};

const express = require("express");
const { errorHandler } = require("../lib/asyncErrors");
const publicRoutes = require("../routes/public.routes");
const { formDefinition, checkProfile } = require("../lib/countries");
const { generateCompanyCalendar } = require("../lib/generateCalendar");
const { _resetMemory } = require("../lib/rateLimitStore");

const app = express();
app.use(express.json());
app.use("/api/public", publicRoutes);
app.use(errorHandler);
const server = http.createServer(app);
let base;
test.before(async () => { await new Promise((r) => server.listen(0, r)); base = `http://127.0.0.1:${server.address().port}`; });
test.after(() => { server.close(); global.fetch = realFetch; });
test.beforeEach(() => {
  calendars = []; emails.length = 0;
  Object.values(publicRoutes.rateLimitStores).forEach((s) => s.resetAll());
  _resetMemory();
  turnstile = { calls: [], answer: { success: true }, down: false };
  delete process.env.TURNSTILE_SITE_KEY;
  delete process.env.TURNSTILE_SECRET_KEY;
});

const call = async (method, url, body) => {
  const res = await realFetch(base + url, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, body: await res.json().catch(() => ({})) };
};
const CONTACT = { name: "Lee Lead", email: "Lee@Example.com", phone: "+1 415 555 0100" };
const settle = () => new Promise((r) => setImmediate(r));

// ---------------------------------------------------------------------
// Answering the form the way public/js/company-form.js does: only the
// questions currently shown, one of the offered options for each.
// ---------------------------------------------------------------------
const DEF = formDefinition();
const shown = (f, a) => !f.showIf || Object.entries(f.showIf).every(([k, vals]) => vals.includes(a[k]));
const optionsOf = (f, a) => (f.optionsFrom ? f.optionsFrom.map[a[f.optionsFrom.field]] || [] : f.options || []);

/** Every complete set of answers for a country, taking `pick(field, options)` at each question. */
function answer(country, pick = (f, opts) => opts[0], fixed = {}) {
  const a = { country };
  for (const f of DEF.fields[country]) {
    if (!shown(f, a)) continue;
    if (fixed[f.key] !== undefined) { a[f.key] = fixed[f.key]; continue; }
    if (f.type === "yesno") a[f.key] = "No";
    else if (f.type === "multiselect") a[f.key] = [];
    else if (f.type === "select") { const opts = optionsOf(f, a); if (opts.length) a[f.key] = pick(f, opts); }
  }
  return a;
}
/** What public/index.html adds around the country's own answers. */
const asThePageSends = (answers, extra = {}) => ({
  companyName: "Acme Test Co", incorpDate: "2021-05-01", fyStart: "Jan", fyEnd: "Dec", hasForeignParent: false, ...answers, ...extra,
});

// =====================================================================
// Every country, every entity type
// =====================================================================
test("the form covers the six countries, each with an entity-type question", () => {
  assert.deepStrictEqual([...DEF.countries].sort(), ["Canada", "Germany", "Singapore", "United Arab Emirates", "United Kingdom", "United States"]);
  for (const country of DEF.countries) {
    assert.ok(DEF.fields[country].some((f) => f.key === "entityType" && f.required), `${country} asks for the entity type`);
  }
});

test("every entity type offered for every country builds a calendar from the database", async () => {
  let combos = 0;
  for (const country of DEF.countries) {
    const entityField = DEF.fields[country].find((f) => f.key === "entityType");
    // Entity types can depend on an earlier answer (UAE: mainland / free zone).
    const drivers = entityField.optionsFrom ? Object.keys(entityField.optionsFrom.map) : [null];
    for (const driver of drivers) {
      const fixedDriver = driver ? { [entityField.optionsFrom.field]: driver } : {};
      const types = driver ? entityField.optionsFrom.map[driver] : entityField.options;
      assert.ok(types.length, `${country}${driver ? " / " + driver : ""} offers entity types`);
      for (const entityType of types) {
        const answers = answer(country, undefined, { ...fixedDriver, entityType });
        const checked = checkProfile(asThePageSends(answers));
        assert.ok(checked.ok, `${country} / ${entityType}: the server accepts what the form offers (${checked.error})`);
        assert.strictEqual(checked.profile.entityType, entityType, "the value arrives unchanged, capitals included");
        const { items, sourceMode } = await generateCompanyCalendar(checked.profile);
        assert.ok(items.length >= 3, `${country} / ${entityType}: only ${items.length} filings matched`);
        assert.strictEqual(sourceMode, "database", `${country} / ${entityType} must come from the compliance database`);
        items.forEach((it) => assert.ok(it.compliance_name && it.category, `${country} / ${entityType}: every filing has a name and a category`));
        combos++;
      }
    }
  }
  assert.ok(combos >= 20, `checked ${combos} country / entity-type combinations`);
});

test("an entity type that differs only in capitals or spelling is refused, never silently mismatched", () => {
  for (const country of DEF.countries) {
    const good = answer(country);
    for (const bad of [good.entityType.toLowerCase(), good.entityType.toUpperCase(), good.entityType + " ", "LLC Company", ""]) {
      if (bad.trim() === good.entityType) continue; // spaces around a valid value are trimmed, which is fine
      const r = checkProfile(asThePageSends({ ...good, entityType: bad }));
      assert.strictEqual(r.ok, false, `${country}: "${bad}" must not be accepted`);
      assert.strictEqual(r.field, "entityType");
    }
  }
});

test("each country generates over HTTP with exactly what the page sends", async () => {
  for (const country of DEF.countries) {
    Object.values(publicRoutes.rateLimitStores).forEach((s) => s.resetAll());
    const r = await call("POST", "/api/public/generate", { profile: asThePageSends(answer(country)), contact: CONTACT });
    assert.strictEqual(r.status, 201, `${country}: ${JSON.stringify(r.body)}`);
    assert.match(String(r.body.calendarId), /^[a-f0-9]{24}$/);
    assert.strictEqual(r.body.items.length, r.body.itemCount);
    const saved = calendars.find((c) => c._id === r.body.calendarId);
    assert.strictEqual(saved.profile.country, country);
    assert.strictEqual(saved.source, "public");
    assert.strictEqual(saved.clientOrgId, null);
    assert.strictEqual(saved.status, "pending_review", "an anonymous calendar is never approved");
    assert.deepStrictEqual({ ...saved.leadContact, unlockedAt: undefined }, { name: "Lee Lead", email: "lee@example.com", phone: "+1 415 555 0100", unlockedAt: undefined });
  }
});

test("countries without a state question work with no state at all (the non-US path)", async () => {
  for (const country of ["United Kingdom", "Singapore", "Germany"]) {
    Object.values(publicRoutes.rateLimitStores).forEach((s) => s.resetAll());
    const answers = answer(country);
    delete answers.state;
    const r = await call("POST", "/api/public/generate", { profile: asThePageSends(answers), contact: CONTACT });
    assert.strictEqual(r.status, 201, `${country}: ${JSON.stringify(r.body)}`);
    assert.ok(r.body.itemCount > 0);
  }
});

// =====================================================================
// What the page sends (public/index.html) vs what the route reads
// =====================================================================
test("the landing page posts { profile, contact, captchaToken } with the fields the server reads", () => {
  const html = fs.readFileSync(path.join(root, "public", "index.html"), "utf8");
  assert.match(html, /fetch\("\/api\/public\/generate"/);
  assert.match(html, /JSON\.stringify\(\{ profile, contact, captchaToken: [^}]+\}\)/);
  const block = (name) => {
    const m = html.match(new RegExp(`function ${name}\\(\\) \\{([\\s\\S]*?)\\n  \\}`));
    assert.ok(m, `${name}() is in the page`);
    return m[1];
  };
  const contact = block("readContact");
  ["name", "email", "phone"].forEach((k) => assert.match(contact, new RegExp(`\\b${k}:`), `contact.${k}`));
  const profile = block("readProfile");
  ["companyName", "country", "incorpDate", "fyStart", "fyEnd", "hasForeignParent"].forEach((k) => assert.match(profile, new RegExp(`\\b${k}:`), `profile.${k}`));
  assert.match(profile, /companyForm\.values\(\)/, "the country's own answers come from the shared form");
  // Every element the script looks up by id exists in the markup (or is one
  // of the country questions, which public/js/company-form.js creates).
  const markupIds = new Set([...html.matchAll(/\bid="([^"${}]+)"/g)].map((m) => m[1]));
  const wanted = new Set([...html.matchAll(/getElementById\('([A-Za-z][\w-]*)'\)|getElementById\("([A-Za-z][\w-]*)"\)/g)].map((m) => m[1] || m[2]));
  const missing = [...wanted].filter((id) => !markupIds.has(id));
  assert.deepStrictEqual(missing, [], "ids used by the script but missing from the page");
});

test("the ODI questions only count when the foreign-ownership switch is on", async () => {
  const us = answer("United States");
  const names = async (extra) => {
    Object.values(publicRoutes.rateLimitStores).forEach((s) => s.resetAll());
    const r = await call("POST", "/api/public/generate", { profile: asThePageSends(us, extra), contact: CONTACT });
    assert.strictEqual(r.status, 201, JSON.stringify(r.body));
    return calendars.find((c) => c._id === r.body.calendarId).items.map((i) => i.compliance_name);
  };
  const isOdi = (n) => /Annual Performance Report|Foreign Liabilities and Assets|ODI Event Reporting|Evidence of Investment/.test(n);
  const off = await names({ hasForeignParent: false });
  // The hidden <select> still says "Yes"; older copies of the page sent it.
  const offButHiddenYes = await names({ hasForeignParent: false, odiDone: "Yes", odiInvestorType: "Indian Company" });
  const on = await names({ hasForeignParent: true, odiDone: "Yes", odiInvestorType: "Indian Company" });
  const onNoOdi = await names({ hasForeignParent: true, odiDone: "No" });
  assert.strictEqual(off.filter(isOdi).length, 0);
  assert.deepStrictEqual(offButHiddenYes, off, "switch off = no ODI filings, whatever the hidden field says");
  assert.ok(on.filter(isOdi).length >= 3, "switch on + ODI yes adds the RBI filings");
  assert.strictEqual(onNoOdi.filter(isOdi).length, 0);

  const html = fs.readFileSync(path.join(root, "public", "index.html"), "utf8");
  assert.match(html, /getElementById\('hasForeignParent'\)\.checked \? \{\s*odiDone:/, "the page only sends the ODI answers when the switch is on");
});

// =====================================================================
// What a signed-out visitor gets back
// =====================================================================
test("locked filings reveal only a category and a day count", async () => {
  const r = await call("POST", "/api/public/generate", { profile: asThePageSends(answer("United States")), contact: CONTACT });
  assert.strictEqual(r.status, 201);
  const open = r.body.items.filter((i) => !i.locked);
  const locked = r.body.items.filter((i) => i.locked);
  assert.strictEqual(open.length, 5);
  assert.ok(locked.length > 0, "there is something locked to test");
  open.forEach((i) => { assert.ok(i.compliance_name && i.price && i.price.label); });
  locked.forEach((i) => assert.deepStrictEqual(Object.keys(i).sort(), ["category", "daysUntil", "locked"]));
  const days = r.body.items.map((i) => i.daysUntil ?? Infinity);
  assert.deepStrictEqual(days, [...days].sort((a, b) => a - b), "nearest deadline first");
  assert.strictEqual(emails.length, 1, "the team is told about the lead once");
  assert.strictEqual(emails[0].to, "team@firm.example");
});

test("bad input is refused with the field to fix, and nothing is saved", async () => {
  const profile = asThePageSends(answer("United States"));
  const cases = [
    [{ profile, contact: { ...CONTACT, email: "not-an-email" } }, "email"],
    [{ profile, contact: { ...CONTACT, email: "" } }, "email"],
    [{ profile, contact: { ...CONTACT, phone: "call me" } }, "phone"],
    [{ profile, contact: { ...CONTACT, phone: "" } }, "phone"],
    [{ profile, contact: "lee@example.com" }, "email"],
    [{ profile, contact: { email: { $ne: null }, phone: ["+1 415 555 0100"] } }, "email"],
    [{ profile: { ...profile, country: "Atlantis" }, contact: CONTACT }, "country"],
    [{ profile: { ...profile, state: "Narnia" }, contact: CONTACT }, "state"],
    [{ profile: { ...profile, entityType: undefined }, contact: CONTACT }, "entityType"],
    [{ contact: CONTACT }, "profile"],
    [{}, "profile"],
  ];
  for (const [body, field] of cases) {
    Object.values(publicRoutes.rateLimitStores).forEach((s) => s.resetAll());
    const r = await call("POST", "/api/public/generate", body);
    assert.strictEqual(r.status, 400, JSON.stringify(body).slice(0, 120));
    assert.strictEqual(r.body.field, field);
  }
  assert.strictEqual(calendars.length, 0);
  assert.strictEqual(emails.length, 0);
});

test("names are stored as plain text of a sensible length", async () => {
  const r = await call("POST", "/api/public/generate", {
    profile: { ...asThePageSends(answer("United States")), companyName: "  Big\r\nSubject: injected " + "x".repeat(5000) },
    contact: { ...CONTACT, name: { toString: "x" } },
  });
  assert.strictEqual(r.status, 201, JSON.stringify(r.body));
  const saved = calendars[0];
  assert.strictEqual(saved.leadContact.name, "");
  assert.ok(saved.profile.companyName.length <= 200);
  assert.ok(!/[\r\n]/.test(saved.profile.companyName), "no line breaks (it goes into an email subject)");
  await settle();
  assert.ok(!/[\r\n]/.test(emails[0].subject));

  Object.values(publicRoutes.rateLimitStores).forEach((s) => s.resetAll());
  const odd = await call("POST", "/api/public/generate", { profile: { ...asThePageSends(answer("United States")), companyName: { a: 1 } }, contact: CONTACT });
  assert.strictEqual(odd.status, 201);
  assert.strictEqual(calendars[1].profile.companyName, "");
});

// =====================================================================
// Abuse: the per-address limit and the human check
// =====================================================================
test("one address gets five calendars an hour, then is refused", async () => {
  const body = { profile: asThePageSends(answer("United Kingdom")), contact: CONTACT };
  for (let i = 1; i <= 5; i++) assert.strictEqual((await call("POST", "/api/public/generate", body)).status, 201, `calendar ${i}`);
  const sixth = await call("POST", "/api/public/generate", body);
  assert.strictEqual(sixth.status, 429);
  assert.strictEqual(calendars.length, 5);
  // Requests the server refuses for other reasons count too, so a script
  // can't probe for free.
  Object.values(publicRoutes.rateLimitStores).forEach((s) => s.resetAll());
  for (let i = 0; i < 5; i++) await call("POST", "/api/public/generate", { profile: { country: "Atlantis" }, contact: CONTACT });
  assert.strictEqual((await call("POST", "/api/public/generate", body)).status, 429);
});

test("with the human check on, nothing is built without a token Cloudflare accepts", async () => {
  process.env.TURNSTILE_SITE_KEY = "site-key";
  process.env.TURNSTILE_SECRET_KEY = "secret-key";
  const cfg = await call("GET", "/api/public/config");
  assert.deepStrictEqual(cfg.body.humanCheck, { provider: "turnstile", siteKey: "site-key" });
  assert.ok(!JSON.stringify(cfg.body).includes("secret-key"), "the secret key never reaches the browser");

  const body = { profile: asThePageSends(answer("Singapore")), contact: CONTACT };
  let r = await call("POST", "/api/public/generate", body);
  assert.strictEqual(r.status, 400);
  assert.strictEqual(r.body.code, "HUMAN_CHECK");
  assert.strictEqual(turnstile.calls.length, 0, "no token: Cloudflare isn't even asked");

  r = await call("POST", "/api/public/generate", { ...body, captchaToken: { $gt: "" } });
  assert.strictEqual(r.body.code, "HUMAN_CHECK");
  r = await call("POST", "/api/public/generate", { ...body, captchaToken: "x".repeat(3000) });
  assert.strictEqual(r.body.code, "HUMAN_CHECK");

  turnstile.answer = { success: false, "error-codes": ["invalid-input-response"] };
  r = await call("POST", "/api/public/generate", { ...body, captchaToken: "forged-or-reused" });
  assert.strictEqual(r.status, 400);
  assert.strictEqual(r.body.code, "HUMAN_CHECK");
  assert.strictEqual(turnstile.calls[0].secret, "secret-key");
  assert.strictEqual(turnstile.calls[0].response, "forged-or-reused");
  assert.strictEqual(calendars.length, 0, "nothing saved, nobody emailed");
  assert.strictEqual(emails.length, 0);

  turnstile.answer = { success: true };
  r = await call("POST", "/api/public/generate", { ...body, captchaToken: "good-token" });
  assert.strictEqual(r.status, 201);
  assert.strictEqual(calendars.length, 1);
});

test("with the human check off, the config says so and the form works without a token", async () => {
  const cfg = await call("GET", "/api/public/config");
  assert.strictEqual(cfg.body.humanCheck, null);
  const r = await call("POST", "/api/public/generate", { profile: asThePageSends(answer("Germany")), contact: CONTACT });
  assert.strictEqual(r.status, 201);
  assert.strictEqual(turnstile.calls.length, 0);
});

// =====================================================================
// "Talk to an expert" (request-review)
// =====================================================================
test("request-review: one email to the team per calendar per day, however often it's pressed", async () => {
  const made = await call("POST", "/api/public/generate", { profile: asThePageSends(answer("United States")), contact: CONTACT });
  const id = made.body.calendarId;
  await settle();
  emails.length = 0;

  for (let i = 0; i < 6; i++) {
    // Each press from a "new address" (the per-address counter is wiped).
    publicRoutes.rateLimitStores.review.resetAll();
    const r = await call("POST", `/api/public/${id}/request-review`);
    assert.strictEqual(r.status, 200, "the visitor always gets the same answer");
    assert.deepStrictEqual(r.body, { ok: true });
  }
  await settle();
  assert.strictEqual(emails.length, 1, "the team inbox got one email, not six");
  assert.match(emails[0].subject, /requested full review/);
  assert.match(emails[0].text, /lee@example\.com/);

  // A different calendar still gets its own email.
  publicRoutes.rateLimitStores.generate.resetAll();
  const other = await call("POST", "/api/public/generate", { profile: asThePageSends(answer("Canada")), contact: { ...CONTACT, email: "second@example.com" } });
  await settle();
  emails.length = 0;
  await call("POST", `/api/public/${other.body.calendarId}/request-review`);
  await settle();
  assert.strictEqual(emails.length, 1);
});

test("request-review: unknown, malformed or non-public ids are 'not found', and one address is limited", async () => {
  calendars.push({ _id: oid(), source: "client", clientOrgId: "org1", leadContact: { email: "x@y.z" }, profile: {} });
  const privateId = calendars[0]._id;
  for (const id of ["ffffffffffffffffffffffff", privateId, "abc", "1; DROP TABLE", "..%2f..%2fetc", "%7B%22%24ne%22%3Anull%7D"]) {
    const r = await call("POST", `/api/public/${id}/request-review`);
    assert.strictEqual(r.status, 404, `id ${id}`);
  }
  assert.strictEqual(emails.length, 0);

  publicRoutes.rateLimitStores.review.resetAll();
  let limitedAt = null;
  for (let i = 1; i <= 12; i++) {
    const r = await call("POST", "/api/public/ffffffffffffffffffffffff/request-review");
    if (r.status === 429) { limitedAt = i; break; }
  }
  assert.strictEqual(limitedAt, 11, "ten tries an hour per address, so ids can't be guessed quickly");
});

test("a calendar id that isn't an id is 'not found' everywhere, not a server error", async () => {
  // Any route that hands a raw id to the database (what Mongoose then throws).
  const probe = express();
  probe.get("/api/calendars/:id", async (req) => { await require("../models/Calendar").findOne({ _id: req.params.id }); });
  probe.use(errorHandler);
  const s = http.createServer(probe);
  await new Promise((r) => s.listen(0, r));
  try {
    const res = await realFetch(`http://127.0.0.1:${s.address().port}/api/calendars/not-an-id`);
    assert.strictEqual(res.status, 404);
    assert.deepStrictEqual(await res.json(), { error: "Not found." });
  } finally {
    s.close();
  }
});
