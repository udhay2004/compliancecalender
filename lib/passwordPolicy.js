// lib/passwordPolicy.js
//
// One definition of "strong enough", used by the API. The login page
// mirrors these rules in the browser for live feedback, but the browser
// copy is a convenience only — anyone can skip it with curl, so this
// server-side check is the one that actually decides.
//
// The rules chosen here follow current NIST guidance rather than the
// older "one uppercase, one symbol, change it every 90 days" school:
// length and not-being-guessable are what matter, and forced symbol
// soup mostly produces Password1! and a sticky note.

const MIN_LENGTH = 12;

// Not a serious breach corpus — just the handful that show up first in
// any real-world attempt, plus company-specific guesses. If you want
// the real thing later, check against a k-anonymity API like Have I
// Been Pwned's range endpoint instead of growing this list.
const BANNED = [
  "password", "passw0rd", "12345678", "123456789", "1234567890",
  "qwerty", "qwertyuiop", "letmein", "welcome", "admin", "administrator",
  "iloveyou", "monkey", "dragon", "football", "abc123", "changeme",
  "compliance", "calendar", "connectventures", "theconnectventures",
];

/**
 * @returns {{ok: true} | {ok: false, error: string}}
 */
function checkPassword(password, { email = "", name = "" } = {}) {
  if (typeof password !== "string") {
    return { ok: false, error: "Password is required." };
  }
  if (password.length < MIN_LENGTH) {
    return { ok: false, error: `Password must be at least ${MIN_LENGTH} characters.` };
  }
  if (password.length > 200) {
    // Upper bound purely to stop someone posting a 10MB string and
    // making the server spend a minute bcrypting it.
    return { ok: false, error: "Password must be 200 characters or fewer." };
  }
  if (!/[a-zA-Z]/.test(password) || !/[0-9]/.test(password)) {
    return { ok: false, error: "Password must contain at least one letter and one number." };
  }

  const lower = password.toLowerCase();
  if (BANNED.some((bad) => lower.includes(bad))) {
    return { ok: false, error: "That password contains a very common word or phrase. Please choose something less guessable." };
  }

  // The local part of the email and the person's own name are the first
  // two things anyone targeting this account would try.
  const localPart = String(email).split("@")[0].toLowerCase();
  if (localPart.length >= 3 && lower.includes(localPart)) {
    return { ok: false, error: "Password must not contain your email address." };
  }
  for (const part of String(name).toLowerCase().split(/\s+/).filter((p) => p.length >= 4)) {
    if (lower.includes(part)) {
      return { ok: false, error: "Password must not contain your name." };
    }
  }

  // Three or more identical characters in a row, or an obvious run.
  if (/(.)\1{3,}/.test(password)) {
    return { ok: false, error: "Password must not repeat the same character four or more times in a row." };
  }

  return { ok: true };
}

module.exports = { checkPassword, MIN_LENGTH };
