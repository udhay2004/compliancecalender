// lib/emailCheck.js
//
// Is this an address we can actually email? The calendar and the portal
// sign-in go to the address typed on the public form, so a mistyped one
// means the visitor gets nothing and we keep a dead lead.
//
// Checked in order:
//   1. the address is well formed;
//   2. the domain isn't a well-known typo ("gmial.com") — the error offers
//      the corrected address;
//   3. the domain isn't a throwaway inbox service;
//   4. the domain accepts mail (it has MX records, or at least an address
//      record). If DNS can't be reached in time the address is allowed:
//      a slow resolver must never block a real visitor.
//
// This cannot tell whether the mailbox itself exists; only sending to it
// can.

const dns = require("dns").promises;

const MAX_LENGTH = 254;
const DNS_TIMEOUT_MS = 3000;

// Mistyped domain -> the one meant.
const TYPOS = {
  "gmial.com": "gmail.com", "gmai.com": "gmail.com", "gamil.com": "gmail.com", "gnail.com": "gmail.com", "gmail.co": "gmail.com",
  "gmail.con": "gmail.com", "gmail.cm": "gmail.com", "gmail.om": "gmail.com", "gmaill.com": "gmail.com", "gmal.com": "gmail.com", "gmail.comm": "gmail.com",
  "googlemail.con": "googlemail.com",
  "yaho.com": "yahoo.com", "yahooo.com": "yahoo.com", "yhoo.com": "yahoo.com", "yahoo.con": "yahoo.com", "yahoo.co": "yahoo.com", "yaho.co.in": "yahoo.co.in",
  "hotmial.com": "hotmail.com", "hotmai.com": "hotmail.com", "hotmal.com": "hotmail.com", "hotmail.con": "hotmail.com", "hotmail.co": "hotmail.com", "hotnail.com": "hotmail.com",
  "outlok.com": "outlook.com", "outloo.com": "outlook.com", "outlook.con": "outlook.com", "outlook.co": "outlook.com", "oulook.com": "outlook.com",
  "iclod.com": "icloud.com", "icloud.con": "icloud.com", "icoud.com": "icloud.com",
  "rediffmial.com": "rediffmail.com", "redifmail.com": "rediffmail.com", "rediffmail.con": "rediffmail.com",
  "protonmial.com": "protonmail.com", "protonmail.con": "protonmail.com",
};

// Inboxes made to be thrown away.
const DISPOSABLE = new Set([
  "mailinator.com", "guerrillamail.com", "guerrillamail.net", "sharklasers.com", "10minutemail.com", "10minutemail.net",
  "tempmail.com", "temp-mail.org", "tempmail.net", "throwawaymail.com", "yopmail.com", "yopmail.net", "trashmail.com",
  "getnada.com", "maildrop.cc", "dispostable.com", "fakeinbox.com", "mailnesia.com", "mintemail.com", "emailondeck.com",
  "moakt.com", "tempinbox.com", "discard.email", "mohmal.com", "spamgourmet.com", "mytemp.email", "tempail.com",
]);

const LOCAL = /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*$/;
const LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

/** Well formed? Returns { local, domain } (domain lower-cased) or null. */
function parse(raw) {
  const text = typeof raw === "string" ? raw.trim() : "";
  if (!text || text.length > MAX_LENGTH) return null;
  const at = text.lastIndexOf("@");
  if (at < 1 || at !== text.indexOf("@")) return null;
  const local = text.slice(0, at);
  const domain = text.slice(at + 1).toLowerCase();
  if (local.length > 64 || !LOCAL.test(local)) return null;
  const labels = domain.split(".");
  if (labels.length < 2 || !labels.every((l) => LABEL.test(l))) return null;
  if (!/^[a-z]{2,24}$/.test(labels[labels.length - 1])) return null; // a real top-level domain is letters
  return { local, domain };
}

/** Does the domain accept mail? true / false, or null when DNS didn't answer. */
async function acceptsMail(domain, resolver = dns) {
  let timer;
  const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve(null), DNS_TIMEOUT_MS); });
  const lookup = (async () => {
    try {
      const mx = await resolver.resolveMx(domain);
      // A single empty exchange ("null MX") says: this domain takes no mail.
      return mx.some((r) => r.exchange && r.exchange !== ".");
    } catch (err) {
      if (!["ENOTFOUND", "ENODATA"].includes(err.code)) return null; // resolver trouble: don't judge
      if (err.code === "ENOTFOUND") return false; // the domain doesn't exist
    }
    // No MX records: mail falls back to the domain's address record.
    try { return (await resolver.resolve4(domain)).length > 0; } catch (err) {
      if (!["ENOTFOUND", "ENODATA"].includes(err.code)) return null;
    }
    try { return (await resolver.resolve6(domain)).length > 0; } catch (err) {
      return ["ENOTFOUND", "ENODATA"].includes(err.code) ? false : null;
    }
  })();
  const result = await Promise.race([lookup, timeout]);
  clearTimeout(timer);
  return result;
}

/**
 * @returns {{ ok: true, email: string } | { ok: false, error: string, suggestion?: string }}
 * opts.dns  false to skip the DNS lookup; or a resolver to use (tests).
 */
async function checkEmail(raw, { dns: dnsOption } = {}) {
  const parsed = parse(raw);
  if (!parsed) return { ok: false, error: "That doesn't look like an email address. Check it and try again." };
  const { local, domain } = parsed;
  const email = `${local}@${domain}`.toLowerCase();

  if (TYPOS[domain]) {
    const suggestion = `${local}@${TYPOS[domain]}`.toLowerCase();
    return { ok: false, error: `Did you mean ${suggestion}? "${domain}" looks like a typo.`, suggestion };
  }
  if (DISPOSABLE.has(domain)) {
    return { ok: false, error: "Please use your regular email address; temporary inboxes can't receive your calendar and sign-in details." };
  }
  // The test suite never touches the network unless it passes a resolver.
  const skip = dnsOption === false || process.env.EMAIL_DNS_CHECK === "off" || (process.env.NODE_ENV === "test" && !dnsOption);
  if (!skip && (await acceptsMail(domain, dnsOption || dns)) === false) {
    return { ok: false, error: `We can't deliver email to "${domain}". Check the address for a typo.` };
  }
  return { ok: true, email };
}

module.exports = { checkEmail, parse, acceptsMail, TYPOS, DISPOSABLE };
