// lib/asyncErrors.js
//
// Express 4 does not catch errors thrown inside `async` route handlers: the
// request just never gets a response and the browser spins until it times
// out. This patch (the same technique the express-async-errors package
// uses) forwards any rejected promise from a handler to Express's error
// handling, so errorHandler below always answers.
//
// Require this ONCE, before any routes are created (see server.js).

const Layer = require("express/lib/router/layer");

if (!Layer.prototype.__asyncPatched) {
  const original = Layer.prototype.handle_request;
  Layer.prototype.handle_request = function handleAsync(req, res, next) {
    const fn = this.handle;
    if (fn.length > 3) return original.call(this, req, res, next); // error middleware
    try {
      const out = fn(req, res, next);
      if (out && typeof out.catch === "function") out.catch(next);
    } catch (err) {
      next(err);
    }
  };
  Layer.prototype.__asyncPatched = true;
}

/** Last middleware: every unexpected error gets a clear answer and a log line. */
function errorHandler(err, req, res, next) { // eslint-disable-line no-unused-vars
  console.error(`[error] ${req.method} ${req.originalUrl}:`, err && err.stack ? err.stack : err);
  if (res.headersSent) return res.end();
  const status = err.status || err.statusCode || 500;
  const message = status < 500 && err.message ? err.message : "Something went wrong on our side. Please try again; if it keeps happening, contact support.";
  if (req.accepts(["json", "html"]) === "html" && !req.originalUrl.startsWith("/api/")) {
    return res.status(status).type("html").send(`<!DOCTYPE html><meta charset="utf-8"><link rel="stylesheet" href="/shared.css"><div class="wrap" style="max-width:560px;margin:12vh auto;font-family:var(--sans)"><h1 style="font-family:var(--serif)">Something went wrong</h1><p>${status < 500 ? String(message).replace(/[<>&]/g, "") : "Please try again in a moment."}</p><p><a href="/">Go back</a></p></div>`);
  }
  res.status(status).json({ error: message });
}

module.exports = { errorHandler };
