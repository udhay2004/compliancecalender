// scripts/createUser.js
//
// There is no public signup route (routes/admin.routes.js creates every
// account after this point) — so the very first account, the business
// owner's super_admin login, has to be created from the command line.
// After that first one exists, they can create everyone else (including
// more super_admins/admins) through the admin API/UI instead of this
// script.
//
// Usage:
//   node scripts/createUser.js --email owner@complyglobally.com --password "..." --role super_admin --name "Boss Name"
//
// For a staff account instead: --role staff (no clientOrgId needed).
// For a client account: --role client --clientOrgId <ObjectId>
//   (create the ClientOrg first via the admin API, then use its _id here.)

require("dotenv").config();
const { connectDB } = require("../config/db");
const User = require("../models/User");

function parseArgs() {
  const args = {};
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i].replace(/^--/, "");
    args[key] = argv[i + 1];
  }
  return args;
}

async function main() {
  const { email, password, role, name, clientOrgId } = parseArgs();

  if (!email || !password || !role) {
    console.error(
      "Usage: node scripts/createUser.js --email you@example.com --password 'yourpassword' --role super_admin --name 'Your Name'"
    );
    process.exit(1);
  }
  if (!User.ROLES.includes(role)) {
    console.error(`--role must be one of: ${User.ROLES.join(", ")}`);
    process.exit(1);
  }
  if (role === "client" && !clientOrgId) {
    console.error("--clientOrgId is required when --role is 'client'.");
    process.exit(1);
  }

  await connectDB();

  const existing = await User.findOne({ email: email.trim().toLowerCase() });
  if (existing) {
    console.error(`A user with email ${email} already exists (role: ${existing.role}).`);
    process.exit(1);
  }

  const user = new User({
    email: email.trim().toLowerCase(),
    name: name || "",
    role,
    clientOrgId: role === "client" ? clientOrgId : null,
  });
  await user.setPassword(password);
  await user.save();

  console.log(`Created ${role} account: ${user.email}`);
  process.exit(0);
}

main().catch((err) => {
  console.error("Failed to create user:", err.message);
  process.exit(1);
});
