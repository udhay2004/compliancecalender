// lib/rateLimitStore.js
//
// "Too many attempts" counters kept in MongoDB instead of each server's
// memory. In memory they were wiped on every deploy and not shared between
// server copies, so an attacker got a fresh allowance after each restart,
// and with 2 copies twice the allowance.
//
// If the database can't be reached (or in tests), counting falls back to
// memory for that moment, so a database hiccup never locks everyone out.
//
//   rateLimit({ store: mongoStore("login"), windowMs, max })   // express-rate-limit
//   await overLimit("regenerate", orgId, 3, 24 * 3600e3)       // anywhere else

const mongoose = require("mongoose");
const { MemoryStore } = require("express-rate-limit");
const RateLimit = require("../models/RateLimit");

const useDb = () => process.env.NODE_ENV !== "test" && process.env.RATE_LIMIT_STORE !== "memory" && mongoose.connection.readyState === 1;

let warned = false;
function warnOnce(err) {
  if (warned) return;
  warned = true;
  console.error("[rate-limit] Database counter failed; using in-memory counting for now:", err.message);
  setTimeout(() => { warned = false; }, 10 * 60 * 1000).unref();
}

/** Count one hit for id in a window. Returns { hits, resetAt }. */
async function hitDb(id, windowMs) {
  const now = new Date();
  let doc = await RateLimit.findOneAndUpdate({ _id: id, resetAt: { $gt: now } }, { $inc: { hits: 1 } }, { new: true }).lean();
  if (doc) return doc;
  try {
    // No counter, or its window is over: start a new window.
    doc = await RateLimit.findOneAndUpdate(
      { _id: id, resetAt: { $lte: now } },
      { $set: { hits: 1, resetAt: new Date(now.getTime() + windowMs) } },
      { new: true, upsert: true }
    ).lean();
    return doc;
  } catch (err) {
    if (err.code !== 11000) throw err;
    // Another request created it at the same moment.
    return RateLimit.findOneAndUpdate({ _id: id }, { $inc: { hits: 1 } }, { new: true }).lean();
  }
}

class MongoStore {
  constructor(name) {
    this.name = name;
    this.prefix = `${name}:`;
    this.localKeys = false;
    this.memory = new MemoryStore();
  }
  init(options) {
    this.windowMs = options.windowMs;
    this.memory.init(options);
  }
  async increment(key) {
    if (!useDb()) return this.memory.increment(key);
    try {
      const doc = await hitDb(this.prefix + key, this.windowMs);
      return { totalHits: doc.hits, resetTime: doc.resetAt };
    } catch (err) {
      warnOnce(err);
      return this.memory.increment(key);
    }
  }
  async decrement(key) {
    await this.memory.decrement(key);
    if (useDb()) await RateLimit.updateOne({ _id: this.prefix + key, hits: { $gt: 0 } }, { $inc: { hits: -1 } }).catch(() => {});
  }
  async resetKey(key) {
    await this.memory.resetKey(key);
    if (useDb()) await RateLimit.deleteOne({ _id: this.prefix + key }).catch(() => {});
  }
  async resetAll() {
    await this.memory.resetAll();
    if (useDb()) await RateLimit.deleteMany({ _id: { $regex: `^${this.prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}` } }).catch(() => {});
  }
  shutdown() { if (this.memory.shutdown) this.memory.shutdown(); }
}

const mongoStore = (name) => new MongoStore(name);

// Simple counters for checks that aren't Express middleware.
const memoryHits = new Map();
function hitMemory(id, windowMs) {
  const now = Date.now();
  const cur = memoryHits.get(id);
  if (!cur || cur.resetAt <= now) {
    const fresh = { hits: 1, resetAt: now + windowMs };
    memoryHits.set(id, fresh);
    return fresh;
  }
  cur.hits++;
  return cur;
}

/**
 * Count one use of `name` by `who`; true when that's more than `max` in
 * the window (the use is then refused by the caller).
 */
async function overLimit(name, who, max, windowMs) {
  const id = `${name}:${who}`;
  let hits;
  if (useDb()) {
    try { hits = (await hitDb(id, windowMs)).hits; } catch (err) { warnOnce(err); hits = hitMemory(id, windowMs).hits; }
  } else {
    hits = hitMemory(id, windowMs).hits;
  }
  return hits > max;
}

module.exports = { mongoStore, overLimit, MongoStore, _resetMemory: () => memoryHits.clear() };
