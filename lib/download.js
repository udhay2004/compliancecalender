// lib/download.js
//
// Streams a stored document to the browser. Used by the staff download
// route (routes/calendar.routes.js) and the client one (routes/portal.routes.js).
//
// Download links are plain <a href> links, so when something goes wrong the
// browser shows whatever we send back. It used to be raw JSON
// ({"error":"File is missing from storage."}) in a blank tab. Now a person
// gets a short page that says what happened and what to do next.

const storage = require("./storage");
const { setDownloadHeaders } = require("./calendarView");

// Types a browser can safely show inline (for "Open" instead of "Download").
// Anything else — HTML, SVG, scripts — is always forced to download.
const INLINE_SAFE = /^(application\/pdf|image\/(png|jpeg|gif|webp)|text\/plain)$/i;

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function page(res, status, { title, body, backHref, backLabel }) {
  res.status(status).type("html").send(`<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title><link rel="stylesheet" href="/shared.css">
<style>
  .box { max-width: 560px; margin: 12vh auto 0; background: var(--card); border: 1px solid var(--rule); border-radius: var(--radius-lg);
         box-shadow: var(--shadow); padding: 32px 34px; font-family: var(--sans); }
  .box h1 { font-family: var(--serif); font-size: 22px; margin: 0 0 10px; }
  .box p { color: var(--ink-soft); font-size: 14.5px; line-height: 1.6; margin: 0 0 12px; }
  .box a.btn { display: inline-block; margin-top: 8px; background: var(--brand); color: #fff; text-decoration: none;
               padding: 10px 18px; border-radius: 6px; font-weight: 600; font-size: 14px; }
</style></head>
<body><div class="wrap"><div class="box"><h1>${esc(title)}</h1>${body}
<a class="btn" href="${esc(backHref)}">${esc(backLabel)}</a></div></div></body></html>`);
}

function wantsHtml(req) {
  return Boolean(req.accepts(["html", "json"]) === "html");
}

/**
 * @param {object} opts
 * @param {"staff"|"client"} opts.audience
 * @param {string} opts.backHref  where the "go back" button points
 */
async function sendStoredFile(req, res, doc, { audience, backHref }) {
  let file;
  try {
    file = await storage.getFile(doc.fileKey);
  } catch (err) {
    console.error("[download] storage error:", err);
    if (!wantsHtml(req)) return res.status(502).json({ error: "Document storage couldn't be reached. Try again in a minute.", code: "STORAGE_UNAVAILABLE" });
    return page(res, 502, {
      title: "We couldn't reach document storage",
      body: `<p>"${esc(doc.fileName)}" is safe, but the storage service didn't respond just now. Please try again in a minute.</p>` +
        (audience === "staff" ? `<p>If this keeps happening, an admin can run <b>Check storage</b> on the Admin page to see what's wrong.</p>` : ""),
      backHref, backLabel: "Go back",
    });
  }

  if (!file) {
    if (!wantsHtml(req)) return res.status(404).json({ error: "This file is no longer in storage.", code: "FILE_MISSING" });
    return page(res, 404, audience === "staff"
      ? {
          title: "This file isn't in storage any more",
          body: `<p>"${esc(doc.fileName)}" was uploaded, but the file itself can't be found. This happens to documents uploaded before cloud storage (R2) was connected: they were saved on the server's own disk, which is cleared on every deploy.</p>` +
            `<p>On the calendar page this document now shows <b>File missing</b> with an <b>Ask client to re-upload</b> button, which notifies the client by email and in their portal.</p>`,
          backHref, backLabel: "Back to the calendar",
        }
      : {
          title: "Please upload this document again",
          body: `<p>We couldn't find the file "${esc(doc.fileName)}" on our side. Sorry about that; it was lost during a system change, not because of anything you did.</p><p>Please upload it again from your portal.</p>`,
          backHref, backLabel: "Back to your portal",
        });
  }

  const inline = req.query.view === "1" && INLINE_SAFE.test(file.contentType || "");
  res.setHeader("Content-Type", inline ? file.contentType : (file.contentType || "application/octet-stream"));
  if (file.contentLength) res.setHeader("Content-Length", String(file.contentLength));
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Cache-Control", "private, no-store");
  if (inline) {
    res.setHeader("Content-Disposition", `inline; filename*=UTF-8''${encodeURIComponent(doc.fileName || "document")}`);
    // A stored file must never run scripts in our origin, even if mislabeled.
    res.setHeader("Content-Security-Policy", "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox");
  } else {
    setDownloadHeaders(res, doc.fileName);
  }
  file.stream.on("error", (err) => {
    console.error("[download] stream error:", err.message);
    if (!res.headersSent) res.status(502).end(); else res.destroy(err);
  });
  file.stream.pipe(res);
}

module.exports = { sendStoredFile };
