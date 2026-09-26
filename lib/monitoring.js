// lib/monitoring.js
//
// Error alerts via Sentry (free plan is enough). When SENTRY_DSN is set,
// every unexpected server error — a crashing route, a failed daily job, an
// unhandled promise — is sent to Sentry, which emails you with the details.
// Without SENTRY_DSN this file does nothing and errors only go to the logs.
//
// Settings:
//   SENTRY_DSN                  from sentry.io → Project → Client Keys (DSN)
//   SENTRY_ENVIRONMENT          defaults to NODE_ENV (e.g. "production")
//   SENTRY_TRACES_SAMPLE_RATE   performance tracing, 0–1 (default 0 = off)
//
// Privacy: request bodies, cookies and headers are NOT sent (they can hold
// client documents, passwords and session cookies).

let Sentry = null;

function init() {
  const dsn = (process.env.SENTRY_DSN || "").trim();
  if (!dsn || process.env.NODE_ENV === "test") return false;
  try {
    Sentry = require("@sentry/node");
    Sentry.init({
      dsn,
      environment: process.env.SENTRY_ENVIRONMENT || process.env.NODE_ENV || "development",
      tracesSampleRate: Math.min(1, Math.max(0, parseFloat(process.env.SENTRY_TRACES_SAMPLE_RATE || "0") || 0)),
      sendDefaultPii: false,
      beforeSend(event) {
        if (event.request) {
          delete event.request.data;
          delete event.request.cookies;
          delete event.request.headers;
        }
        return event;
      },
    });
    console.log("[monitoring] Error alerts are ON (Sentry).");
    return true;
  } catch (err) {
    console.error("[monitoring] Could not start Sentry (continuing without it):", err.message);
    Sentry = null;
    return false;
  }
}

/** Report an unexpected error. context: short tags such as { job: "reminders" }. */
function captureError(err, context = {}) {
  if (!Sentry) return;
  try {
    Sentry.withScope((scope) => {
      Object.entries(context).forEach(([k, v]) => {
        if (v !== undefined && v !== null) scope.setTag(k, String(v).slice(0, 200));
      });
      Sentry.captureException(err instanceof Error ? err : new Error(String(err)));
    });
  } catch (_) { /* never let monitoring break the app */ }
}

/** Send anything still queued (used during shutdown). */
async function flush(ms = 2000) {
  if (!Sentry) return;
  try { await Sentry.flush(ms); } catch (_) {}
}

module.exports = { init, captureError, flush, enabled: () => Boolean(Sentry) };
