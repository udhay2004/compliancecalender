// lib/keyedLock.js
//
// "One at a time, please" for a specific thing — used for recording a
// payment. Razorpay tells us about a payment twice, usually within the same
// second: the client's browser (verify) and Razorpay's webhook. Without a
// lock both could record it at once, and the client got two "payment
// received" emails. Now the second one waits for the first, then sees the
// payment is already recorded and does nothing.
//
// Works across server copies (a short-lived record in MongoDB, see
// models/JobLock.js) and within one server (a queue in memory). If MongoDB
// is unreachable it falls back to the in-memory queue only; the payment code
// is idempotent anyway, so the worst case is the old behaviour.

const mongoose = require("mongoose");
const JobLock = require("../models/JobLock");
const { OWNER } = require("./jobLock");

const queues = new Map();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const dbReady = () => process.env.NODE_ENV !== "test" && mongoose.connection.readyState === 1;

async function acquireDb(id, ttlMs, waitMs) {
  const deadline = Date.now() + waitMs;
  for (;;) {
    const now = new Date();
    try {
      await JobLock.create({ _id: id, owner: OWNER, lockedUntil: new Date(now.getTime() + ttlMs), expiresAt: new Date(now.getTime() + ttlMs + 3600000) });
      return true;
    } catch (err) {
      if (err.code !== 11000) throw err;
    }
    const stale = await JobLock.findOneAndUpdate(
      { _id: id, lockedUntil: { $lt: now } },
      { $set: { owner: OWNER, lockedUntil: new Date(now.getTime() + ttlMs) } },
      { new: true }
    );
    if (stale) return true;
    if (Date.now() > deadline) return false;
    await sleep(150);
  }
}

/**
 * Run fn while holding the lock named `key`.
 * @returns whatever fn returns
 */
async function withKeyLock(key, fn, { ttlMs = 60000, waitMs = 15000 } = {}) {
  const prev = queues.get(key) || Promise.resolve();
  let release;
  const mine = new Promise((r) => { release = r; });
  const chain = prev.then(() => mine);
  queues.set(key, chain);
  await prev;

  const id = `lock:${key}`;
  let heldInDb = false;
  try {
    if (dbReady()) {
      try {
        heldInDb = await acquireDb(id, ttlMs, waitMs);
        if (!heldInDb) console.warn(`[lock] Waited too long for "${key}"; continuing without it.`);
      } catch (err) {
        console.error(`[lock] Could not use the database lock for "${key}":`, err.message);
      }
    }
    return await fn();
  } finally {
    if (heldInDb) await JobLock.deleteOne({ _id: id, owner: OWNER }).catch(() => {});
    release();
    if (queues.get(key) === chain) queues.delete(key);
  }
}

/** Run fn again (up to `times`) if MongoDB reports a conflicting save. */
async function retryOnConflict(fn, times = 3) {
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (err) {
      if (err && err.name === "VersionError" && i < times) continue;
      throw err;
    }
  }
}

module.exports = { withKeyLock, retryOnConflict };
