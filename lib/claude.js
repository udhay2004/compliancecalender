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
const EmployeeStateCache = require("../models/EmployeeStateCache");

const MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-5";
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const FORMAT_RULES = `
FORMAT RULES (follow exactly — the response is parsed by a strict JSON parser):
- Respond with ONLY the JSON object. No markdown code fences, no prose before or after.
- Every string value must be a single line: never put a literal line break inside a string, and never leave a blank line inside a string. If you need to show multiple points, join them with " — " or write a normal sentence instead of a new paragraph. This applies especially to "description" fields — write them as ONE flowing sentence or two, never as a "General rule: ... For this company: ..." block with line breaks between the parts.
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

// A malformed JSON response (usually a stray literal newline inside a
// string value that jsonrepair couldn't recover from) used to mean the
// ENTIRE request failed with a 502 — throwing away whatever web_search
// research was just paid for, with nothing to show for it. This salvage
// step is a small, cheap, NO-web-search follow-up call that just asks
// Claude to reformat its own broken output as valid JSON, preserving all
// the content. It costs a few cents against a small model call, instead
// of losing the whole (often $0.30-0.70) research call it's salvaging.
async function salvageJsonWithModel(rawText) {
  const response = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 16000,
    system:
      "You will be given text that was supposed to be a single valid JSON object but has a syntax error (often a stray literal newline inside a string value, or a missing comma/brace). Fix it into a single valid JSON object with EXACTLY the same content/data — do not summarize, shorten, drop items, or change any values. Respond with ONLY the corrected JSON object, no markdown fences, no prose.",
    messages: [{ role: "user", content: rawText }],
  });
  const fixedText = textFromResponse(response);
  if (!fixedText) throw new Error("Salvage call returned no text content.");
  return extractJson(fixedText); // let this throw if still broken — nothing more we can do
}

// Wraps extractJson with the salvage fallback above. Use this (not
// extractJson directly) anywhere the source text came from an EXPENSIVE
// web_search call, so a formatting hiccup doesn't waste that spend.
async function extractJsonWithSalvage(text, context) {
  try {
    return extractJson(text);
  } catch (err) {
    console.warn(`${context}: initial JSON parse failed, attempting salvage via a cheap follow-up call...`);
    try {
      const salvaged = await salvageJsonWithModel(text);
      console.warn(`${context}: salvage succeeded.`);
      return salvaged;
    } catch (salvageErr) {
      console.error(`${context}: salvage also failed:`, salvageErr.message);
      throw err; // surface the original parse error, not the salvage error
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

For "Registered Agent Renewal" specifically: registered agent service is billed/renewed annually on the anniversary of the date the agent was engaged — for a newly formed company that is normally the date of incorporation, NOT a fixed calendar date and NOT the same date as the annual report/franchise tax deadline. Describe the due_date_rule as "Annually, on the anniversary of the company's incorporation date" rather than a vague reference to "per service agreement" or tying it to an unrelated fixed date.

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
  const parsed = await extractJsonWithSalvage(text, "researchStateGeneric");
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
  const parsed = await extractJsonWithSalvage(text, "researchOdiGeneric");
  return sanitizeItems(parsed.items, ["compliance_name", "due_date_rule"]);
}

// ---------------------------------------------------------------------
// 2b. Generic, per-employee-state payroll/SUI research. Company-agnostic
//     and STATE-ONLY keyed (see models/EmployeeStateCache.js) — the whole
//     point is this runs ONCE per state, ever (until it goes stale), no
//     matter how many companies later list an employee in that state.
// ---------------------------------------------------------------------
const EMPLOYEE_STATE_GENERIC_SYSTEM_PROMPT = `You are a compliance research assistant building the payroll-employer-registration portion of a US business compliance reference, in the style of a professional compliance calendar prepared by a corporate services firm.

