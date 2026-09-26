// server.js
//
// Wiring only. The actual logic lives in:
//   config/db.js              - MongoDB connection
//   models/                   - User, Calendar, StateCache
//   middleware/auth.js        - JWT cookie auth (page + API variants)
//   routes/auth.routes.js     - shared login / logout / me (single team
//                                username+password, no signup)
//   routes/calendar.routes.js - generate / review queue / approve / reject / pdf
//   lib/claude.js             - cache-first, live-fallback Claude calls
//   lib/pdf.js                - PDF export
//
// Run: npm install && npm start   (after copying .env.example to .env)

require("dotenv").config();
// Error alerts (Sentry) start first so they see everything that follows.
const monitoring = require("./lib/monitoring");
monitoring.init();
const path = require("path");
const express = require("express");
// Must come before any routes: answers errors thrown in async handlers.
const { errorHandler } = require("./lib/asyncErrors");
const cookieParser = require("cookie-parser");
const cron = require("node-cron");
const { connectDB } = require("./config/db");
const { requirePageAuth, requirePageRole, requirePageClientRole, tryPageAuth } = require("./middleware/auth");
const authRoutes = require("./routes/auth.routes");
const calendarRoutes = require("./routes/calendar.routes");
const adminRoutes = require("./routes/admin.routes");
const portalRoutes = require("./routes/portal.routes");
const publicRoutes = require("./routes/public.routes");
const paymentsRoutes = require("./routes/payments.routes");
const messagesRoutes = require("./routes/messages.routes");
const dashboardRoutes = require("./routes/dashboard.routes");
const notificationsRoutes = require("./routes/notifications.routes");
const invoicesRoutes = require("./routes/invoices.routes");
const legalRoutes = require("./routes/legal.routes");
const { sendPageWithFooter } = legalRoutes;
const { runReminderSweep, backfillDueDates } = require("./lib/reminders");

const app = express();
const PORT = process.env.PORT || 3000;

// Required for the new public rate limiter (routes/public.routes.js) to
// see the real visitor IP instead of Railway/Render's proxy IP — without
// this, express-rate-limit either throws on the X-Forwarded-For header
// or (worse) silently rate-limits every visitor as one shared IP.
app.set("trust proxy", 1);
app.disable("x-powered-by"); // don't advertise the framework
// Browser security headers on every response (lib/securityHeaders.js).
app.use(require("./lib/securityHeaders").securityHeaders);
// Compress text responses (pages, scripts, JSON, CSV): typically 70-80%
// smaller, so pages load faster on slow connections.
app.use(require("compression")());

// Health check for Railway (railway.json): 200 only when the database
// answers, so a broken deploy is never switched live.
app.get("/healthz", async (req, res) => {
  res.set("Cache-Control", "no-store");
  const mongoose = require("mongoose");
  try {
    if (mongoose.connection.readyState !== 1) throw new Error("not connected");
    await Promise.race([
      mongoose.connection.db.admin().ping(),
      new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 3000)),
    ]);
    res.json({ ok: true, db: "up", uptimeSeconds: Math.round(process.uptime()) });
  } catch (err) {
    res.status(503).json({ ok: false, db: "down" });
  }
});

