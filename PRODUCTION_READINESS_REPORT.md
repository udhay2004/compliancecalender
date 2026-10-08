# Production readiness report

Pre-launch QA and security audit of the ComplyGlobally platform, 7–8 October 2026.
Work is on the branch `qa-audit` (9 fix commits plus this report), based on `main` at `199eef7`.

## Verdict

**Go, once this branch is merged and the three items under "Check before trusting it with live traffic" are done.**

The codebase was already carefully hardened. The audit still found five problems worth stopping for, all now fixed with tests:

1. A client could be marked **Paid at an old, lower price** after staff changed the price.
2. Every calendar generated from the website got **four Indian ODI filings it shouldn't have**.
3. A client could run **script in an admin's or staff member's browser** through their contact name or email.
4. **Password guessing** against one account from many addresses was not slowed down.
5. An admin could set a **one-character password** on any staff or client login.

### Check before trusting it with live traffic

1. **Calendars already created with the ODI bug.** Every calendar generated on the website before this fix, with the foreign-ownership switch off, carries four wrong filings (Annual Performance Report, FLA Return, ODI Event Reporting, Evidence of Investment). Clients may have selected or paid for them. Find them with `{"profile.hasForeignParent": false, "profile.odiDone": "Yes"}` on the `calendars` collection and decide what to do with each. I did not touch stored data.
2. **The human check is off in production.** `GET /api/public/config` on the live site returns `humanCheck: null`, so `TURNSTILE_SITE_KEY` / `TURNSTILE_SECRET_KEY` are not set. The free generator is protected only by 5 calendars per hour per address. Add the keys (and the hostname `compliance.complyglobally.com` to the Turnstile widget).
3. **One real payment and one real refund, end to end, in Razorpay live mode**, including a price change while the checkout popup is open. Everything payment-related here was tested against a stand-in for Razorpay, not Razorpay itself.

## Baseline

Before any change, on `main` at `199eef7`:

| Check | Result |
|---|---|
| `npm ci` | clean |
| `npm test` | 196 tests, 196 pass |
| `npm audit --omit=dev --audit-level=high` | 0 vulnerabilities |

One test (`the same payment arriving twice at once…`) failed intermittently on a busy machine, before and after unrelated changes. It asserted a wall-clock limit. See Low, item L1.

## Final state

| Check | Result |
|---|---|
| `npm test` | **245 tests, 245 pass** (49 new), run four times in a row |
| `npm audit --omit=dev --audit-level=high` | 0 vulnerabilities |
| Browser run | Landing page, sign-up, portal, and all staff and admin pages clicked through on a local copy; details under "What was exercised in a browser" |

No test was removed or weakened. Two existing assertions changed: the clock-based one above, and the security-header test gained one line.

## Issues found and fixed

Each new test was run against the old code first to confirm it fails there.

### Critical

None.

### High

