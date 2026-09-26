// routes/whatsapp.routes.js
//
// Meta calls this when something happens on our WhatsApp number
// (lib/whatsapp.js explains the setup):
//
//   GET  /api/webhooks/whatsapp   one-time check when you add the webhook in Meta
//   POST /api/webhooks/whatsapp   delivery updates and client replies
//
// What we do with them:
//   - a message failed to deliver → saved on the client (Admin/staff can see why)
//   - client replies STOP → WhatsApp switched off for them; START → back on
//   - any other reply → added to the client's chat thread, team notified
//
// The POST is signed by Meta with the app secret; unsigned calls are refused.

const Message = require("../models/Message");
const ClientOrg = require("../models/ClientOrg");
const User = require("../models/User");
const whatsapp = require("../lib/whatsapp");
const { notifyStaff } = require("../lib/notify");
const { logActivity } = require("../lib/auditLog");

function verifyHandler(req, res) {
  const { verifyToken } = whatsapp.config();
  if (verifyToken && req.query["hub.mode"] === "subscribe" && req.query["hub.verify_token"] === verifyToken) {
    return res.status(200).type("text/plain").send(String(req.query["hub.challenge"] || ""));
  }
  res.sendStatus(403);
}

async function findOrg(number) {
  if (!number) return null;
  return ClientOrg.findOne({ whatsappNumber: String(number).replace(/\D/g, "") });
}

async function handleEvent(ev) {
  const org = await findOrg(ev.kind === "status" ? ev.to : ev.from);
  if (!org) {
    if (ev.kind === "message") console.log(`[whatsapp] message from unknown number +${ev.from} ignored.`);
    return;
  }

  if (ev.kind === "status") {
    if (ev.status === "failed") {
      org.whatsappLastError = String(ev.error || "Message could not be delivered.").slice(0, 500);
      await org.save();
    } else if (ev.status === "delivered" || ev.status === "read") {
      if (org.whatsappLastError) { org.whatsappLastError = ""; await org.save(); }
    }
    return;
  }

  // An incoming message.
  if (whatsapp.STOP_WORDS.test(ev.text)) {
    if (org.whatsappOptIn) {
      org.whatsappOptIn = false;
      org.whatsappOptOutAt = new Date();
      await org.save();
      logActivity({ actor: { name: `${org.name} (WhatsApp reply)` }, action: "whatsapp_opt_out", summary: `${org.name} replied STOP — WhatsApp messages switched off.`, clientOrgId: org._id });
      notifyStaff({ clientOrgId: org._id, type: "profile_updated", title: `${org.name} switched off WhatsApp messages`, body: "They replied STOP. They'll still get emails.", link: "/admin.html", email: false });
    }
    return;
  }
  if (whatsapp.START_WORDS.test(ev.text)) {
    if (!org.whatsappOptIn) {
      org.whatsappOptIn = true;
      org.whatsappOptInAt = new Date();
      await org.save();
      logActivity({ actor: { name: `${org.name} (WhatsApp reply)` }, action: "whatsapp_opt_in", summary: `${org.name} replied START — WhatsApp messages switched on.`, clientOrgId: org._id });
    }
    return;
  }

  // Anything else: into the chat thread, so the team sees it where they
  // already talk to this client.
  const sender = await User.findOne({ clientOrgId: org._id, role: "client" }).sort({ createdAt: 1 });
  const text = String(ev.text || "").slice(0, 3900);
  if (sender && text) {
    await Message.create({
      clientOrgId: org._id,
      senderId: sender._id,
      senderName: `${ev.name || org.primaryContactName || org.name} (via WhatsApp)`,
      senderRole: "client",
      body: text,
      readByClient: true,
      readByStaff: false,
    });
  }
  await notifyStaff({
    clientOrgId: org._id,
    type: "message",
    title: `WhatsApp reply from ${org.name}`,
    body: `${text.slice(0, 600)}\n\nReply in the client's chat (it's saved there). WhatsApp only lets us reply freely within 24 hours of their message; after that our reminders use the approved templates.`,
    link: "/dashboard.html",
  });
}

async function webhookHandler(req, res) {
  if (!whatsapp.verifySignature(req.body, req.get("x-hub-signature-256"))) {
    console.warn("[whatsapp] webhook call with a missing or wrong signature refused (check WHATSAPP_APP_SECRET).");
    return res.sendStatus(401);
  }
  let payload;
  try { payload = JSON.parse(req.body.toString("utf8")); } catch { return res.sendStatus(400); }
  // Answer Meta straight away; it retries if we're slow.
  res.sendStatus(200);
  for (const ev of whatsapp.parseWebhook(payload)) {
    try { await handleEvent(ev); } catch (err) { console.error("[whatsapp] webhook event failed:", err.message); }
  }
}

module.exports = { verifyHandler, webhookHandler, handleEvent };
