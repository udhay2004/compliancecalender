// lib/claude.js
//
// This is where the "don't call the API again and again" logic lives.
//
// Two different kinds of Claude call:
//
//   1. researchStateGeneric(state, entityType) — EXPENSIVE. Live web
//      search against the state's Secretary of State / Dept of Revenue /
//      Dept of Labor for the company-agnostic recurring items (annual
//      report, franchise tax, registered agent renewal, business license,
//      generic payroll/sales-tax triggers). Result is cached in Mongo
//      (StateCache) keyed by (state, entityType) and reused for every
//      future company incorporated in that state, until it goes stale.
//      Also used once for "FEDERAL" (state === "FEDERAL"), which covers
//      IRS-level items that don't vary by state.
//
//   2. researchOdiGeneric(investorType) — EXPENSIVE, but only per
//      investor type (3 possible values), not per company. Live web
//      search against RBI/FEMA for the generic Overseas Direct Investment
//      rules (Annual Performance Report, Foreign Liabilities & Assets
//      Return, event-based reporting). Cached in Mongo (OdiCache) keyed
//      by investorType and reused for every future company with
//      odiDone === "Yes" and that investor type, until it goes stale.
//
//   3. finalizeCompanyCalendar(profile, genericItems, odiGenericItems) —
//      CHEAP. No web search, UNLESS the profile needs ODI/FEMA items and
//      no cached odiGenericItems were passed in (cache miss for that
//      investor type — should be rare once OdiCache is seeded). Takes the
//      cached generic items (already researched) plus the company's
//      specific fiscal year / entity details and asks Claude to
//      (a) compute the actual due dates for this company's FY, (b) decide
//      which conditional items actually apply, and (c) fold in the
//      already-researched ODI/FEMA items (if applicable) with their dates
//      computed for this company.
//
//      IMPORTANT: web search here is gated on `profile.odiDone === "Yes"`,
//      not on `profile.hasForeignParent`. A company can have a foreign
//      parent / related-party transactions (which only affects the
//      "Transfer Pricing" section, no search needed) without ever having
//      actually done an Overseas Direct Investment. Gating on
//      hasForeignParent alone used to turn on a live web_search call for
//      EVERY such company on EVERY generate click — the main source of
//      repeated, avoidable API cost. Gating on odiDone narrows that to
//      only the companies that actually need RBI/FEMA research, and once
//      OdiCache is warm for a given investor type, even that path is cache-only.
//
// If the state/federal cache is missing or stale, generateCompanyCalendar()
// below falls back to the ORIGINAL full live-research behavior (one big
// web-search call covering everything), and then stores the generic
// portion of what it found into the cache for next time — including,
// separately, into OdiCache if the response contained an ODI section.
//
// --- JSON ROBUSTNESS -------------------------------------------------
// Claude is asked to return raw JSON, but especially when web search is
// on and the model quotes/paraphrases a source closely, it can
// occasionally emit a stray literal line break inside a string value or
// drop a comma. extractJson() below tries a plain JSON.parse() first and,
// only if that fails, runs the text through `jsonrepair` (a small,
// dependency-free npm package built exactly for "almost-valid JSON from
// an LLM") before parsing again. If an individual item still can't be
// salvaged, sanitizeItems() drops just that one item (logging a warning)
// instead of failing the whole request.

const Anthropic = require("@anthropic-ai/sdk");
const { jsonrepair } = require("jsonrepair");
const StateCache = require("../models/StateCache");
const OdiCache = require("../models/OdiCache");

const MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-5";
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const FORMAT_RULES = `
FORMAT RULES (follow exactly — the response is parsed by a strict JSON parser):
- Respond with ONLY the JSON object. No markdown code fences, no prose before or after.
- Every string value must be a single line: never put a literal line break inside a string. If you need to show multiple points, join them with " — " or write a normal sentence instead of a new line.
- Do NOT quote source text verbatim or include citation markers/footnotes (like [1] or "according to..."). Paraphrase every fact in your own plain words.
- Do not repeat or duplicate the same item twice.
- Double-check that every object has all required fields and that the JSON is syntactically valid before you finish.`;