**H1. Paying a voided order settled the item at the old price.**
- Where: `routes/payments.routes.js`, `applyCapturedPayment`.
- What: when staff changed a price, the open Razorpay order was recorded as voided, but it stays payable at Razorpay, and a payment on it was compared with the order's own (old) amount. A client quoted $125, then re-quoted $500, could pay the $125 order and be marked Paid, with an invoice issued. It also happens innocently if the popup is open while the price is corrected.
- Fix: a payment on a voided order only settles the item if it equals today's price. Otherwise it is recorded as a mismatch and the team is told to check and refund, like any other wrong-amount payment.
- Tests: `tests/client-flow.test.js`, "paying an order voided by a price change is flagged…" (webhook path, and browser path with Razorpay's API unreachable) and "an order voided and then re-priced back to the same amount can still be paid".

**H2. Wrong filings on every website calendar (ODI).**
- Where: `public/index.html` (`readProfile`), `lib/complianceDb.js` (`factsFor`).
- What: the two ODI questions sit behind the "foreign parent" switch. Hidden, the select still reported "Yes", and the page always sent it. The server added four RBI/FEMA filings regardless of the switch. A US corporation with no foreign owner got 13 filings instead of 9.
- Fix: the page sends the ODI answers only when the switch is on, and the calendar builder ignores them without a foreign parent. The second part also corrects a regenerate from the portal.
- Test: `tests/public-generator.test.js`, "the ODI questions only count when the foreign-ownership switch is on".

**H3. Stored cross-site scripting from a client into staff and admin pages.**
- Where: the `escapeHtml` / `esc` helper in `admin.html`, `app.html`, `calendar.html`, `index.html`, `pipeline.html`, `portal.html`, `reports.html`, `review.html`, `js/notifications.js`.
- What: the helper escaped `< > &` but not quotes, and it is also used for values inside attributes (`value="…"` on the admin page's client forms, `href="mailto:…"` on the staff calendar page). A client setting their contact name to `" autofocus onfocus="…` would run script in the admin's session when that client was opened. A name typed into the public form reaches the same field once the visitor signs up. The email check allows quotes, so the email field worked too.
- Fix: each helper now escapes `& < > " '` by string replacement, as `dashboard.html` already did. Text on screen is unchanged.
- Tests: `tests/page-safety.test.js` runs every page's real helper against the attack. Also confirmed in a browser: the payload is held as plain text and nothing runs.

**H4. Password guessing was throttled per address only.**
- Where: `routes/auth.routes.js`, `POST /api/auth/login`.
- What: 10 wrong passwords per 15 minutes per IP, and nothing per account, so guessing from rotating addresses was unlimited. Client logins have no two-factor step behind the password.
- Fix: wrong passwords are also counted per account (10 per 15 minutes, from anywhere). Only wrong passwords count, it expires by itself, and email-code and Google sign-in are unaffected, so it cannot be used to lock an owner out.
- Tests: `tests/auth-flow.test.js`, "wrong passwords are counted per account, not only per address" and "the per-account count ignores capitals and spaces in the email".

### Medium

**M1. Admin-set passwords skipped the password rules.** `POST /api/admin/users` and `PATCH /api/admin/users/:id` accepted any password. Both now apply `lib/passwordPolicy.js`. Test: `tests/tenant-isolation.test.js`, "passwords set by an admin follow the same rules…".

**M2. Razorpay script blocked by the content security policy.** Seen in the browser on the portal: `checkout.js` loads its risk-detection bundle from `cdn.razorpay.com`, which `script-src` did not list. Added that host. Test: `tests/security.test.js`, security headers.

**M3. "Talk to an expert" could flood the team inbox.** It emailed the team on every press with only a per-address limit. Now one email per calendar per day; the visitor's reply is unchanged. Test: `tests/public-generator.test.js`, "request-review: one email to the team per calendar per day…".

**M4. Clients received internal fields.** Portal replies carried the whole calendar record, including the team's internal review note, the raw payment log and each file's storage key. The "being verified" list returned every field of unreviewed filings. Neither is used by the portal page. Removed from client replies; staff replies are unchanged. Test: `tests/tenant-isolation.test.js`, "clients never receive the team's internal note…".

**M5. Account changes were not in the security log.** Only deactivation was logged. Creating an account, changing a role and an admin resetting a password are now logged (three new action names in `models/AuditLog.js`). Tests: `tests/tenant-isolation.test.js`, admin tests.

### Low

**L1. Flaky test.** `tests/production-hardening.test.js` asserted two 30 ms jobs finish within 55 ms. It now checks the order of events.

**L2. Server errors on malformed input.** These answered 500 (and raised an error alert) and now answer 400 or 404:
- `POST /api/auth/login` with a non-text email or password.
- Any route given an id that isn't an id, for example `/api/public/abc/request-review` (`lib/asyncErrors.js` now maps Mongoose's cast error to 404).
- `POST /api/messages/:id` with a non-text body.
- `PATCH /api/admin/users/:id` with an unknown role, or a client-to-team role change.

**L3. Redirect after the two-factor step.** `next` accepted `/\evil.example`, which browsers treat as another site. Only same-site paths are accepted now. Test: `tests/security.test.js`.

**L4. Chat messages could link to another company's calendar.** The optional "about this filing" link is now kept only for the sender's own company. Test: `tests/tenant-isolation.test.js`, chat test.

**L5. Free text from the public form.** Contact name, email and company name are now kept as single-line text with a length limit before being stored or put in an email subject.

**L6. Admin account edits.** An admin can no longer deactivate their own account or change their own role, and list filters accept plain values only (`?role[$ne]=x` was passed to the database as an operator).

**L7. Leads list was unbounded.** It read every public calendar with all its filings. It now reads the newest 500 and only what it shows.

**L8. Two storage settings were undocumented.** `S3_REGION` and `R2_BUCKET` are read by `lib/storage.js`; `.env.example` now mentions them. Every documented setting is read somewhere.

## Fixed: files and tests

| Commit | Files | Tests |
|---|---|---|
| `b6ebc17` Payments: voided order | `routes/payments.routes.js` | `tests/client-flow.test.js` (+6) |
| `67fd222` Sign-in: per-account limit | `routes/auth.routes.js` | `tests/auth-flow.test.js` (+5), `tests/security.test.js` (+1) |
| `6427a9b` Public generator | `public/index.html`, `lib/complianceDb.js`, `routes/public.routes.js`, `lib/countries.js`, `lib/asyncErrors.js` | `tests/public-generator.test.js` (new, 16) |
| `6249ee6` Admin accounts | `routes/admin.routes.js`, `models/AuditLog.js` | `tests/tenant-isolation.test.js` |
| `de05d24` Client replies, chat links | `lib/calendarView.js`, `routes/portal.routes.js`, `routes/messages.routes.js` | `tests/tenant-isolation.test.js` (new, 18) |
| `5ec05d6` Page escaping | nine files under `public/` | `tests/page-safety.test.js` (new, 3) |
| `e278de7`, `82d20e7` Test stability | `tests/production-hardening.test.js`, `tests/tenant-isolation.test.js` | |
| `25da18b` Security headers | `lib/securityHeaders.js` | `tests/security.test.js` |

No `/api` request or response shape that a page or an outside service depends on was changed. The fields removed from client replies (M4) are not read by `portal.html` or `js/checkout.js`.

## What was confirmed sound

These were checked and needed no change. Where a test did not exist, one was added.

- **Tenant isolation.** With two seeded companies, company A's client gets 404 on every portal, payment, invoice and download route for company B's ids, 403 on B's chat thread, and never sees B's notifications or the team's.
- **Roles.** Every route of every router was called without a session (401), as a client on staff and admin routes (403), as staff on admin routes (403) and as team accounts on portal routes (403). The test walks the routers, so new routes are covered automatically.
- **Pages.** Each staff and admin page is refused on the server for the wrong role, and is registered before the static folder.
- **Two-factor.** Enforced by the server for staff, admin and owner on every team route and page; a session that never passed the code step is refused.
- **Sessions.** Signature, expiry, purpose and password-change version are all checked on every request; forged, unsigned, expired and wrong-purpose tokens are refused; deactivation takes effect at once.
- **Email codes.** Six digits from a secure generator, stored hashed, 10 minutes, single use, 5 tries per code, account lock after 10 failures.
- **Payments.** The amount is never read from the browser. The webhook refuses everything when its secret is unset. The browser and webhook confirming at the same moment record one payment, one invoice, one email. A paid order with a closed tab and no webhook is reconciled on the next press of Pay.
- **Uploads.** Wrong type, disguised content, empty and oversized files are refused; files are only served through routes that check ownership; no route takes a storage key.
- **Every country and entity type.** All 6 countries and every entity type the form offers build a calendar from the compliance database. A value differing only in capitals is refused, never silently mismatched.
- **Background jobs.** Reminders, backups and the start-up backfill run under `lib/jobLock.js`, once per period across servers. Each reminder is keyed per filing, date and stage, so a re-run cannot send it twice. Next-period creation is guarded by a flag.
- **Error alerts.** Sentry is sent no request bodies, cookies or headers.
- **Restore script.** Command line only, not reachable over HTTP, and needs an explicit `--into` target and `--drop` to overwrite.
- **Dangerous patterns.** No `eval`, no string-built queries, no committed secrets, no passwords or tokens in logs.

### What was exercised in a browser

On a local copy running the real `server.js` with in-memory data:

- **Landing page:** step validation, a US run (9 filings, 5 shown, 4 locked) and a UK run with the ownership switch on (20 filings), "Talk to an expert", and the sign-up links carrying the calendar id. No script errors.
- **Sign-up:** wrong code shows a real message and stays usable; the right code lands in the portal with both calendars attached.
- **Portal:** select a service, upload a document, chat, calendar subscription links.
- **Staff:** dashboard, pipeline, reports, review queue, calendar page. A client session is redirected from these pages and gets 403 from their APIs.
- **Admin:** loads with no failed requests; hostile contact name rendered as text.

Hostile strings (`<b>`, `"`, `<img onerror>`) in the company name, a file name and a chat message were shown as text on the portal and the staff calendar page.

## Flagged, not fixed

### Needs a decision

- **Calendars are auto-approved when a visitor signs up**, and a fixed list price is applied the moment they select a service. Together a client can go from the public form to paying with no staff member having looked at the calendar. Document requirements still apply, and nothing else assumes a human review. This looks intended; confirm it is.
- **Client sign-in tells you whether an email has an account** ("no account for this email", "already exists"). This is a documented choice for usability. Staff sign-in does not leak. `POST /api/auth/login` also answers differently for an account that has no password yet.
- **A generated calendar is attached to whoever signs up with its id.** The id is only shown to the visitor who generated it, and guessing one is impractical at the current limits, so I left it. A stricter design would bind the calendar to the browser that created it (a signed cookie set by `/generate`).
- **When Razorpay's API cannot be reached, `/verify` trusts the signature alone** and marks the item Paid. The signature does prove a successful payment on that order. If the account is not on auto-capture, the payment could be authorized but never captured. Confirm auto-capture is on in Razorpay.
- **The human check allows the request when Cloudflare itself is unreachable.** Deliberate, so an outage does not lock visitors out.
- **Any staff member can open any client.** Deliberate; only refunds and revenue exports are restricted to finance and admins.

### Needs real credentials or infrastructure

- Razorpay in live mode: a real payment, refund, failed payment and webhook delivery to `https://compliance.complyglobally.com/api/webhooks/razorpay`.
- WhatsApp through Meta: templates, delivery, STOP replies.
- Email deliverability from `MAIL_FROM` (SPF, DKIM, spam placement).
- R2: a real upload and download, and one backup restored into a scratch database with `scripts/restoreBackup.js`.
- Google sign-in on the new domain (callback URL and authorized redirect).
- Load and scale. The dashboard, pipeline and reports read every current client calendar into memory (cached 30 seconds); fine now, worth measuring before a few thousand clients.
- `/healthz` checks the database only, not storage. I did not add storage, because a brief R2 hiccup would then take the whole site out of rotation.

### Needs legal or regulatory review

- The compliance database (`data/compliance/*.json`): filing rules, due dates and prices were not verified against the authorities.
- The legal pages (terms, privacy, refund policy) and GST invoice wording.

### Smaller things left as they are

- The landing page asks `/api/portal/profile` on load to detect a signed-in client, which logs a harmless 401 in the browser console for every visitor.
- Staff pages are titled "Compliance Calendar Generator" rather than ComplyGlobally.
- `source_url` on a filing is shown as a link and can be edited by staff during review; a `javascript:` address would run when a colleague clicks it. Staff-only.
- No limit on how many documents one client can upload.
- A payment-overdue reminder email is sent before the calendar is saved; a crash in between would send it again the next day.
- The manual "run backup now" guard is per server, not shared. Two admins on two servers could start two backups at once; harmless.
- The policy allows inline scripts (`'unsafe-inline'`), because the pages use them. Moving scripts to files would let the policy block injected script outright.

### Where the brief and the code differ

- There is no live call to an AI service any more. Calendars are built only from the compliance database, so there is no "silent fallback to a slower, costlier call".
- There is no `ENTITY_TYPES_BY_COUNTRY` in `public/index.html`. The page gets its countries and options from the server (`GET /api/public/form`, `lib/countries.js`), which is why a mismatch cannot happen silently: the server refuses a value it did not offer.
- No country has a free-text state field; all are lists, and the UK, Singapore and Germany have none.

## What I was not sure about

- **H2 changes which filings a calendar gets.** I am confident the old behaviour was wrong (the staff form's own comment says an ODI filing means there is a foreign parent), but it is a business rule, so it deserves a second look by whoever owns the compliance content.
- **H4 can refuse the right password for 15 minutes** if someone else has just guessed wrong ten times on that account. The email-code door stays open, and the message says so. If that trade-off is not wanted, raise the limit in `routes/auth.routes.js` rather than removing it.
- **M1 makes admin-created temporary passwords stricter** (12 characters, a letter and a number). The admin page shows the server's message if one is refused.
