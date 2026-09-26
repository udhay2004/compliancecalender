// lib/whatsapp.js
//
// WhatsApp messages to clients through Meta's official WhatsApp Cloud API.
//
// HOW IT WORKS
//   WhatsApp only lets a business START a conversation with a pre-approved
//   "template" message. We use three Utility templates (the exact wording to
//   submit in Meta's WhatsApp Manager is in TEMPLATE_TEXT below, and is shown
//   on Admin → WhatsApp):
//
//     update      "account_update"     a short account update (quote ready,
//                                       document needs re-uploading, filing
//                                       done, new message from the team)
//     deadline    "deadline_reminder"  the daily deadline digest
//     documents   "documents_needed"   chasing documents we still need
//
//   Clients choose to receive WhatsApp messages in their portal (Meta
//   requires opt-in). Replying STOP turns it off; START turns it back on.
//   Any other reply is put into the client's chat thread for the team.
//
// SETTINGS (Railway variables; see .env.example)
//   WHATSAPP_TOKEN            permanent System User access token
//   WHATSAPP_PHONE_NUMBER_ID  the sender number's ID (not the phone number)
//   WHATSAPP_BUSINESS_ACCOUNT_ID  (optional) lets Admin check template approval
//   WHATSAPP_APP_SECRET       Meta app secret, to verify webhook calls
//   WHATSAPP_VERIFY_TOKEN     any random text; typed into Meta when adding the webhook
//   WHATSAPP_API_VERSION      default v24.0
//   WHATSAPP_TEMPLATE_LANG    default en
//   WHATSAPP_TEMPLATE_UPDATE / _DEADLINE / _DOCUMENTS   template names, if yours differ
//   WHATSAPP_DEFAULT_COUNTRY_CODE  e.g. 1 — used for numbers typed without a +
//
// Without WHATSAPP_TOKEN + WHATSAPP_PHONE_NUMBER_ID nothing is sent: the
// message is written to the log instead (like email without SMTP).
//
// Every send is best-effort: a WhatsApp failure never breaks the action
// that triggered it. The last error is kept on the client (whatsappLastError)
// so the team can see why a client isn't getting messages.

const crypto = require("crypto");

const env = (k, d = "") => (process.env[k] || d).trim();

function config() {
  return {
    token: env("WHATSAPP_TOKEN"),
    phoneNumberId: env("WHATSAPP_PHONE_NUMBER_ID"),
    wabaId: env("WHATSAPP_BUSINESS_ACCOUNT_ID"),
    appSecret: env("WHATSAPP_APP_SECRET"),
    verifyToken: env("WHATSAPP_VERIFY_TOKEN"),
    apiVersion: env("WHATSAPP_API_VERSION", "v24.0"),
    lang: env("WHATSAPP_TEMPLATE_LANG", "en"),
    defaultCountryCode: env("WHATSAPP_DEFAULT_COUNTRY_CODE").replace(/\D/g, ""),
    templates: {
      update: env("WHATSAPP_TEMPLATE_UPDATE", "account_update"),
      deadline: env("WHATSAPP_TEMPLATE_DEADLINE", "deadline_reminder"),
      documents: env("WHATSAPP_TEMPLATE_DOCUMENTS", "documents_needed"),
    },
  };
}

const isConfigured = () => {
  const c = config();
  return Boolean(c.token && c.phoneNumberId);
};

// What to paste into WhatsApp Manager → Message templates → Create template.
// Category: Utility. Language: English. {{1}}, {{2}} … are the variables.
const TEMPLATE_TEXT = {
  update: {
    params: ["contact name", "what happened"],
    body: "Hello {{1}}, there is an update on your ComplyGlobally account: {{2}}. Please open your client portal for the details.",
    sample: ["Jane", "your quote for Form 1120 is ready"],
  },
  deadline: {
    params: ["contact name", "company", "summary"],
    body: "Hello {{1}}, this is your compliance reminder from ComplyGlobally for {{2}}: {{3}}. Please open your client portal to see the dates and next steps.",
    sample: ["Jane", "Acme Inc", "1 filing overdue, 2 due within 7 days"],
  },
  documents: {
    params: ["contact name", "filing", "what we need"],
    body: "Hello {{1}}, we are still waiting for documents for {{2}}: {{3}}. Please upload them in your ComplyGlobally client portal so we can file on time.",
    sample: ["Jane", "Delaware Annual Report", "2 documents, due 1 Mar 2027"],
  },
};