const REQUIRED_ENV = ["ANTHROPIC_API_KEY", "MONGODB_URI", "JWT_SECRET"];
const missing = REQUIRED_ENV.filter((k) => !process.env[k]);
if (missing.length) {
  console.error(
    `\n[startup error] Missing required .env values: ${missing.join(", ")}\n` +
    "Copy .env.example to .env and fill these in before starting the server.\n"
  );
  process.exit(1);
}
// Settings that are easy to forget and matter in production.
if (process.env.NODE_ENV === "production") {
  const warn = (msg) => console.warn(`[startup warning] ${msg}`);
  if (!process.env.APP_URL) warn("APP_URL is not set: links in emails, webhooks and calendar feeds will be wrong.");
  if (!process.env.MAIL_FROM && !process.env.SMTP_FROM) warn("MAIL_FROM is not set: emails are sent from a default address that may not be verified for your domain, and can land in spam.");
  if (!process.env.TOTP_ENCRYPTION_KEY) warn("TOTP_ENCRYPTION_KEY is not set: staff two-factor secrets are protected with a key derived from JWT_SECRET. Set a separate key once and never change it.");
  if (!process.env.TURNSTILE_SITE_KEY || !process.env.TURNSTILE_SECRET_KEY) warn("The \"verify you are human\" check is OFF (TURNSTILE_SITE_KEY / TURNSTILE_SECRET_KEY). The daily AI limit still applies.");
  if (!process.env.SENTRY_DSN) warn("SENTRY_DSN is not set: errors are only written to the logs, nobody is alerted.");
}
{
  const wa = require("./lib/whatsapp");
  console.log(wa.isConfigured()
    ? "[whatsapp] WhatsApp messages are ON (Meta Cloud API)."
    : "[whatsapp] WhatsApp is not set up (WHATSAPP_TOKEN / WHATSAPP_PHONE_NUMBER_ID); messages are only logged.");
}
if (!process.env.RAZORPAY_KEY_ID || !process.env.RAZORPAY_KEY_SECRET || !process.env.RAZORPAY_WEBHOOK_SECRET) {
  console.warn(
    "\n[startup warning] RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET / RAZORPAY_WEBHOOK_SECRET " +
    "not fully set — payment routes will fail and the webhook will reject everything. " +
    "See .env.example.\n"
  );
}

// Say exactly where documents are going, every boot. If this says LOCAL
// DISK on a hosted server, uploads will disappear on the next deploy.
{
  const storage = require("./lib/storage");
  const line = `[storage] Client documents are stored in: ${storage.describe()}`;
  if (storage.DRIVER === "local" && process.env.NODE_ENV === "production") {
    console.warn(`\n${line}\n[storage] WARNING: files on local disk are LOST on redeploy. Add the R2_* settings (see .env.example).\n`);
  } else {
    console.log(line);
  }
}

// A single unhandled promise rejection anywhere in the app (e.g. a stale
// document failing Mongoose validation on save, as happened with a
// leftover role:"member" user doc) used to crash the ENTIRE server for
// EVERY visitor. Log it loudly instead of dying, so one bad request or
// one bad document can't take the whole site down.
process.on("unhandledRejection", (reason) => {
  console.error("[unhandled rejection]", reason);
  monitoring.captureError(reason, { kind: "unhandledRejection" });
});
// A truly unexpected crash: report it, then exit so Railway restarts a
// clean copy (continuing after one is unsafe).
process.on("uncaughtException", (err) => {
  console.error("[uncaught exception]", err);
  monitoring.captureError(err, { kind: "uncaughtException" });
  monitoring.flush(2000).finally(() => process.exit(1));
});

// MUST be registered before app.use(express.json()) below: Razorpay
// signs the webhook over the exact raw bytes it sent, so this one path
// needs express.raw() instead of JSON parsing. Every other route in the
// app (including the rest of routes/payments.routes.js) is fine with
// the global JSON parser.
app.post(
  "/api/webhooks/razorpay",
  express.raw({ type: "application/json" }),
  paymentsRoutes.razorpayWebhookHandler
);

// WhatsApp (Meta) webhook: also signed over the raw bytes, so it's
// registered before the JSON parser too. See routes/whatsapp.routes.js.
{
  const wa = require("./routes/whatsapp.routes");
  app.get("/api/webhooks/whatsapp", wa.verifyHandler);
  app.post("/api/webhooks/whatsapp", express.raw({ type: "*/*", limit: "1mb" }), wa.webhookHandler);
}

app.use(express.json({ limit: "1mb" }));
app.use(cookieParser());