function extractJson(text) {
  let cleaned = text.trim();
  const fenceMatch = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) cleaned = fenceMatch[1].trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end === -1) throw new Error("No JSON object found in model response.");
  const jsonStr = cleaned.slice(start, end + 1);

  try {
    return JSON.parse(jsonStr);
  } catch (firstErr) {
    try {
      const repaired = jsonrepair(jsonStr);
      return JSON.parse(repaired);
    } catch (secondErr) {
      console.error("extractJson: JSON.parse failed even after jsonrepair.");
      console.error("First error:", firstErr.message);
      console.error("Repair error:", secondErr.message);
      throw firstErr;
    }
  }
}

// Drops any item missing a required field instead of failing the whole
// batch — a single malformed item shouldn't block the other 15 good ones.
function sanitizeItems(items, requiredFields) {
  if (!Array.isArray(items)) return [];
  const good = [];
  for (const item of items) {
    const missing = requiredFields.filter((f) => !item || !item[f]);
    if (missing.length) {
      console.warn(`Dropping malformed item (missing ${missing.join(", ")}):`, item && item.compliance_name);
      continue;
    }
    good.push(item);
  }
  return good;
}

function textFromResponse(response) {
  return (response.content || [])
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join(""); // no separator — these blocks are one continuous message
}

// ---------------------------------------------------------------------
// 1. Generic, per-state (or FEDERAL), company-agnostic research.
//    This is the call scripts/seedStates.js runs in batches of 15.
// ---------------------------------------------------------------------
const STATE_GENERIC_SYSTEM_PROMPT = `You are a compliance research assistant building the STATE-LEVEL (or federal-level) portion of a US business compliance reference, in the style of a professional compliance calendar prepared by a corporate services firm.

You are given a jurisdiction (a US state, or "FEDERAL" for nationwide IRS-level rules) and an entity type. Research the ACTUAL current, company-agnostic, recurring requirements using the web search tool — official sources only (irs.gov, the relevant Secretary of State, Department of Revenue/Franchise Tax authority, Department of Labor). Do not answer from memory alone for any specific deadline, fee, or threshold — verify it via search.

Never guess or invent a deadline, fee, or threshold. If you cannot verify something, mark it confidence "low".

Only include items that are the SAME for every company of this entity type in this jurisdiction, regardless of that company's specific fiscal year or ownership structure. Where a due date depends on the company's fiscal year end, describe it as a RULE (e.g. "15th day of the 4th month after fiscal year end"), not a specific calendar date — a specific company's date is computed later from this rule.

Categories to use: "Mandatory Annual", "Conditional", "Transfer Pricing" (only truly jurisdiction-driven transfer pricing filing obligations, rare at state level), "Event-Based" (triggered by a corporate event, use "As Triggered" for due_date_rule).

Do NOT include anything related to India/RBI/FEMA/ODI — that is handled separately per-company.
${FORMAT_RULES}

Respond with ONLY a JSON object:
{
  "items": [
    {
      "category": "Mandatory Annual" | "Conditional" | "Transfer Pricing" | "Event-Based",
      "compliance_name": "short name",
      "due_date_rule": "e.g. '1 March (Annually)' or '15th day of 4th month after FY end' or 'As Triggered'",
      "applicable_to": "short phrase",
      "description": "1-2 sentence plain description",
      "authority": "the government agency or body responsible",
      "source_url": "the specific official source URL you used",
      "confidence": "high" | "medium" | "low"
    }
  ]
}`;

async function researchStateGeneric(state, entityType) {
  const jurisdictionLabel =
    state === "FEDERAL" ? "FEDERAL (nationwide, IRS-level rules)" : `the US state of ${state}`;

  const userPrompt = `Jurisdiction: ${jurisdictionLabel}\nEntity Type: ${entityType}\n\nBuild the company-agnostic recurring compliance item list now.`;

  const response = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 4000,
    system: STATE_GENERIC_SYSTEM_PROMPT,
    messages: [{ role: "user", content: userPrompt }],
    tools: [{ type: "web_search_20250305", name: "web_search" }],
  });

  const text = textFromResponse(response);
  if (!text) throw new Error("Model returned no text content during state research.");
  const parsed = extractJson(text);
  return sanitizeItems(parsed.items, ["category", "compliance_name", "due_date_rule"]);
}

