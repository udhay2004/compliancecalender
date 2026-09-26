// lib/jobLock.js
//
// Makes sure a scheduled job (daily reminders, nightly backup, start-up
// catch-up work) runs on ONE server only, and only once per period — even
// if Railway runs several copies of the app, or restarts it mid-day.
//
// How: before running, the job claims a record in MongoDB named after the
// job and its period (e.g. "reminders:2026-09-26"). MongoDB lets only one
// server create a given record, so every other copy sees it's taken and
// skips. If a server dies while holding a claim, the claim runs out after
// `ttlMs` and another copy may take over.
//
//   await runExclusive("reminders", { period: "2026-09-26", ttlMs: 6 * 3600e3 }, () => runReminderSweep())
//   -> { ran: true, result } | { ran: false, reason }

const os = require("os");
const crypto = require("crypto");
const JobLock = require("../models/JobLock");

const OWNER = `${os.hostname()}:${process.pid}:${crypto.randomBytes(3).toString("hex")}`;
const KEEP_DAYS = 14;

async function claim(id, ttlMs) {
  const now = new Date();
  const lockedUntil = new Date(now.getTime() + ttlMs);
  const expiresAt = new Date(now.getTime() + KEEP_DAYS * 86400000);
  try {
    await JobLock.create({ _id: id, owner: OWNER, lockedUntil, expiresAt });
    return true;
  } catch (err) {
    if (err.code !== 11000) throw err;
  }
  // Already exists: take it over only if the previous holder never finished
  // and its claim has run out (that server died mid-job).
  const taken = await JobLock.findOneAndUpdate(
    { _id: id, finishedAt: null, lockedUntil: { $lt: now } },
    { $set: { owner: OWNER, lockedUntil, expiresAt } },
    { new: true }
  );
  return Boolean(taken);
}

/**
 * @param {string} name     job name
 * @param {object} opts     period: string (one run per period, e.g. a date);
 *                          ttlMs: how long a claim lasts if the server dies
 * @param {Function} fn     the job
 */
async function runExclusive(name, { period = "", ttlMs = 60 * 60 * 1000 } = {}, fn) {
  const id = period ? `${name}:${period}` : name;
  let got;
  try {
    got = await claim(id, ttlMs);
  } catch (err) {
    console.error(`[jobs] Could not check the lock for "${id}" (skipping this run):`, err.message);
    return { ran: false, reason: "lock-error" };
  }
  if (!got) {
    console.log(`[jobs] "${id}" already ran or is running on another server; skipped here.`);
    return { ran: false, reason: "taken" };
  }
  try {
    const result = await fn();
    // With a period, the finished record stays, so it won't run again this
    // period. Without one, release it for the next run.
    if (period) await JobLock.updateOne({ _id: id, owner: OWNER }, { $set: { finishedAt: new Date() } }).catch(() => {});
    else await JobLock.deleteOne({ _id: id, owner: OWNER }).catch(() => {});
    return { ran: true, result };
  } catch (err) {
    // Failed: release it so it can be retried (manually or next schedule).
    await JobLock.deleteOne({ _id: id, owner: OWNER }).catch(() => {});
    throw err;
  }
}

module.exports = { runExclusive, OWNER };
