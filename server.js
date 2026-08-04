// server.js
//
// Wiring only. The actual logic lives in:
//   config/db.js              - MongoDB connection
//   models/                   - User, Calendar, StateCache
//   middleware/auth.js        - JWT cookie auth (page + API variants)
//   routes/auth.routes.js     - signup / login / logout / me
//   routes/calendar.routes.js - generate / review queue / approve / reject / pdf
//   lib/claude.js             - cache-first, live-fallback Claude calls
//   lib/pdf.js                - PDF export
//
// Run: npm install && npm start   (after copying .env.example to .env)

require("dotenv").config();
const path = require("path");
const express = require("express");
const cookieParser = require("cookie-parser");
const { connectDB } = require("./config/db");
const { requirePageAuth } = require("./middleware/auth");
const authRoutes = require("./routes/auth.routes");
const calendarRoutes = require("./routes/calendar.routes");

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
// requirePageAuth ever runs.
// ---------------------------------------------------------------------
const PROTECTED_PAGES = ["/app.html", "/review.html", "/calendar.html"];
PROTECTED_PAGES.forEach((route) => {
  app.get(route, requirePageAuth, (req, res) => {
    res.sendFile(path.join(__dirname, "public", route));
  });
});

app.get("/", (req, res) => res.redirect("/app.html"));

// ---------------------------------------------------------------------
// Public static assets: login/signup pages, CSS/JS, etc.
// ---------------------------------------------------------------------
app.use(express.static(path.join(__dirname, "public"), { index: false }));

// ---------------------------------------------------------------------
// API
// ---------------------------------------------------------------------
app.use("/api/auth", authRoutes);
app.use("/api/calendars", calendarRoutes);

app.get("/healthz", (req, res) => res.json({ ok: true }));

async function start() {
  await connectDB();
  app.listen(PORT, () => {
    console.log(`Compliance Calendar Generator running at http://localhost:${PORT}`);
  });
}

start();