// ---------------------------------------------------------------------
// Protected pages MUST be registered before the static middleware, since
// express.static would otherwise serve the file straight off disk before
// the auth guard ever runs. Each page gets the guard matching its
// audience — a client landing on /app.html would see a working-looking
// UI whose every API call then 403s, which is a worse experience than
// just redirecting them away at the page level.
// ---------------------------------------------------------------------
const STAFF_PAGES = ["/app.html", "/review.html", "/calendar.html", "/pipeline.html", "/reports.html"];
STAFF_PAGES.forEach((route) => {
  app.get(route, requirePageAuth, requirePageRole("staff"), (req, res) => {
    res.sendFile(path.join(__dirname, "public", route));
  });
});

app.get("/admin.html", requirePageAuth, requirePageRole("admin"), (req, res) => {
  res.sendFile(path.join(__dirname, "public", "admin.html"));
});

// The role-aware landing screen every internal account gets after
// signing in. One file, three faces — which panels it can populate is
// decided by routes/dashboard.routes.js, not by the page.
app.get("/dashboard.html", requirePageAuth, requirePageRole("staff"), (req, res) => {
  res.sendFile(path.join(__dirname, "public", "dashboard.html"));
});

app.get("/portal.html", requirePageAuth, requirePageClientRole, (req, res) => {
  sendPageWithFooter(res, "portal.html");
});

// Calendar subscription links for Google/Outlook/Apple (public, token-protected).
app.use(require("./routes/feeds.routes"));

// Company and policy pages (/terms, /privacy, /refund-policy, /pricing …):
// public, server-rendered and linked from the footer of every public page.
app.use(legalRoutes);
["login.html", "signup.html"].forEach((file) => {
  app.get(`/${file}`, (req, res) => sendPageWithFooter(res, file));
});

// "/" routes by role rather than always going to the staff app, since a
// client hitting the root of the site should land in their portal, not
// a staff tool they can't use. Logged-out visitors are NOT redirected to
// login anymore — they get the public free-tier tool (public/index.html,
// backed by routes/public.routes.js), which is the Phase 1 lead-gen path.
app.get("/", tryPageAuth, (req, res) => {
  // A signed-in client can still open the generator (/?new=1) to create a
  // calendar for another entity — it's saved straight to their portal
  // (see routes/public.routes.js).
  if (req.user && !(req.user.role === "client" && req.query.new === "1")) {
    return res.redirect(req.user.role === "client" ? "/portal.html" : "/dashboard.html");
  }
  sendPageWithFooter(res, "index.html");
});

// ---------------------------------------------------------------------
// Public static assets: login page, CSS/JS, etc.
// ---------------------------------------------------------------------
// Pages always re-check for a newer version; scripts, styles and images are
// cached by the browser for an hour (then re-checked cheaply via ETag).
app.use(express.static(path.join(__dirname, "public"), {
  index: false,
  setHeaders(res, filePath) {
    res.setHeader("Cache-Control", filePath.endsWith(".html") ? "no-cache" : "public, max-age=3600");
  },
}));

// ---------------------------------------------------------------------
// API
// ---------------------------------------------------------------------
app.use("/api/auth", authRoutes);
app.use("/api/calendars", calendarRoutes);
app.use("/api/admin", adminRoutes);
app.use("/api/portal", portalRoutes);
app.use("/api/portal/payments", paymentsRoutes);
app.use("/api/public", publicRoutes);
app.use("/api/messages", messagesRoutes);
app.use("/api/dashboard", dashboardRoutes);
app.use("/api/notifications", notificationsRoutes);
app.use("/api/invoices", invoicesRoutes);
app.use("/api/pipeline", require("./routes/pipeline.routes"));
app.use("/api/reports", require("./routes/reports.routes"));

// Last: turns any unexpected error into a clear response (never a hang).
app.use(errorHandler);

// A typo in a schedule setting used to crash the whole app at start-up.
function validCron(value, fallback, name) {
  if (!value) return fallback;
  if (cron.validate(value)) return value;
  console.warn(`[startup warning] ${name}="${value}" isn't a valid schedule; using "${fallback}".`);
  return fallback;
}

