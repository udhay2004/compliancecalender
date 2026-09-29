// lib/generateCalendar.js
//
// Builds a company's compliance calendar from the compliance database
// (data/compliance, lib/complianceDb.js). There is no AI research: every
// answer the forms accept (lib/countries.js) is covered by the database,
// which tests/compliance-db.test.js checks. A profile outside it (only
// possible for calendars saved before the current questions existed) is
// refused with a message saying which answer to update.

const { buildFromDatabase } = require("./complianceDb");

class NotCoveredError extends Error {
  constructor(reason) {
    super(`We can't build this calendar yet: ${reason}. Please update the company's details and try again.`);
    this.name = "NotCoveredError";
    this.status = 400;
  }
}

async function generateCompanyCalendar(profile) {
  const result = buildFromDatabase(profile);
  if (!result.covered) throw new NotCoveredError(result.reason);
  return { items: result.items, sourceMode: "database" };
}

module.exports = { generateCompanyCalendar, NotCoveredError };