/**
 * The number in the form WhatsApp wants: country code + number, digits only.
 * Numbers typed without "+" only work when WHATSAPP_DEFAULT_COUNTRY_CODE is
 * set (e.g. 1 for the US) and the number is 10 digits long.
 * Returns null when we can't be sure of the country.
 */
function toWhatsAppNumber(raw) {
  if (typeof raw !== "string") return null;
  const s = raw.trim();
  if (!s || !/^[+\d\s().-]+$/.test(s)) return null;
  let digits = s.replace(/\D/g, "");
  if (s.startsWith("+")) {
    // already international
  } else if (digits.startsWith("00")) {
    digits = digits.slice(2);
  } else {
    const cc = config().defaultCountryCode;
    if (!cc || digits.length !== 10) return null;
    digits = cc + digits;
  }
  if (digits.length < 8 || digits.length > 15 || digits.startsWith("0")) return null;
  return digits;
}

const displayNumber = (digits) => (digits ? `+${digits}` : "");

// Template variables can't contain new lines, tabs or runs of spaces, and
// must not be empty.
function cleanParam(value, max = 180) {
  let s = String(value == null ? "" : value)
    .replace(/[\r\n\t]+/g, " · ")
    .replace(/\s{2,}/g, " ")
    .trim();
  if (s.length > max) s = s.slice(0, max - 1).trimEnd() + "…";
  return s || "-";
}

// Plain-English explanations for the errors people actually hit.
const ERROR_HELP = {
  190: "The access token has expired or is wrong. Create a permanent System User token in Meta Business Settings and update WHATSAPP_TOKEN.",
  100: "Meta rejected a setting. Check WHATSAPP_PHONE_NUMBER_ID (it's the ID shown under API Setup, not the phone number).",
  131026: "This number can't receive WhatsApp messages (not on WhatsApp, or it has an old app).",
  131030: "Your WhatsApp number is still a test number, which can only message numbers added to its allowed list in Meta.",
  131047: "WhatsApp only allows template messages here; check the template name settings.",
  131049: "WhatsApp held this message back to protect the user's experience. Try again later.",
  131050: "The client has stopped messages from your business in WhatsApp.",
  131056: "Too many messages to this number in a short time.",
  132000: "The template's number of variables doesn't match. Re-create the template exactly as shown on Admin → WhatsApp.",
  132001: "That template doesn't exist (or isn't approved yet) in this language. Create it in WhatsApp Manager exactly as shown on Admin → WhatsApp.",
  132015: "The template is paused because of low quality. Check WhatsApp Manager.",
  132016: "The template is disabled. Check WhatsApp Manager.",
  133010: "This phone number isn't registered with the Cloud API yet. Finish the number setup in Meta.",
  368: "Meta has restricted this WhatsApp account. Check Business Support Home.",
};

function explainError(data) {
  const e = data?.error || {};
  const code = e.code || e.error_subcode || null;
  const help = ERROR_HELP[code] || ERROR_HELP[e.error_subcode] || "";
  const detail = e.error_data?.details || e.message || "Unknown error";
  return { code, message: help ? `${help} (Meta said: ${detail})` : `Meta said: ${detail}` };
}

