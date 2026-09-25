// lib/securityHeaders.js
//
// Browser security headers on every response (the same set the popular
// "helmet" package applies, tuned for this app):
//
//   Content-Security-Policy  only load scripts/styles/frames from this site
//                            and the few services it really uses: Razorpay
//                            checkout, Google Fonts. Blocks injected
//                            third-party scripts and framing by other sites.
//   Strict-Transport-Security  HTTPS only, for a year (production, over HTTPS)
//   X-Frame-Options / frame-ancestors  no embedding in other sites (click-jacking)
//   X-Content-Type-Options   no MIME sniffing
//   Referrer-Policy          full URLs never leak to other sites
//   Permissions-Policy       no camera / microphone / location access
//   Cross-Origin-Opener-Policy  isolates the window (popups still work for
//                            Razorpay's bank / UPI steps)
//   Cache-Control on /api    client data is never stored in shared caches
//
// If a new page ever needs another outside service and gets blocked, set
// CSP_REPORT_ONLY=true to see the problem in the browser console without
// blocking, then add the domain below.

const RAZORPAY = "https://*.razorpay.com";

const DIRECTIVES = {
  "default-src": ["'self'"],
  // Pages use inline <script> blocks, so 'unsafe-inline' is needed here;
  // everything else about the policy still applies.
  "script-src": ["'self'", "'unsafe-inline'", "https://checkout.razorpay.com"],
  "style-src": ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com", RAZORPAY],
  "font-src": ["'self'", "https://fonts.gstatic.com", "data:", RAZORPAY],
  "img-src": ["'self'", "data:", "blob:", RAZORPAY],
  "connect-src": ["'self'", RAZORPAY],
  "frame-src": [RAZORPAY],
  "form-action": ["'self'", "https://accounts.google.com", RAZORPAY],
  "frame-ancestors": ["'none'"],
  "base-uri": ["'self'"],
  "object-src": ["'none'"],
};

function cspString() {
  const parts = Object.entries(DIRECTIVES).map(([k, v]) => `${k} ${v.join(" ")}`);
  if (process.env.NODE_ENV === "production") parts.push("upgrade-insecure-requests");
  return parts.join("; ");
}

function securityHeaders(req, res, next) {
  const reportOnly = (process.env.CSP_REPORT_ONLY || "").toLowerCase() === "true";
  res.setHeader(reportOnly ? "Content-Security-Policy-Report-Only" : "Content-Security-Policy", cspString());
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=(), usb=(), interest-cohort=()");
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin-allow-popups");
  res.setHeader("X-DNS-Prefetch-Control", "off");
  if (process.env.NODE_ENV === "production" && req.secure) {
    res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  }
  if (req.path.startsWith("/api/")) {
    res.setHeader("Cache-Control", "no-store");
  }
  next();
}

module.exports = { securityHeaders, cspString, DIRECTIVES };
