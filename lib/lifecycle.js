// lib/lifecycle.js
//
// Clean shutdown. When Railway deploys a new version it sends the old one a
// stop signal (SIGTERM). Before, the app died instantly — an upload, a
// payment being recorded or the daily reminders could be cut off half-way.
// Now it:
//   1. stops accepting new requests and stops the schedules,
//   2. waits for requests in progress and running jobs to finish
//      (up to SHUTDOWN_TIMEOUT_SECONDS, default 25),
//   3. sends any queued error reports, closes the database, and exits.
//
// Give Railway time for this: RAILWAY_DEPLOYMENT_DRAINING_SECONDS=30
// (set in railway.json in this repo).

const running = new Set();
const cronTasks = [];
let shuttingDown = false;

/** Keep track of a background job so shutdown waits for it. */
function track(promise) {
  running.add(promise);
  promise.finally(() => running.delete(promise)).catch(() => {});
  return promise;
}

function addCronTask(task) {
  if (task) cronTasks.push(task);
  return task;
}

const isShuttingDown = () => shuttingDown;

/**
 * @param {http.Server} server
 * @param {{ timeoutMs?: number, onClose?: () => Promise<void> }} opts
 */
function installShutdown(server, { timeoutMs, onClose } = {}) {
  const limit = timeoutMs || Math.max(5, parseInt(process.env.SHUTDOWN_TIMEOUT_SECONDS || "25", 10)) * 1000;

  async function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[shutdown] ${signal} received: finishing current work (up to ${Math.round(limit / 1000)}s)…`);
    const force = setTimeout(() => {
      console.error("[shutdown] Took too long; stopping now.");
      process.exit(1);
    }, limit);
    force.unref();

    cronTasks.forEach((t) => { try { t.stop(); } catch (_) {} });
    const closed = new Promise((resolve) => server.close(() => resolve()));
    // Idle keep-alive connections would otherwise hold close() open.
    if (typeof server.closeIdleConnections === "function") server.closeIdleConnections();
    try {
      await Promise.all([closed, Promise.allSettled([...running])]);
      if (onClose) await onClose();
      console.log("[shutdown] Done.");
      clearTimeout(force);
      process.exit(0);
    } catch (err) {
      console.error("[shutdown] Error while stopping:", err.message);
      process.exit(1);
    }
  }

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
  return shutdown;
}

module.exports = { track, addCronTask, installShutdown, isShuttingDown };
