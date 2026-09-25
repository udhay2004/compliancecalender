// lib/totp.js
//
// Time-based one-time passwords (RFC 6238) — the 6-digit codes shown by
// Google Authenticator, Microsoft Authenticator, Authy, 1Password etc.
// Built on Node's crypto, no extra dependency. Verified against the RFC's
// published test vectors (tests/security.test.js).
//
// Secrets are stored ENCRYPTED (AES-256-GCM). The key comes from
// TOTP_ENCRYPTION_KEY, or is derived from JWT_SECRET if that isn't set.
// If whichever key is used ever changes, existing authenticator setups stop
// working and staff must set up two-factor again (an admin can reset them).

const crypto = require("crypto");

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const STEP_SECONDS = 30;
const DIGITS = 6;

function base32Encode(buf) {
  let bits = 0, value = 0, out = "";
  for (const byte of buf) {
    value = (value << 8) | byte; bits += 8;
    while (bits >= 5) { out += ALPHABET[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

function base32Decode(str) {
  const clean = String(str).toUpperCase().replace(/[^A-Z2-7]/g, "");
  let bits = 0, value = 0;
  const out = [];
  for (const ch of clean) {
    value = (value << 5) | ALPHABET.indexOf(ch); bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}

/** 160-bit random secret, base32 (what the authenticator app stores). */
function generateSecret() {
  return base32Encode(crypto.randomBytes(20));
}

function hotp(secretBuf, counter, digits = DIGITS, algo = "sha1") {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const h = crypto.createHmac(algo, secretBuf).update(msg).digest();
  const offset = h[h.length - 1] & 0x0f;
  const bin = ((h[offset] & 0x7f) << 24) | (h[offset + 1] << 16) | (h[offset + 2] << 8) | h[offset + 3];
  return String(bin % 10 ** digits).padStart(digits, "0");
}

function stepAt(ms = Date.now()) {
  return Math.floor(ms / 1000 / STEP_SECONDS);
}

/** The code for a given time (used by tests and the setup check). */
function totp(secretBase32, ms = Date.now(), digits = DIGITS) {
  return hotp(base32Decode(secretBase32), stepAt(ms), digits);
}

/**
 * Check a code, allowing one 30-second step either side for clock drift.
 * Returns the matching time step (to store, so the same code can't be
 * used twice), or null.
 */
function verifyTotp(secretBase32, code, { now = Date.now(), window = 1, lastUsedStep = -1 } = {}) {
  const c = String(code || "").replace(/\s+/g, "");
  if (!/^\d{6}$/.test(c)) return null;
  const secret = base32Decode(secretBase32);
  const current = stepAt(now);
  for (let d = -window; d <= window; d++) {
    const step = current + d;
    if (step <= lastUsedStep) continue; // replay of an already-used code
    const expected = hotp(secret, step);
    if (crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(c))) return step;
  }
  return null;
}

function otpauthUrl({ secret, account, issuer }) {
  const label = encodeURIComponent(`${issuer}:${account}`);
  return `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=${DIGITS}&period=${STEP_SECONDS}`;
}

// ---------------------------------------------------------------------
// Encryption of stored secrets
// ---------------------------------------------------------------------
function key() {
  const material = process.env.TOTP_ENCRYPTION_KEY || `${process.env.JWT_SECRET || ""}:totp-v1`;
  return crypto.createHash("sha256").update(material).digest();
}

function encryptSecret(plain) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key(), iv);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return `v1:${iv.toString("base64")}:${cipher.getAuthTag().toString("base64")}:${enc.toString("base64")}`;
}

function decryptSecret(stored) {
  const [v, iv, tag, data] = String(stored || "").split(":");
  if (v !== "v1") throw new Error("Unknown two-factor secret format.");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key(), Buffer.from(iv, "base64"));
  decipher.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(data, "base64")), decipher.final()]).toString("utf8");
}

// ---------------------------------------------------------------------
// Recovery codes: one-time backup codes for a lost phone
// ---------------------------------------------------------------------
function generateRecoveryCodes(n = 10) {
  // 10 characters from an unambiguous alphabet, shown as xxxxx-xxxxx.
  const chars = "abcdefghjkmnpqrstuvwxyz23456789";
  return Array.from({ length: n }, () => {
    const bytes = crypto.randomBytes(10);
    const s = Array.from(bytes, (b) => chars[b % chars.length]).join("");
    return `${s.slice(0, 5)}-${s.slice(5)}`;
  });
}

function hashRecoveryCode(code) {
  const normalized = String(code || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  return crypto.createHmac("sha256", key()).update(normalized).digest("hex");
}

module.exports = {
  generateSecret, totp, verifyTotp, otpauthUrl, hotp, base32Encode, base32Decode, stepAt,
  encryptSecret, decryptSecret, generateRecoveryCodes, hashRecoveryCode,
};