// ---------------------------------------------------------------------
// 2. Generic, per-investor-type ODI/FEMA research. This is what
//    scripts/seedOdi.js runs (once per investor type — only 3 total), and
//    what generateCompanyCalendar() falls back to live, once, the first
//    time a given investor type is requested.
// ---------------------------------------------------------------------
const ODI_GENERIC_SYSTEM_PROMPT = `You are a compliance research assistant building the generic Overseas Direct Investment (ODI) / FEMA reporting requirements that a foreign (Indian) parent must comply with, under Reserve Bank of India (RBI) rules, when it holds a US subsidiary.

You are given an investor type: "Indian Company", "Resident Individual", or "Other Foreign Entity". Research the ACTUAL current, investor-type-agnostic-per-company recurring RBI/FEMA reporting requirements using the web search tool — official sources only (rbi.org.in, FEMA notifications, RBI Master Directions on ODI). Do not answer from memory alone for any specific deadline, form name, or threshold — verify it via search.

Never guess or invent a deadline or form. If you cannot verify something, mark it confidence "low".

Cover things like: Annual Performance Report (APR) to the AD bank, Foreign Liabilities & Assets (FLA) Return to RBI, and event-based reporting triggers (e.g. disinvestment, additional investment, restructuring) relevant to this investor type. These are RBI/FEMA filings made by the Indian investor, NOT US government filings — note that in each description. Where a due date depends on the specific FY, describe it as a RULE (e.g. "by 31 December every year for investments existing as of that year's 31 December"), not a specific calendar date — the specific date is computed later per company.
${FORMAT_RULES}

Respond with ONLY a JSON object:
{
  "items": [
    {
      "compliance_name": "short name",
      "due_date_rule": "e.g. '31 December (Annually)' or 'As Triggered'",
      "applicable_to": "short phrase",
      "description": "1-2 sentence plain description, noting this is an RBI/FEMA filing not a US filing",
      "authority": "the government agency or body responsible (e.g. Reserve Bank of India)",
      "source_url": "the specific official source URL you used",
      "confidence": "high" | "medium" | "low"
    }
  ]
}`;

async function researchOdiGeneric(investorType) {
  const userPrompt = `Investor Type: ${investorType}\n\nBuild the generic recurring ODI/FEMA reporting requirement list now.`;

  const response = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 4000,
    system: ODI_GENERIC_SYSTEM_PROMPT,
    messages: [{ role: "user", content: userPrompt }],
    tools: [{ type: "web_search_20250305", name: "web_search" }],
  });

  const text = textFromResponse(response);
  if (!text) throw new Error("Model returned no text content during ODI research.");
  const parsed = extractJson(text);
  return sanitizeItems(parsed.items, ["compliance_name", "due_date_rule"]);
}

// ---------------------------------------------------------------------
// 3. Cheap, company-specific finalization from cached generic items.
// ---------------------------------------------------------------------
const FINALIZE_SYSTEM_PROMPT = `You are finalizing a company-specific US compliance calendar from ALREADY-RESEARCHED generic compliance items.

You will be given: (a) a list of generic state-level and federal-level compliance items with due-date RULES (not yet computed for a specific company), and (b) a specific company's profile (fiscal year, entity type, tax status, foreign ownership).

Your job:
1. For every generic item whose due_date_rule depends on fiscal year end, compute the ACTUAL date for THIS company's fiscal year, and show your work in the description (name the general rule AND the resulting specific date) — in one plain sentence, not a multi-line quote.
2. Decide which "Conditional" items actually apply given this company's profile, and drop ones that clearly don't (e.g. payroll items if you have no information suggesting employees — keep them but mark applicable_to "If employees" rather than dropping, unless clearly inapplicable).
3. If the profile indicates a foreign parent or related-party transactions, include a "Transfer Pricing" section (documentation, intercompany agreements) if not already present.
4. Only if the profile's "Overseas Direct Investment (ODI) done" field is "Yes", include a "Foreign Reporting (ODI/FEMA)" category. You will normally be given ALREADY-RESEARCHED generic ODI items for this investor type (same as the state/federal items) — just compute each one's actual due date for this company the same way you do for state/federal items, do not re-research them, and do not use web search. Only if no pre-researched ODI items were provided AND the profile says ODI is done, use the web search tool to research RBI filings made by the foreign parent (Annual Performance Report, Foreign Liabilities & Assets Return, event-based ODI reporting) as a one-off fallback. Note clearly these are not US government filings. Summarize everything in your own words — do not paste quoted source sentences into the description field. If ODI done is "No", do NOT include this category at all, even if there is a foreign parent.
5. Do not invent new state/federal/ODI items beyond what was provided plus the transfer-pricing addition described above.
${FORMAT_RULES}

Respond with ONLY a JSON object, same shape as the input items but with due_date fully computed:
{
  "items": [
    {
      "category": "Mandatory Annual" | "Conditional" | "Transfer Pricing" | "Foreign Reporting (ODI/FEMA)" | "Event-Based",
      "compliance_name": "short name",
      "due_date": "human readable, computed, e.g. '15 July (this company's FY end + 3.5 months)'",
      "applicable_to": "short phrase",
      "description": "1-2 sentences, showing the general rule + the specific resulting date where relevant",
      "authority": "string",
      "source_url": "string",
      "confidence": "high" | "medium" | "low"
    }
  ]
}`;