You are given a single US state. This is for a company that has at least one W-2 employee physically working FROM this state, where the company itself may be incorporated elsewhere — so this covers ONLY the employer registrations that are triggered by having an employee working in this state: state income tax withholding registration (note clearly if this state has no personal income tax), and State Unemployment Insurance (SUI) registration. Research the ACTUAL current requirements using the web search tool — official sources only (the state's Department of Revenue/Taxation and Department of Labor/Workforce agency). Do not answer from memory alone — verify via search. Never guess or invent a deadline, fee, or agency name; mark confidence "low" if you cannot verify something.

Respond with ONLY a JSON object:
{
  "items": [
    {
      "compliance_name": "short name, MUST include the state name, e.g. 'Payroll Withholding Registration — Texas'",
      "due_date_rule": "e.g. 'Within 20 days of first wages paid' or 'As Triggered'",
      "applicable_to": "short phrase, e.g. 'If employees in this state'",
      "description": "1-2 sentence plain description, noting this applies because the EMPLOYEE works in this state, not because the company is incorporated here",
      "authority": "the government agency responsible",
      "source_url": "the specific official source URL you used",
      "confidence": "high" | "medium" | "low"
    }
  ]
}`;

async function researchEmployeeStateGeneric(state) {
  const userPrompt = `State: ${state}\n\nBuild the generic employer payroll/SUI registration item list for an out-of-state employer with an employee working from this state, now.`;

  const response = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 2000,
    system: EMPLOYEE_STATE_GENERIC_SYSTEM_PROMPT,
    messages: [{ role: "user", content: userPrompt }],
    tools: [{ type: "web_search_20250305", name: "web_search" }],
  });

  const text = textFromResponse(response);
  if (!text) throw new Error("Model returned no text content during employee-state research.");
  const parsed = await extractJsonWithSalvage(text, "researchEmployeeStateGeneric");
  return sanitizeItems(parsed.items, ["compliance_name", "due_date_rule"]);
}

// ---------------------------------------------------------------------
// 3. Cheap, company-specific finalization from cached generic items.
// ---------------------------------------------------------------------
const FINALIZE_SYSTEM_PROMPT = `You are finalizing a company-specific US compliance calendar from ALREADY-RESEARCHED generic compliance items.

You will be given: (a) a list of generic state-level and federal-level compliance items with due-date RULES (not yet computed for a specific company), and (b) a specific company's profile (fiscal year, entity type, tax status, foreign ownership).

Your job:
1. For every generic item whose due_date_rule depends on fiscal year end, compute the ACTUAL date for THIS company's fiscal year, and show your work in the description (name the general rule AND the resulting specific date) — in one plain sentence, not a multi-line quote. For items whose due_date_rule depends on the company's incorporation/registration date anniversary instead (e.g. Registered Agent Renewal), compute that using the given Date of Incorporation the same way — the anniversary of the incorporation date, every year, not the fiscal year end and not the annual-report/franchise-tax deadline (those are a different, separate item).
2. Decide which "Conditional" items actually apply given this company's profile, and drop ones that clearly don't (e.g. payroll items if you have no information suggesting employees — keep them but mark applicable_to "If employees" rather than dropping, unless clearly inapplicable).
3. If the profile indicates a foreign parent or related-party transactions, include a "Transfer Pricing" section (documentation, intercompany agreements) if not already present.
4. Only if the profile's "Overseas Direct Investment (ODI) done" field is "Yes", include a "Foreign Reporting (ODI/FEMA)" category. You will normally be given ALREADY-RESEARCHED generic ODI items for this investor type (same as the state/federal items) — just compute each one's actual due date for this company the same way you do for state/federal items, do not re-research them, and do not use web search. Only if no pre-researched ODI items were provided AND the profile says ODI is done, use the web search tool to research RBI filings made by the foreign parent (Annual Performance Report, Foreign Liabilities & Assets Return, event-based ODI reporting) as a one-off fallback. Note clearly these are not US government filings. Summarize everything in your own words — do not paste quoted source sentences into the description field. If ODI done is "No", do NOT include this category at all, even if there is a foreign parent.
5. Do not invent new state/federal/ODI items beyond what was provided, EXCEPT that if a set of "already-researched employee-state payroll items" is provided below, include each one as category "Conditional" and finalize it the same way (compute any FY-dependent dates, otherwise pass its due_date_rule through as-is) — do not merge items from different states together, and do not add employee-state items for any state that wasn't provided.
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

  const employeeStates = (profile.employeeStates || []).filter(
    (s) => s && s !== profile.state
  );
  if (employeeStates.length) {
    p += `\n- Employees also working from (in addition to the state of incorporation): ${employeeStates.join(", ")}. Each of these is a SEPARATE employer registration — state income tax withholding and state unemployment insurance are governed by the state where the EMPLOYEE works, not by ${profile.state}.`;
  }

  if (profile.quarterlyGrossReceipts !== undefined && profile.quarterlyGrossReceipts !== null && profile.quarterlyGrossReceipts !== "") {
    const amt = Number(profile.quarterlyGrossReceipts);
    p += `\n- Average Quarterly Gross Receipts: $${isNaN(amt) ? profile.quarterlyGrossReceipts : amt.toLocaleString("en-US")}`;
  }

  return p;
}

