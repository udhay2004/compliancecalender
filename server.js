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
const path = require("path");
const express = require("express");
const cookieParser = require("cookie-parser");
const cron = require("node-cron");
const { connectDB } = require("./config/db");
const { requirePageAuth, requirePageRole, requirePageClientRole } = require("./middleware/auth");
const authRoutes = require("./routes/auth.routes");
const calendarRoutes = require("./routes/calendar.routes");
const adminRoutes = require("./routes/admin.routes");
const portalRoutes = require("./routes/portal.routes");
const { runReminderSweep } = require("./lib/reminders");

const app = express();
const PORT = process.env.PORT || 3000;

const REQUIRED_ENV = ["ANTHROPIC_API_KEY", "MONGODB_URI", "JWT_SECRET"];
const missing = REQUIRED_ENV.filter((k) => !process.env[k]);
if (missing.length) {
  console.error(
    `\n[startup error] Missing required .env values: ${missing.join(", ")}\n` +
    "Copy .env.example to .env and fill these in before starting the server.\n"
  );
  process.exit(1);
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
const STAFF_PAGES = ["/app.html", "/review.html", "/calendar.html"];
STAFF_PAGES.forEach((route) => {
  app.get(route, requirePageAuth, requirePageRole("staff"), (req, res) => {
    res.sendFile(path.join(__dirname, "public", route));
  });
});

app.get("/admin.html", requirePageAuth, requirePageRole("admin"), (req, res) => {
  res.sendFile(path.join(__dirname, "public", "admin.html"));
});

app.get("/portal.html", requirePageAuth, requirePageClientRole, (req, res) => {
  res.sendFile(path.join(__dirname, "public", "portal.html"));
});

// "/" routes by role rather than always going to the staff app, since a
// client hitting the root of the site should land in their portal, not
// a staff tool they can't use.
app.get("/", requirePageAuth, (req, res) => {
  res.redirect(req.user.role === "client" ? "/portal.html" : "/app.html");
});

// ---------------------------------------------------------------------
// Public static assets: login page, CSS/JS, etc.
// ---------------------------------------------------------------------
app.use(express.static(path.join(__dirname, "public"), { index: false }));

// ---------------------------------------------------------------------
// API
// ---------------------------------------------------------------------
app.use("/api/auth", authRoutes);
app.use("/api/calendars", calendarRoutes);
app.use("/api/admin", adminRoutes);
app.use("/api/portal", portalRoutes);

app.get("/healthz", (req, res) => res.json({ ok: true }));

async function start() {
  await connectDB();
  app.listen(PORT, () => {
    console.log(`Compliance Calendar Generator running at http://localhost:${PORT}`);
  });

  // Daily reminders sweep — payment-overdue and due-date reminders, see
  // lib/reminders.js. Runs at 8am server time by default; override with
  // REMINDER_CRON (standard 5-field cron syntax) if that's wrong for
  // your timezone/host. Set DISABLE_REMINDERS=true to turn this off
  // entirely (e.g. in a local dev environment where you don't want test
  // data emailing anyone).
  if (process.env.DISABLE_REMINDERS !== "true") {
    const schedule = process.env.REMINDER_CRON || "0 8 * * *";
    cron.schedule(schedule, () => {
      runReminderSweep().catch((err) => console.error("[reminders] Sweep failed:", err));
    });
    console.log(`[reminders] Scheduled with cron "${schedule}" (set DISABLE_REMINDERS=true to turn off).`);
  }
}

start();
