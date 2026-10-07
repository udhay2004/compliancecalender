// lib/canonicalHost.js
//
// One address for the site. When APP_URL is a custom domain, pages opened
// on any other address (the old *.up.railway.app one, old bookmarks, old
// email links) are sent to the same page on APP_URL.
//
// Why it matters: the sign-in cookie belongs to one host, so a visitor on
// the old address would look signed out, and "Sign in with Google" would
// start on one host and finish on the other.
//
// Left alone on purpose:
//   - /api/...  webhooks (Razorpay, WhatsApp) and calendar feeds people
//               already subscribed to keep working on the old address
//   - anything that isn't a plain page load (GET/HEAD)
//   - local development (NODE_ENV is not "production")

function canonicalHost(req, res, next) {
  if (process.env.NODE_ENV !== "production") return next();
  if (req.method !== "GET" && req.method !== "HEAD") return next();
  if (req.path.startsWith("/api/")) return next();

  let target;
  try {
    target = new URL(process.env.APP_URL);
  } catch (err) {
    return next(); // APP_URL missing or malformed: serve as before
  }
  const host = (req.get("host") || "").toLowerCase();
  if (!host || host === target.host.toLowerCase()) return next();

  res.redirect(301, target.origin + req.originalUrl);
}

module.exports = { canonicalHost };
