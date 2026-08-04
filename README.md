# Compliance Calendar Generator

Internal tool: fill in a company's profile (state, entity type, incorporation
date, etc.) and get back an AI-researched US compliance calendar — the same
fields and layout as the team's existing Excel/PDF template, generated live
from official government sources instead of maintained by hand.

**Status:** Q&A / calendar-generation layer only. There is no database yet —
nothing is saved between sessions, and there's no admin review queue. That's
a deliberate, separate next step (see "What's not here yet" below).

---

## What actually happens when someone clicks "Generate Calendar"

1. The browser sends the form fields (state, entity type, tax status, dates,
   foreign-ownership flag) to **your own server**, at `POST /api/generate`.
2. The server — not the browser — builds a research prompt and calls the
   Anthropic API with the `web_search` tool turned on.
3. Claude searches official sources (irs.gov, the relevant Secretary of
   State, Department of Revenue/Franchise Tax authority, etc.), and returns
   structured JSON: one entry per compliance item, with a due date,
   description, source URL, and a confidence rating (high/medium/low).
4. The server hands that JSON straight back to the browser, which renders it
   as the grouped calendar table you already saw.
5. Nothing is written to disk. Refreshing the page clears the session.

The reason step 2 has to happen on a server and not in the browser: calling
Anthropic's API requires a secret API key. If that key lived in the
JavaScript file, anyone who opened the page's source code could copy it and
run up charges on your account. Keeping it in an environment variable on the
server, never in a file that ships to the browser, is what makes this safe
to actually deploy.

---

## Run it on your own computer first

You need [Node.js](https://nodejs.org) installed (version 18 or newer —
running `node -v` in a terminal tells you what you have).

```bash
# 1. Install the three packages this needs (express, the Anthropic SDK, dotenv)
npm install

# 2. Copy the env template and add your real API key
cp .env.example .env
# then open .env in any text editor and paste your key in place of the xxxx's
# get a key at https://console.anthropic.com/settings/keys

# 3. Start the server
npm start
```

You'll see:
```
Compliance Calendar Generator running at http://localhost:3000
```
Open that URL in a browser. That's the whole app.

---

## Putting it on GitHub

```bash
git init
git add .
git commit -m "Initial commit: compliance calendar generator"
git branch -M main
git remote add origin https://github.com/<your-username>/<repo-name>.git
git push -u origin main
```

`.gitignore` is already set up to keep `node_modules/` and your `.env` file
(the one with your real API key) out of the repo. **Never commit `.env`.**
If you ever do by accident, treat that key as compromised — revoke it in the
Anthropic console and issue a new one.

---

## Letting your coworkers actually use it (deployment)

Running it on your own laptop only works while your laptop is on and the
terminal is open. For a few people at the company to reach it anytime, you
need to run it somewhere always-on. Cheapest/simplest options, roughly
easiest first:

- **[Render](https://render.com)** or **[Railway](https://railway.app)** —
  connect your GitHub repo, they auto-detect it's a Node app (because of
  `package.json`), you paste your `ANTHROPIC_API_KEY` into their dashboard's
  environment variables, and it gives you a URL. Free tiers exist; good
  enough for "a few people."
- **A small company VM** (AWS/Azure/GCP/DigitalOcean) if your company
  already has one — `git clone`, `npm install`, `npm start` (ideally kept
  alive with a process manager like `pm2`), put it behind your existing
  reverse proxy/HTTPS.

Whichever you pick, the only thing that changes is *where* `ANTHROPIC_API_KEY`
gets set — it's always an environment variable on the server, never in code.

---

## Access control

Right now, anyone who has the URL can use it — there's no login. That's fine
if it's only reachable inside your company network or shared privately with
a few people. If it'll be reachable from the open internet, add basic
protection before wide distribution: a shared password gate, your company
SSO, or restricting it to your office/VPN IP range at the hosting level.
Ask if you want this added — it's a small change to `server.js`.

There's also a basic rate limit (20 requests/hour per visitor) baked into
`server.js` so one person (or a bug) can't accidentally burn through your
Anthropic budget. Adjust `RATE_LIMIT` there if needed.

---

## What's not here yet (by design, for now)

- **No database.** Every generated calendar disappears on refresh. Nothing
  is reviewed or approved by a human before being shown.
- **No admin review queue, rule versioning, or "50 states pre-loaded"
  rule engine.** Every calendar is generated fresh, live, per click.
- **No saved company profiles.** You retype the form each time.

These map to Layers 2–4 of the fuller system we scoped earlier (research
database, human approval workflow, deterministic rule engine). Natural next
step whenever you're ready for it.

---

## File map

```
compliance-calendar-webapp/
├── package.json       # dependencies + npm start/dev scripts
├── server.js           # the only file that touches your API key
├── .env.example         # template — copy to .env, never commit .env
├── .gitignore
├── public/
│   └── index.html        # the whole frontend (form + results), no secrets in it
└── README.md            # this file
```
