# ComplyGlobally — Compliance Calendar Platform

Companies (mainly US entities, with some other countries) get an
AI-researched compliance calendar: every filing they owe, with real due
dates. They can then ask ComplyGlobally to handle any filing. They upload
documents, pay online, and get proof when it's done. The ComplyGlobally team
works from a staff workspace with a review queue, a pipeline, reports,
invoices and refunds.

Node.js 22 · Express 4 · MongoDB (Mongoose 8) · Cloudflare R2 · Razorpay ·
Anthropic Claude · deployed on Railway.

---

## What it does

**Public website** (`/`)
- Free calendar generator. The visitor enters their company details and
  Claude researches official sources. Some items are shown for free; the
  full calendar comes after sign-up.
- Protected by a "verify you are human" check (Cloudflare Turnstile,
  optional) and a daily AI budget.
- Company and policy pages: `/about`, `/pricing`, `/terms`, `/privacy`,
  `/refund-policy`, `/shipping-policy`, `/contact`.

**Client portal** (`/portal.html`)
- The calendar with real due dates. Clients choose the services they want
  handled, see prices, upload documents (checked by content, stored in R2)
  and pay by card through Razorpay.
- Invoices and credit notes (PDF), a chat with the team and a notification bell.
- Deadlines can be added to Google, Outlook or Apple Calendar (a
  subscription link that stays up to date).
- Optional WhatsApp reminders (the client opts in).

**Staff workspace**
- `/dashboard.html`: deadlines, documents waiting to be checked, clients
  waiting on documents, finance to-do lists, the team and the security log.
- `/pipeline.html`: every service a client chose, in the step it's at now,
  with an owner for each.
- `/reports.html`: on-time rate, turnaround, workload, services, money
  collected, and CSV exports.
- `/review.html` and `/calendar.html`: review and approve AI calendars;
  per client, check documents, send prices, upload proof of completion,
  refund, and chase documents.
- `/admin.html`: accounts, client companies, and health checks for
  storage, payments, WhatsApp, legal pages and backups.
- Staff sign in with a password or an email code, plus required two-factor login.

**Automatic work (daily, 08:00 UTC by default)**
- Reminders before each deadline (30, 7 and 1 days) and when a filing is
  overdue.
- Document chasing: 2, 5 and 10 days after a service is chosen, then weekly.
- Payment reminders.
- A team digest.
- Next year's filings are created automatically.
- A nightly database backup to R2 (02:30 UTC), with retention.

---

## Run it locally

```bash
npm install
cp .env.example .env      # fill in at least ANTHROPIC_API_KEY, MONGODB_URI, JWT_SECRET
node scripts/createUser.js --email you@example.com --password "a long password" --role super_admin --name "Your Name"
npm run dev               # http://localhost:3000
npm test                  # all tests; no database or internet needed
```

Without R2 settings, files are stored in `./uploads` (development only).
Without an email provider, emails are printed in the log. Without Razorpay
keys, payments are disabled.

## Deploy (Railway)

- `railway.json` sets the start command, the health check (`/healthz`, which
  checks the database) and a 30-second graceful shutdown on deploys.
- Put every setting from `.env.example` in Railway → Variables. At minimum:
  `ANTHROPIC_API_KEY`, `MONGODB_URI`, `JWT_SECRET`, `APP_URL`,
  `NODE_ENV=production`, the `R2_*` settings, an email provider (`RESEND_API_KEY`
  or `SMTP_*`) with `MAIL_FROM`, the `RAZORPAY_*` settings and `TOTP_ENCRYPTION_KEY`.
- Strongly recommended: `SENTRY_DSN` (error alerts) and the
  `TURNSTILE_*` keys (human check).
- On start-up the server logs a warning for each important setting that is missing.
- MongoDB: use a paid Atlas tier (M10 or higher) in production.
- Webhooks:
  - Razorpay → `<APP_URL>/api/webhooks/razorpay`, with the events listed in `.env.example`.
  - WhatsApp → `<APP_URL>/api/webhooks/whatsapp`.

### Running more than one copy

This is safe. Scheduled jobs run on one copy only, once per period
(`lib/jobLock.js`, stored in MongoDB). Rate-limit counters are shared through
MongoDB (`lib/rateLimitStore.js`). Payments are recorded exactly once
(`lib/keyedLock.js`). The dashboard, pipeline and reports cache their data
for 30 seconds per copy (`lib/workData.js`).

## Operations

| Task | How |
|---|---|
| Is it up? | `GET /healthz` returns 200 when the app and the database are fine, 503 otherwise |
| Errors | Sentry emails you (with `SENTRY_DSN`); everything is also in Railway's logs |
| Backups | Admin → Backups (list, run now, download). Restore: `node scripts/restoreBackup.js` (read its header first) |
| Storage problems | Admin → Check storage (also finds uploaded files that have gone missing) |
| Payment problems | Admin → Check payments |
| WhatsApp setup | Admin → Check WhatsApp (shows the template text to submit to Meta) |
| Someone locked out | A super admin can reset their password or two-factor from the dashboard or Admin |
| AI budget reached | The team gets a notification. Raise `AI_DAILY_LIMIT_PUBLIC` / `AI_DAILY_LIMIT_TOTAL` if it's real demand |

Data kept automatically: bell notifications for 180 days
(`NOTIFICATION_RETENTION_DAYS`), rate-limit counters until their window
ends, and job locks for 14 days. Chat, invoices, calendars and the audit log
are kept permanently.

If you change `NOTIFICATION_RETENTION_DAYS` after the first deploy, drop the
`createdAt_1` index on the `notifications` collection once (Atlas → Indexes)
so the new value can apply.

## Code map

```
server.js                 wiring: security headers, compression, routes, schedules, shutdown
config/db.js              MongoDB connection (pool, timeouts)
middleware/auth.js        sessions (JWT cookies), roles, two-factor
middleware/upload.js      uploads: temp file on disk, type checked by content, cleaned up
routes/                   one file per area (public, auth, portal, payments, calendars,
                          dashboard, pipeline, reports, invoices, admin, messages,
                          notifications, feeds, whatsapp, legal)
lib/claude.js             AI research (cache first, live search when needed)
lib/deadlines.js          due-date engine (business days, US holidays, next periods)
lib/reminders.js          the daily run: reminders, document chasing, digests
lib/calendarView.js       what a filing looks like to clients and staff (checklist, price)
lib/pipeline.js / reports.js   pipeline stages, report numbers
lib/invoices.js / refunds.js   GST-compliant invoices, credit notes, Razorpay refunds
lib/storage.js            R2 / S3 (streamed), or local disk in development
lib/backup.js             nightly backups (streamed, gzip, EJSON)
lib/notify.js / mailer.js / whatsapp.js   bell + email + WhatsApp
lib/abuseGuard.js         human check + daily AI budget
lib/jobLock.js / keyedLock.js / rateLimitStore.js   safe with several server copies
lib/workData.js           shared cached read of all client work
lib/lifecycle.js          graceful shutdown
lib/monitoring.js         Sentry error alerts
models/                   Mongoose schemas
public/                   the web pages (plain HTML/CSS/JS, no build step)
scripts/                  create the first user, restore a backup, seed research caches
tests/                    node:test suites (run on every pull request by GitHub Actions)
```

## Tests

`npm test` runs every suite in `tests/` with in-memory stand-ins for the
database, storage, email and Razorpay. The real route and business code
runs unchanged. GitHub Actions (`.github/workflows/test.yml`) runs the
suites on every pull request and on every push to main, and also checks
dependencies for known security problems.
