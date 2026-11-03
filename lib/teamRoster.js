// lib/teamRoster.js
//
// The internal team accounts, in one place. Used two ways:
//
//   * server.js calls ensureTeamAccounts() on every start-up, so a person
//     added to TEAM below gets an account just by merging and deploying,
//     with no shell command to run against the live database.
//   * scripts/seedTeam.js (npm run seed:team) uses the same list to also
//     REPAIR existing accounts (role, department, reactivation).
//
// Start-up only ever CREATES missing accounts. It never edits an existing
// one, so a role change or deactivation made in the admin UI is not undone
// by the next deploy, and nobody's password or session is touched.
//
// New accounts get no password at all (mustSetPassword: true): the only
// way in is a code emailed to that address, after which the person picks
// their own password. See models/User.js.

const TEAM = [
  { email: "tech@theconnectventures.com", name: "Tech Team", role: "staff", department: "tech" },
  { email: "finance@theconnectventures.com", name: "Finance Team", role: "staff", department: "finance" },
  { email: "partners@theconnectventures.com", name: "Partners", role: "staff", department: "finance" },
  { email: "tanu.lata@theconnectventures.com", name: "Tanu Lata", role: "staff", department: "finance" },
  { email: "operations@theconnectventures.com", name: "Operations Team", role: "staff", department: "operations" },
  { email: "operations.cv@theconnectventures.com", name: "Operations CV", role: "staff", department: "operations" },
  { email: "anil.gupta@theconnectventures.com", name: "Anil Gupta", role: "super_admin", department: "" },
];

const label = (p) => `${p.role}${p.department ? " / " + p.department : ""}`;

// Creates any TEAM account that doesn't exist yet. Returns the emails it
// created. A failure on one account is logged and skipped, never thrown:
// a roster problem must not stop the app from starting.
async function ensureTeamAccounts(User, log = console) {
  const created = [];
  for (const person of TEAM) {
    const email = person.email.toLowerCase();
    try {
      if (await User.exists({ email })) continue;
      await User.create({
        email,
        name: person.name,
        role: person.role,
        department: person.department,
        mustSetPassword: true,
        active: true,
      });
      created.push(email);
      log.log(`[team] Created ${email} (${label(person)}); they sign in with an emailed code.`);
    } catch (err) {
      // Another instance starting at the same moment may have just
      // created it — that's fine.
      if (err && err.code === 11000) continue;
      log.error(`[team] Could not create ${email}: ${err.message}`);
    }
  }
  return created;
}

module.exports = { TEAM, ensureTeamAccounts, label };
