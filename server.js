// server.js
//
// Two jobs, on purpose kept this simple:
//   1. Serve the static frontend in /public
//   2. Provide POST /api/generate, which is the ONLY place the Anthropic
//      API key is ever touched. The browser never sees it.
//
// Run: npm install && npm start   (after copying .env.example to .env)

require("dotenv").config();
const express = require("express");
const Anthropic = require("@anthropic-ai/sdk");

const app = express();
const PORT = process.env.PORT || 3000;
const MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-5";

if (!process.env.ANTHROPIC_API_KEY) {
  console.error(
    "\n[startup error] ANTHROPIC_API_KEY is not set.\n" +
    "Copy .env.example to .env and add your key from https://console.anthropic.com/settings/keys\n"
  );
  process.exit(1);
}

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

app.use(express.json({ limit: "1mb" }));
app.use(express.static("public"));

// ---------------------------------------------------------------------
// Prompt lives here, server-side, not in the browser. Same content as
// the original artifact version — moving it here doesn't change what it
// does, only who can see/tamper with it.
// ---------------------------------------------------------------------
const SYSTEM_PROMPT = `You are a compliance research assistant building a company-specific US compliance calendar for an internal company tool, in the style of a professional compliance calendar prepared by a corporate services firm.

You will be given a company profile (state of incorporation, entity type, tax status, incorporation date, financial year, and whether there is foreign/related-party ownership). Using the web search tool, research the ACTUAL current requirements — federal and for the specific state given — from official government sources (irs.gov, the relevant Secretary of State, Department of Revenue/Franchise Tax authority, Department of Labor for payroll, etc). Do not answer from memory alone for any specific deadline, fee, or threshold — verify it via search.

Never guess or invent a deadline, fee, or threshold. If you cannot verify something, mark it confidence "low" and say so in the description rather than making it up.

Build the calendar in these categories, matching how a real compliance calendar for this kind of company is organized:
- "Mandatory Annual" — filings/taxes/renewals that apply every year regardless of activity (state annual report, franchise tax, registered agent renewal, federal income tax return, bookkeeping/financial statement closing).
- "Conditional" — filings that only apply if certain conditions are met (estimated tax payments if tax liability threshold is met, state income tax in other states, sales tax if nexus exists, payroll tax if employees, W-2/1099 filings, business license renewals).
- "Transfer Pricing" — ONLY include this category if the profile indicates a foreign parent or related-party transactions. Cover transfer pricing documentation and intercompany agreements.
- "Foreign Reporting (ODI/FEMA)" — ONLY include this category if the profile indicates an Overseas Direct Investment (ODI) situation with an Indian investor. These are Reserve Bank of India filings made by the foreign parent (Annual Performance Report, Foreign Liabilities & Assets Return, event-based ODI reporting) — these are not US government filings, note that clearly in the description.
- "Event-Based" — a short reference list of compliance triggers that occur only if a specific corporate event happens (change of directors, change of registered agent, share transfer, amendment of charter documents, merger/dissolution). These don't need a specific due date; use "As Triggered" for due_date.

Compute actual due dates specific to the company's financial year where the requirement is tied to fiscal year end (e.g. federal corporate income tax return is generally due the 15th day of the 4th month after fiscal year end) rather than just stating the general rule — show your work by naming both the general rule and the resulting specific date for this company in the description.

Respond with ONLY a JSON object (no markdown fences, no prose before or after) matching exactly this shape:
{
  "items": [
    {
      "category": "Mandatory Annual" | "Conditional" | "Transfer Pricing" | "Foreign Reporting (ODI/FEMA)" | "Event-Based",
      "compliance_name": "short name",
      "due_date": "human readable due date, e.g. '1 March (Annually)' or '15th day of 4th month after FY end (15 July for this company)' or 'As Triggered'",
      "applicable_to": "short phrase, e.g. 'Company' / 'C-Corp only' / 'If employees' / 'Conditional'",
      "description": "1-2 sentence plain description",
      "authority": "the government agency or body responsible",
      "source_url": "the specific official source URL you used",
      "confidence": "high" | "medium" | "low"
    }
  ]
}
Include roughly 10-20 items total depending on applicability. Every item must have a source_url from an official source you actually searched, except generic Event-Based items which can cite the relevant Secretary of State's general business filings page.`;

function buildUserPrompt(profile) {
  let p = `Company profile:
- Company Name: ${profile.companyName || "(unnamed)"}
- State of Incorporation: ${profile.state}
- Entity Type: ${profile.entityType}
- Tax Status: ${profile.taxStatus}
- Date of Incorporation: ${profile.incorpDate || "not specified"}
- Financial Year: ${profile.fyStart} – ${profile.fyEnd}
- Foreign parent / related-party transactions: ${profile.hasForeignParent ? "Yes" : "No"}`;
  if (profile.hasForeignParent) {
    p += `\n- Overseas Direct Investment (ODI) under RBI/FEMA: ${profile.odiDone}`;
    p += `\n- Investor Type: ${profile.odiInvestorType}`;
  }
  p += `\n\nBuild the full compliance calendar for this company now.`;
  return p;
}

function extractJson(text) {
  let cleaned = text.trim();
  const fenceMatch = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) cleaned = fenceMatch[1].trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end === -1) throw new Error("No JSON object found in model response.");
  return JSON.parse(cleaned.slice(start, end + 1));
}

// Extremely basic in-memory rate limit: N requests per IP per hour.
// Good enough for "a few people at a company"; swap for something real
// (e.g. a proper rate-limit middleware + Redis) if this gets wider use.
const RATE_LIMIT = 20;
const hits = new Map(); // ip -> [timestamps]
function isRateLimited(ip) {
  const now = Date.now();
  const windowMs = 60 * 60 * 1000;
  const arr = (hits.get(ip) || []).filter((t) => now - t < windowMs);
  arr.push(now);
  hits.set(ip, arr);
  return arr.length > RATE_LIMIT;
}

app.post("/api/generate", async (req, res) => {
  const ip = req.ip;
  if (isRateLimited(ip)) {
    return res.status(429).json({ error: "Rate limit reached. Try again later." });
  }

  const profile = req.body?.profile;
  if (!profile || !profile.state || !profile.entityType) {
    return res.status(400).json({ error: "Missing required profile fields (state, entityType)." });
  }

  try {
    const response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 4000,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: buildUserPrompt(profile) }],
      tools: [{ type: "web_search_20250305", name: "web_search" }],
    });

    const text = (response.content || [])
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("\n");

    if (!text) {
      return res.status(502).json({ error: "Model returned no text content." });
    }

    let parsed;
    try {
      parsed = extractJson(text);
    } catch (parseErr) {
      console.error("JSON parse failure:", parseErr.message, "\nRaw text:", text.slice(0, 1000));
      return res.status(502).json({ error: "Could not parse the model's response as JSON. Try again." });
    }

    return res.json(parsed);
  } catch (err) {
    console.error("Anthropic API error:", err);
    return res.status(502).json({ error: `Research request failed: ${err.message}` });
  }
});

app.get("/healthz", (req, res) => res.json({ ok: true, model: MODEL }));

app.listen(PORT, () => {
  console.log(`Compliance Calendar Generator running at http://localhost:${PORT}`);
  console.log(`Using model: ${MODEL}`);
});
