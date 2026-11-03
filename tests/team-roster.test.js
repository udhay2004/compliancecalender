// tests/team-roster.test.js
//
// Start-up creates missing internal team accounts (lib/teamRoster.js) but
// must never change an existing one or stop the app from starting.

const test = require("node:test");
const assert = require("node:assert");
const { TEAM, ensureTeamAccounts } = require("../lib/teamRoster");

const quiet = { log() {}, error() {} };

function fakeUserModel(existingEmails = [], { failOn } = {}) {
  const rows = new Map(existingEmails.map((e) => [e, { email: e, role: "admin", active: false }]));
  return {
    rows,
    async exists({ email }) { return rows.has(email); },
    async create(doc) {
      if (doc.email === failOn) throw new Error("boom");
      rows.set(doc.email, { ...doc });
      return doc;
    },
  };
}

test("roster: the new finance and operations staff are listed with the right team", () => {
  const by = Object.fromEntries(TEAM.map((p) => [p.email, p]));
  assert.deepStrictEqual([by["partners@theconnectventures.com"].role, by["partners@theconnectventures.com"].department], ["staff", "finance"]);
  assert.strictEqual(by["tanu.lata@theconnectventures.com"].department, "finance");
  assert.strictEqual(by["operations@theconnectventures.com"].department, "operations");
  assert.strictEqual(by["operations.cv@theconnectventures.com"].department, "operations");
  assert.strictEqual(by["anil.gupta@theconnectventures.com"].role, "super_admin");
});

test("roster: start-up creates only missing accounts, with no password", async () => {
  const User = fakeUserModel(["tech@theconnectventures.com"]);
  const created = await ensureTeamAccounts(User, quiet);
  assert.strictEqual(created.length, TEAM.length - 1);
  assert.ok(!created.includes("tech@theconnectventures.com"));
  const tanu = User.rows.get("tanu.lata@theconnectventures.com");
  assert.strictEqual(tanu.mustSetPassword, true);
  assert.strictEqual(tanu.passwordHash, undefined);
  // The existing account is left exactly as it was (not "repaired").
  assert.deepStrictEqual(User.rows.get("tech@theconnectventures.com"), { email: "tech@theconnectventures.com", role: "admin", active: false });
  assert.deepStrictEqual(await ensureTeamAccounts(User, quiet), [], "second start creates nothing");
});

test("roster: one failing account doesn't stop the others or the app", async () => {
  const User = fakeUserModel([], { failOn: "partners@theconnectventures.com" });
  const created = await ensureTeamAccounts(User, quiet);
  assert.ok(!created.includes("partners@theconnectventures.com"));
  assert.ok(created.includes("tanu.lata@theconnectventures.com"));
});