function buildCompanyProfileText(profile) {
  let p = `Company profile:
- Company Name: ${profile.companyName || "(unnamed)"}
- State of Incorporation: ${profile.state}
- Entity Type: ${profile.entityType}
- Tax Status: ${profile.taxStatus}
- Date of Incorporation: ${profile.incorpDate || "not specified"}
- Financial Year: ${profile.fyStart} – ${profile.fyEnd}
- Foreign parent / related-party transactions: ${profile.hasForeignParent ? "Yes" : "No"}
- Overseas Direct Investment (ODI) done under RBI/FEMA: ${profile.odiDone || "No"}`;
  if (profile.odiDone === "Yes") {
    p += `\n- Investor Type: ${profile.odiInvestorType}`;
  }
  return p;
}

async function finalizeCompanyCalendar(profile, genericItems, odiGenericItems) {
  const needsOdi = profile.odiDone === "Yes";
  // Only turn web search on if ODI is actually needed AND we don't already
  // have cached, pre-researched ODI items to hand it — i.e. this should be
  // rare in steady state, once OdiCache is warm for the investor types in
  // use. This replaces the old `!!profile.hasForeignParent` check, which
  // fired a live web_search call on every request for any company with a
  // foreign parent, even when no ODI had actually been done.
  const needsSearch = needsOdi && !(odiGenericItems && odiGenericItems.length);

  let userPrompt = `${buildCompanyProfileText(profile)}

Generic items already researched for this jurisdiction/entity type (finalize dates + applicability, do not re-research these):
${JSON.stringify(genericItems, null, 2)}`;

  if (needsOdi && odiGenericItems && odiGenericItems.length) {
    userPrompt += `\n\nGeneric ODI/FEMA items already researched for this investor type (finalize dates only, do not re-research these):
${JSON.stringify(odiGenericItems, null, 2)}`;
  }

  userPrompt += `\n\nProduce the finalized, company-specific calendar now.`;

  const response = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 8000,
    system: FINALIZE_SYSTEM_PROMPT,
    messages: [{ role: "user", content: userPrompt }],
    ...(needsSearch ? { tools: [{ type: "web_search_20250305", name: "web_search" }] } : {}),
  });

  if (response.stop_reason === "max_tokens") {
    console.error("finalizeCompanyCalendar: response hit max_tokens and was truncated.");
    throw new Error("Model response was truncated (max_tokens). Try again or narrow the request.");
  }
  const text = textFromResponse(response);
  if (!text) throw new Error("Model returned no text content during finalization.");
  try {
    const parsed = extractJson(text);
    return sanitizeItems(parsed.items, ["category", "compliance_name", "due_date"]);
  } catch (err) {
    console.error("extractJson failed. Raw text was:\n", text);
    throw err;
  }
}