async function start() {
  await connectDB();
  const { track, addCronTask, installShutdown } = require("./lib/lifecycle");
  const { runExclusive } = require("./lib/jobLock");
  const today = () => new Date().toISOString().slice(0, 10);

  const server = app.listen(PORT, () => {
    console.log(`Compliance Calendar Generator running at http://localhost:${PORT}`);
  });
  // Slightly longer than Railway's proxy keep-alive, so idle connections
  // are closed by the proxy first (avoids rare "connection reset" errors).
  server.keepAliveTimeout = 65000;
  server.headersTimeout = 66000;

  installShutdown(server, {
    onClose: async () => {
      require("./lib/mailer").closeMailer();
      await monitoring.flush(2000);
      await require("mongoose").disconnect().catch(() => {});
    },
  });

  // Leftover upload temp files from a crash (normally removed per request).
  require("./lib/tempCleanup").cleanOldTempFiles();

  // Once per start-up (on one server only): give every filing a real due
  // date and every past payment an invoice. No reminders are sent by this.
  setTimeout(() => {
    track(runExclusive("startup-backfill", { ttlMs: 15 * 60 * 1000 }, async () => {
      await backfillDueDates().catch((err) => console.error("[deadlines] Backfill failed:", err.message));
      await require("./lib/invoices").backfillInvoices().catch((err) => console.error("[invoices] Backfill failed:", err.message));
    }).catch((err) => monitoring.captureError(err, { job: "startup-backfill" })));
  }, 5000).unref();

  // Nightly database backup to R2 (lib/backup.js). 02:30 UTC by default.
  // runExclusive: exactly one backup per night, even with several servers.
  if (process.env.DISABLE_BACKUPS !== "true") {
    const { runBackup } = require("./lib/backup");
    const storage = require("./lib/storage");
    const backupCron = validCron(process.env.BACKUP_CRON, "30 2 * * *", "BACKUP_CRON");
    addCronTask(cron.schedule(backupCron, () => {
      track(runExclusive("backup", { period: today(), ttlMs: 2 * 60 * 60 * 1000 }, () => runBackup({ reason: "scheduled" }))
        .catch((err) => monitoring.captureError(err, { job: "backup" }))); // also logged + team alerted
    }, { timezone: "Etc/UTC" }));
    console.log(`[backup] Nightly database backup scheduled ("${backupCron}" UTC) to ${storage.describe()}.`);
    if (storage.DRIVER === "local" && process.env.NODE_ENV === "production") {
      console.warn("[backup] WARNING: backups are going to local disk, which is wiped on redeploy. Set the R2_* settings.");
    }
  }

  // Daily reminders (lib/reminders.js): deadlines, document chasing,
  // payments, WhatsApp. 08:00 UTC by default (1:30 pm India). Exactly once
  // per day across all servers. DISABLE_REMINDERS=true turns it off.
  if (process.env.DISABLE_REMINDERS !== "true") {
    const schedule = validCron(process.env.REMINDER_CRON, "0 8 * * *", "REMINDER_CRON");
    addCronTask(cron.schedule(schedule, () => {
      track(runExclusive("reminders", { period: today(), ttlMs: 3 * 60 * 60 * 1000 }, () => runReminderSweep())
        .catch((err) => {
          console.error("[reminders] Sweep failed:", err);
          monitoring.captureError(err, { job: "reminders" });
        }));
    }, { timezone: process.env.REMINDER_TIMEZONE || "Etc/UTC" }));
    console.log(`[reminders] Scheduled with cron "${schedule}" (${process.env.REMINDER_TIMEZONE || "UTC"}); set DISABLE_REMINDERS=true to turn off.`);
  }
}

start().catch((err) => {
  console.error("[startup] Failed to start:", err);
  monitoring.captureError(err, { kind: "startup" });
  monitoring.flush(2000).finally(() => process.exit(1));
});
