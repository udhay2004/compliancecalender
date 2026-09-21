// scripts/seedTeam.js
//
// Creates (or repairs) the three real internal accounts. Run it once
// after deploying, and again any time you want to be sure the roster is
// what it should be — it's idempotent, so running it twice is harmless.
//
//   node scripts/seedTeam.js
//
// Deliberately, this script sets NO passwords. Each account is created
// with mustSetPassword: true and no passwordHash at all, which means:
//
//   * there is no default or temporary password for anyone to guess,
//     and none to leak in a chat message, a ticket, or this file;
//   * the only way into the account is a code sent to the mailbox that
//     owns the address, so whoever controls tech@ is by definition the
//     only person who can claim it;
//   * the password the person then picks is the first one the system
//     ever sees.
//
// That is the same "invite, don't issue" pattern every serious SaaS
// uses, and it's why there's no --password flag here.
//
// To add someone later, add a row to TEAM below and re-run, or use the
// admin UI. To take someone off, deactivate them in the admin UI rather
// than deleting the row — deleting loses the audit trail.

require("dotenv").config();
const { connectDB } = require("../config/db");
const User = require("../models/User");

const TEAM = [
  {
    email: "tech@theconnectventures.com",
    name: "Tech Team",
    role: "staff",
    department: "tech",
  },
  {
    email: "finance@theconnectventures.com",
    name: "Finance Team",
    role: "staff",
    department: "finance",
  },
  {
    email: "anil.gupta@theconnectventures.com",
    name: "Anil Gupta",
    role: "super_admin",
    department: "",
  },
];

async function main() {
  await connectDB();

  for (const person of TEAM) {
    const email = person.email.toLowerCase();
    const existing = await User.findOne({ email });

    if (!existing) {
      await User.create({
        email,
        name: person.name,
        role: person.role,
        department: person.department,
        mustSetPassword: true,
        active: true,
      });
      console.log(`created   ${email}  (${person.role}${person.department ? " / " + person.department : ""})`);
      continue;
    }

    // Already there. Correct the role/department/active flag if they've
    // drifted, but never touch an existing password — re-running this
    // script must not log anybody out.
    const changes = [];
    if (existing.role !== person.role) {
      existing.role = person.role;
      changes.push("role");
    }
    if ((existing.department || "") !== person.department) {
      existing.department = person.department;
      changes.push("department");
    }
    if (!existing.active) {
      existing.active = true;
      changes.push("reactivated");
    }
    if (!existing.name) {
      existing.name = person.name;
      changes.push("name");
    }

    if (changes.length) {
      await existing.save();
      console.log(`updated   ${email}  (${changes.join(", ")})`);
    } else {
      console.log(`unchanged ${email}  (${existing.mustSetPassword ? "awaiting first sign-in" : "password set"})`);
    }
  }

  console.log(
    "\nDone. Each person should now go to /login.html, pick their door " +
    "(Staff or Super admin), enter their address, and follow the emailed code."
  );
  process.exit(0);
}

main().catch((err) => {
  console.error("Seeding failed:", err);
  process.exit(1);
});