async function graph(method, path, body) {
  const c = config();
  const res = await fetch(`https://graph.facebook.com/${c.apiVersion}/${path}`, {
    method,
    headers: { Authorization: `Bearer ${c.token}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15000),
  });
  let data = {};
  try { data = await res.json(); } catch {}
  return { ok: res.ok && !data.error, status: res.status, data };
}

/**
 * Send one template message.
 * @param {{ to: string (digits), kind: "update"|"deadline"|"documents", params: string[] }}
 * @returns {Promise<{ ok: boolean, id?: string, dryRun?: boolean, error?: string, code?: number }>}
 */
async function sendTemplate({ to, kind, params }) {
  const c = config();
  const name = c.templates[kind];
  if (!name) return { ok: false, error: `Unknown WhatsApp message kind "${kind}".` };
  const values = (params || []).map((p) => cleanParam(p));
  if (!isConfigured()) {
    console.log(`[whatsapp] (not set up — would send "${name}" to +${to}): ${values.join(" | ")}`);
    return { ok: false, dryRun: true, error: "WhatsApp is not set up yet." };
  }
  try {
    const r = await graph("POST", `${c.phoneNumberId}/messages`, {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to,
      type: "template",
      template: {
        name,
        language: { code: c.lang },
        components: [{ type: "body", parameters: values.map((text) => ({ type: "text", text })) }],
      },
    });
    if (!r.ok) {
      const why = explainError(r.data);
      console.error(`[whatsapp] send to +${to} failed: ${why.message}`);
      return { ok: false, error: why.message, code: why.code };
    }
    return { ok: true, id: r.data.messages?.[0]?.id || "" };
  } catch (err) {
    const msg = err.name === "TimeoutError" ? "WhatsApp didn't answer in time." : `Couldn't reach WhatsApp: ${err.message}`;
    console.error(`[whatsapp] ${msg}`);
    return { ok: false, error: msg };
  }
}

/** Can we message this client on WhatsApp? */
function canMessage(org) {
  return Boolean(org && org.whatsappOptIn && org.whatsappNumber);
}

/**
 * Send to a client company if they opted in. Records the outcome on the
 * company (whatsappLastSentAt / whatsappLastError). Never throws.
 * params exclude the contact name — it's added as {{1}} here.
 */
async function sendToOrg(org, kind, params) {
  try {
    if (!canMessage(org)) return { ok: false, skipped: true };
    const name = (org.primaryContactName || "").split(/\s+/)[0] || "there";
    const result = await sendTemplate({ to: org.whatsappNumber, kind, params: [name, ...params] });
    if (!result.dryRun) {
      if (result.ok) { org.whatsappLastSentAt = new Date(); org.whatsappLastError = ""; }
      else org.whatsappLastError = String(result.error || "").slice(0, 500);
      if (typeof org.save === "function") await org.save().catch(() => {});
    }
    return result;
  } catch (err) {
    console.error("[whatsapp] sendToOrg failed (non-fatal):", err.message);
    return { ok: false, error: err.message };
  }
}

// ---------------------------------------------------------------------
// Webhook (Meta → us): delivery failures, STOP/START, client replies
// ---------------------------------------------------------------------

/** Meta signs each webhook call with the app secret (X-Hub-Signature-256). */
function verifySignature(rawBody, header) {
  const secret = config().appSecret;
  if (!secret || !header || !Buffer.isBuffer(rawBody)) return false;
  const expected = "sha256=" + crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
  const a = Buffer.from(expected);
  const b = Buffer.from(String(header));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const STOP_WORDS = /^\s*(stop|unsubscribe|stop all|cancel|opt[\s-]?out)\s*[.!]*\s*$/i;
const START_WORDS = /^\s*(start|subscribe|opt[\s-]?in|resume)\s*[.!]*\s*$/i;

/**
 * Flatten Meta's webhook payload into simple events:
 *   { kind: "status", to, status, error }   (sent / delivered / read / failed)
 *   { kind: "message", from, name, text, type }
 */
function parseWebhook(payload) {
  const events = [];
  (payload?.entry || []).forEach((entry) =>
    (entry.changes || []).forEach((change) => {
      const v = change.value || {};
      (v.statuses || []).forEach((s) => {
        const err = (s.errors || [])[0];
        events.push({ kind: "status", to: s.recipient_id, status: s.status, error: err ? explainError({ error: { code: err.code, message: err.title || err.message, error_data: err.error_data } }).message : "" });
      });
      const names = Object.fromEntries((v.contacts || []).map((c) => [c.wa_id, c.profile?.name || ""]));
      (v.messages || []).forEach((m) => {
        let text = "";
        if (m.type === "text") text = m.text?.body || "";
        else if (m.type === "button") text = m.button?.text || "";
        else if (m.type === "interactive") text = m.interactive?.button_reply?.title || m.interactive?.list_reply?.title || "";
        else text = `[${m.type} message — ask them to use the portal to send files]`;
        events.push({ kind: "message", from: m.from, name: names[m.from] || "", text, type: m.type });
      });
    })
  );
  return events;
}

module.exports = {
  config,
  isConfigured,
  TEMPLATE_TEXT,
  toWhatsAppNumber,
  displayNumber,
  cleanParam,
  explainError,
  graph,
  sendTemplate,
  canMessage,
  sendToOrg,
  verifySignature,
  parseWebhook,
  STOP_WORDS,
  START_WORDS,
};