// ---------------------------------------------------------------------
// 3. Original full-research fallback (cache miss / stale cache path) —
//    same behavior as the original single-call version of this app, plus
//    it feeds the generic portion of its findings back into the cache.
// ---------------------------------------------------------------------
const FULL_SYSTEM_PROMPT = `You are a compliance research assistant building a company-specific US compliance calendar for an internal company tool, in the style of a professional compliance calendar prepared by a corporate services firm.

You will be given a company profile (state of incorporation, entity type, tax status, incorporation date, financial year, and whether there is foreign/related-party ownership). Using the web search tool, research the ACTUAL current requirements — federal and for the specific state given — from official government sources (irs.gov, the relevant Secretary of State, Department of Revenue/Franchise Tax authority, Department of Labor for payroll, etc). Do not answer from memory alone for any specific deadline, fee, or threshold — verify it via search.

Never guess or invent a deadline, fee, or threshold. If you cannot verify something, mark it confidence "low" and say so in the description rather than making it up.

Build the calendar in these categories, matching how a real compliance calendar for this kind of company is organized:
- "Mandatory Annual" — filings/taxes/renewals that apply every year regardless of activity (state annual report, franchise tax, registered agent renewal, federal income tax return, bookkeeping/financial statement closing).
- "Conditional" — filings that only apply if certain conditions are met (estimated tax payments if tax liability threshold is met, state income tax in other states, sales tax if nexus exists, payroll tax if employees, W-2/1099 filings, business license renewals).
- "Transfer Pricing" — ONLY include this category if the profile indicates a foreign parent or related-party transactions. Cover transfer pricing documentation and intercompany agreements.
- "Foreign Reporting (ODI/FEMA)" — ONLY include this category if the profile indicates an Overseas Direct Investment (ODI) situation with an Indian investor. These are Reserve Bank of India filings made by the foreign parent (Annual Performance Report, Foreign Liabilities & Assets Return, event-based ODI reporting) — these are not US government filings, note that clearly in the description.
- "Event-Based" — a short reference list of compliance triggers that occur only if a specific corporate event happens (change of directors, change of registered agent, share transfer, amendment of charter documents, merger/dissolution). These don't need a specific due date; use "As Triggered" for due_date.

Compute actual due dates specific to the company's financial year where the requirement is tied to fiscal year end (e.g. federal corporate income tax return is generally due the 15th day of the 4th month after fiscal year end) rather than just stating the general rule — show your work by naming both the general rule and the resulting specific date for this company in the description, in one plain sentence.
${FORMAT_RULES}

Respond with ONLY a JSON object matching exactly this shape:
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

async function fullLiveResearch(profile) {
  const userPrompt = `${buildCompanyProfileText(profile)}\n\nBuild the full compliance calendar for this company now.`;
  const response = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 16000,
    system: FULL_SYSTEM_PROMPT,
    messages: [{ role: "user", content: userPrompt }],
    tools: [{ type: "web_search_20250305", name: "web_search" }],
  });
  if (response.stop_reason === "max_tokens") {
    console.error("fullLiveResearch: response hit max_tokens and was truncated.");
    throw new Error("Model response was truncated (max_tokens). Try again or narrow the request.");
  }
  const text = textFromResponse(response);
  if (!text) throw new Error("Model returned no text content.");
  try {
    const parsed = extractJson(text);
    return sanitizeItems(parsed.items, ["category", "compliance_name", "due_date"]);
  } catch (err) {
    console.error("extractJson failed. Raw text was:\n", text);
    throw err;
  }
}

// Splits a full live-research result into the reusable generic portion
// (state-independent-of-company items) to seed StateCache going forward,
// PLUS the ODI/FEMA portion separately (to seed OdiCache) instead of just
// dropping it. Both are converted from a computed "due_date" back into a
// reusable "due_date_rule" — good enough to reuse for other companies at
// medium/low confidence; a fresh seed run will replace it with a properly
// rule-form version anyway.
function extractGenericPortion(items) {
  const toGeneric = (it) => ({
    compliance_name: it.compliance_name,
    due_date_rule: it.due_date,
    applicable_to: it.applicable_to,
    description: it.description,
    authority: it.authority,
    source_url: it.source_url,
    confidence: it.confidence,
  });

  const stateGeneric = items
    .filter((it) => it.category !== "Foreign Reporting (ODI/FEMA)")
    .map((it) => ({ category: it.category, ...toGeneric(it) }));

  const odiGeneric = items
    .filter((it) => it.category === "Foreign Reporting (ODI/FEMA)")
    .map(toGeneric);

  return { stateGeneric, odiGeneric };
}

// ---------------------------------------------------------------------
// Orchestrator: cache-first, live fallback. Never calls the live-search
// API for something already sitting in the database and still fresh —
// that's the whole point of StateCache/OdiCache.
// ---------------------------------------------------------------------
async function generateCompanyCalendar(profile) {
  const state = StateCache.normalizeState(profile.state);
  const entityType = profile.entityType;
  const needsOdi = profile.odiDone === "Yes";

  const [stateDoc, federalDoc, odiDoc] = await Promise.all([
    StateCache.findOne({ state, entityType }),
    StateCache.findOne({ state: "FEDERAL", entityType }),
    needsOdi ? OdiCache.findOne({ investorType: profile.odiInvestorType }) : Promise.resolve(null),
  ]);

  const stateFresh = StateCache.isFresh(stateDoc);
  const federalFresh = StateCache.isFresh(federalDoc);
  const odiFresh = !needsOdi || OdiCache.isFresh(odiDoc);

  if (stateFresh && federalFresh && odiFresh) {
    // Full cache hit — cheap path, zero web_search calls at all.
    const genericItems = [...federalDoc.items, ...stateDoc.items];
    const odiGenericItems = needsOdi ? odiDoc.items : undefined;
    const items = await finalizeCompanyCalendar(profile, genericItems, odiGenericItems);
    return { items, sourceMode: "cache" };
  }

  if (stateFresh && federalFresh && needsOdi && !odiFresh) {
    // Only the ODI/FEMA piece is missing/stale — research just that
    // (once per investor type, not per company) instead of re-running
    // the whole state/federal calendar live.
    const odiItems = await researchOdiGeneric(profile.odiInvestorType);
    await OdiCache.findOneAndUpdate(
      { investorType: profile.odiInvestorType },
      { investorType: profile.odiInvestorType, items: odiItems, generatedAt: new Date() },
      { upsert: true }
    ).catch((err) => console.error("ODI cache backfill failed (non-fatal):", err.message));

    const genericItems = [...federalDoc.items, ...stateDoc.items];
    const items = await finalizeCompanyCalendar(profile, genericItems, odiItems);
    return { items, sourceMode: "mixed" };
  }

  // State and/or federal cache missing/stale — fall back to full live
  // research, and backfill whichever cache entries were missing for next
  // time (both StateCache and, if applicable, OdiCache).
  const items = await fullLiveResearch(profile);
  const { stateGeneric, odiGeneric } = extractGenericPortion(items);

  // We can't cleanly separate "federal" vs "state" items from the combined
  // full-research result, so we store the whole generic set under the
  // state key and leave FEDERAL to be populated by scripts/seedStates.js
  // (which researches FEDERAL directly and precisely). This still avoids
  // re-researching THIS state for the next company.
  const backfills = [];
  if (!stateFresh) {
    backfills.push(
      StateCache.findOneAndUpdate(
        { state, entityType },
        { state, entityType, items: stateGeneric, generatedAt: new Date() },
        { upsert: true }
      ).catch((err) => console.error("State cache backfill failed (non-fatal):", err.message))
    );
  }
  if (needsOdi && !odiFresh && odiGeneric.length) {
    backfills.push(
      OdiCache.findOneAndUpdate(
        { investorType: profile.odiInvestorType },
        { investorType: profile.odiInvestorType, items: odiGeneric, generatedAt: new Date() },
        { upsert: true }
      ).catch((err) => console.error("ODI cache backfill failed (non-fatal):", err.message))
    );
  }
  await Promise.all(backfills);

  return { items, sourceMode: federalFresh || stateFresh ? "mixed" : "live" };
}

module.exports = {
  researchStateGeneric,
  researchOdiGeneric,
  finalizeCompanyCalendar,
  fullLiveResearch,
  generateCompanyCalendar,
  extractGenericPortion,
};