async function finalizeCompanyCalendar(profile, genericItems, odiGenericItems, employeeStateGenericItems) {
  const needsOdi = profile.odiDone === "Yes";
  // Only turn web search on if ODI is actually needed AND we don't already
  // have cached, pre-researched ODI items to hand it — i.e. this should be
  // rare in steady state, once OdiCache is warm for the investor types in
  // use. This replaces the old `!!profile.hasForeignParent` check, which
  // fired a live web_search call on every request for any company with a
  // foreign parent, even when no ODI had actually been done.
  //
  // Employee-state payroll items are NEVER researched here — by the time
  // this function runs, generateCompanyCalendar() has already resolved
  // them via EmployeeStateCache (cache hit) or a one-time-per-state live
  // call upstream, so this function only ever does cheap, no-search date
  // math, on every path, every time.
  const needsSearch = needsOdi && !(odiGenericItems && odiGenericItems.length);

  let userPrompt = `${buildCompanyProfileText(profile)}

Generic items already researched for this jurisdiction/entity type (finalize dates + applicability, do not re-research these):
${JSON.stringify(genericItems, null, 2)}`;

  if (needsOdi && odiGenericItems && odiGenericItems.length) {
    userPrompt += `\n\nGeneric ODI/FEMA items already researched for this investor type (finalize dates only, do not re-research these):
${JSON.stringify(odiGenericItems, null, 2)}`;
  }

  if (employeeStateGenericItems && employeeStateGenericItems.length) {
    userPrompt += `\n\nGeneric employee-state payroll/SUI items already researched (already labeled with the state name — finalize dates only, do not re-research or merge these):
${JSON.stringify(employeeStateGenericItems, null, 2)}`;
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
    const parsed = await extractJsonWithSalvage(text, "finalizeCompanyCalendar");
    return sanitizeItems(parsed.items, ["category", "compliance_name", "due_date"]);
  } catch (err) {
    console.error("extractJson failed (salvage also failed). Raw text was:\n", text);
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

Compute actual due dates specific to the company's financial year where the requirement is tied to fiscal year end (e.g. federal corporate income tax return is generally due the 15th day of the 4th month after fiscal year end) rather than just stating the general rule — show your work by naming both the general rule and the resulting specific date for this company in the description, in one plain sentence. For items tied to the company's incorporation/registration date anniversary instead of fiscal year end (e.g. Registered Agent Renewal — billed/renewed annually on the anniversary of the date the agent was engaged, which for a newly formed company is the date of incorporation, NOT the same date as the annual report/franchise tax deadline), compute the actual date the same way, using the given Date of Incorporation.
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
    const parsed = await extractJsonWithSalvage(text, "fullLiveResearch");
    return sanitizeItems(parsed.items, ["category", "compliance_name", "due_date"]);
  } catch (err) {
    console.error("extractJson failed (salvage also failed). Raw text was:\n", text);
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
// Zero-API-cost items. These depend only on company-supplied facts, not
// on anything that needs verifying against the web, so there is no
// reason to spend a single API credit generating them — they're plain
// JS, computed locally, and just appended to whatever the model produced.
// ---------------------------------------------------------------------
function buildStaticCompanyItems(profile) {
  const items = [];
  const isCorp = (profile.entityType || "").toLowerCase().includes("corp");

  items.push({
    category: "Mandatory Annual",
    compliance_name: "Annual General Meeting (AGM)",
    due_date: "31 December (Annually)",
    applicable_to: isCorp ? "Corporation (per bylaws)" : "If required by bylaws",
    description:
      "Company bylaws require the AGM to be held annually by 31 December; its core agenda item is reviewing the performance targets set for the year against what was actually achieved.",
    authority: "Company Bylaws",
    source_url: "",
    confidence: "high",
  });

  const GRT_THRESHOLD = 300000;
  const receipts =
    profile.quarterlyGrossReceipts !== undefined &&
    profile.quarterlyGrossReceipts !== null &&
    profile.quarterlyGrossReceipts !== ""
      ? Number(profile.quarterlyGrossReceipts)
      : null;

  if (receipts !== null && !isNaN(receipts)) {
    items.push({
      category: "Conditional",
      compliance_name: "Gross Receipts Tax (GRT) Filing",
      due_date:
        receipts <= GRT_THRESHOLD
          ? "Exempt — below filing threshold"
          : "Filing required — confirm exact due date with state Department of Revenue",
      applicable_to: "If gross receipts exceed the state's small-business exemption",
      description:
        receipts <= GRT_THRESHOLD
          ? `At an average of $${receipts.toLocaleString("en-US")}/quarter, the company is at or below the $${GRT_THRESHOLD.toLocaleString("en-US")}/quarter small-business GRT exemption — no GRT filing is currently due; re-check if quarterly receipts rise above this level.`
          : `At an average of $${receipts.toLocaleString("en-US")}/quarter, the company is above the $${GRT_THRESHOLD.toLocaleString("en-US")}/quarter small-business exemption used for this screen, so a GRT filing is likely required — confirm the specific state's rate and due date.`,
      authority: "State Department of Revenue",
      source_url: "",
      confidence: "medium",
    });
  }

  items.push({
    category: "Conditional",
    compliance_name: "Local Business License",
    due_date: "Per local renewal schedule (Annually)",
    applicable_to: "Company",
    description:
      "A local city/county business license is required to operate regardless of revenue or GRT-exemption status — this is separate from any state-level GRT filing.",
    authority: "City/County Licensing Authority",
    source_url: "",
    confidence: "medium",
  });

  return items;
}

// ---------------------------------------------------------------------
// Employee-state payroll/SUI resolution: cache-first, per state. Any
// state already cached and fresh costs nothing here — only states never
// seen before (or stale) trigger a live, per-state research call, and
// that result is cached going forward for every future company.
// ---------------------------------------------------------------------
async function resolveEmployeeStateItems(profile) {
  const states = [...new Set((profile.employeeStates || []).filter((s) => s && s !== profile.state))];
  if (!states.length) return { items: [], anyLive: false };

  const normalized = states.map((s) => EmployeeStateCache.normalizeState(s));
  const docs = await EmployeeStateCache.find({ state: { $in: normalized } });
  const byState = new Map(docs.map((d) => [d.state, d]));

  const items = [];
  let anyLive = false;

  for (const rawState of states) {
    const key = EmployeeStateCache.normalizeState(rawState);
    const doc = byState.get(key);
    if (EmployeeStateCache.isFresh(doc)) {
      items.push(...doc.items);
      continue;
    }
    // Cache miss/stale for this ONE state — research just this state,
    // once, and cache it so no future company ever pays for it again.
    anyLive = true;
    const fresh = await researchEmployeeStateGeneric(rawState);
    items.push(...fresh);
    await EmployeeStateCache.findOneAndUpdate(
      { state: key },
      { state: key, items: fresh, generatedAt: new Date() },
      { upsert: true }
    ).catch((err) => console.error("Employee-state cache backfill failed (non-fatal):", err.message));
  }

  return { items, anyLive };
}

// Converts already-finalized-shape-free employee-state cache items
// (compliance_name/due_date_rule/...) directly into final calendar item
// shape without a model call — used on the fullLiveResearch fallback
// path, where a second API round-trip would be wasted since these items'
// due dates are triggered by hiring, not fiscal year end.
function employeeStateItemsToFinal(items) {
  return items.map((it) => ({
    category: "Conditional",
    compliance_name: it.compliance_name,
    due_date: it.due_date_rule,
    applicable_to: it.applicable_to || "If employees in this state",
    description: it.description || "",
    authority: it.authority || "",
    source_url: it.source_url || "",
    confidence: it.confidence || "medium",
  }));
}

// ---------------------------------------------------------------------
// Orchestrator: cache-first, live fallback. Never calls the live-search
// API for something already sitting in the database and still fresh —
// that's the whole point of StateCache/OdiCache/EmployeeStateCache. The
// only things that ever reach the API are (a) states/investor
// types/employee-states never researched before or gone stale, and
// (b) one cheap, no-search date-finalization call per calendar. AGM,
// GRT-threshold, and business-license items never touch the API at all.
// ---------------------------------------------------------------------
async function generateCompanyCalendar(profile) {
  const state = StateCache.normalizeState(profile.state);
  const entityType = profile.entityType;
  const needsOdi = profile.odiDone === "Yes";

  const [stateDoc, federalDoc, odiDoc, employeeStateResult] = await Promise.all([
    StateCache.findOne({ state, entityType }),
    StateCache.findOne({ state: "FEDERAL", entityType }),
    needsOdi ? OdiCache.findOne({ investorType: profile.odiInvestorType }) : Promise.resolve(null),
    resolveEmployeeStateItems(profile),
  ]);

  const stateFresh = StateCache.isFresh(stateDoc);
  const federalFresh = StateCache.isFresh(federalDoc);
  const odiFresh = !needsOdi || OdiCache.isFresh(odiDoc);
  const employeeStateItems = employeeStateResult.items;
  const employeeStateLive = employeeStateResult.anyLive;
  const staticItems = buildStaticCompanyItems(profile);

  if (stateFresh && federalFresh && odiFresh) {
    // Full cache hit — cheap path, zero web_search calls at all (unless
    // an employee state needed a one-time lookup, handled above).
    const genericItems = [...federalDoc.items, ...stateDoc.items];
    const odiGenericItems = needsOdi ? odiDoc.items : undefined;
    const items = await finalizeCompanyCalendar(profile, genericItems, odiGenericItems, employeeStateItems);
    return { items: [...items, ...staticItems], sourceMode: employeeStateLive ? "mixed" : "cache" };
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
    const items = await finalizeCompanyCalendar(profile, genericItems, odiItems, employeeStateItems);
    return { items: [...items, ...staticItems], sourceMode: "mixed" };
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

  const allItems = [...items, ...employeeStateItemsToFinal(employeeStateItems), ...staticItems];
  return { items: allItems, sourceMode: federalFresh || stateFresh ? "mixed" : "live" };
}

module.exports = {
  researchStateGeneric,
  researchOdiGeneric,
  researchEmployeeStateGeneric,
  finalizeCompanyCalendar,
  fullLiveResearch,
  generateCompanyCalendar,
  extractGenericPortion,
  buildStaticCompanyItems,
};
