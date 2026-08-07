// routes/auth.routes.js
//
// Self-signup with email/password (per spec: "anyone can self-signup").
// Every logged-in user can generate AND review/approve calendars — there's
// no separate "reviewer" role right now, by design (small trusted team).

const express = require("express");
const User = require("../models/User");
const { setSessionCookie, clearSessionCookie, requireAuth } = require("../middleware/auth");
const { notifyAdminOfSignup, notifyUserApproved, notifyUserRejected } = require("../lib/email");

const router = express.Router();

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

router.post("/signup", async (req, res) => {
  try {
    const { email, password, name } = req.body || {};
    if (!email || !isValidEmail(email)) {
      return res.status(400).json({ error: "Valid email required." });
    }
    if (!password || password.length < 8) {
      return res.status(400).json({ error: "Password must be at least 8 characters." });
    }

    const existing = await User.findOne({ email: email.toLowerCase().trim() });
    if (existing) {
      return res.status(409).json({ error: "An account with that email already exists." });
    }

    const user = new User({
      email: email.toLowerCase().trim(),
      name: (name || "").trim(),
      status: "pending", // explicit, NOT relying on the schema default (see models/User.js)
    });
    await user.setPassword(password);
    // One token, used by both the /approve and /reject links — whichever
    // one the admin clicks consumes it, so the other link stops working
    // immediately afterward (no way to "un-approve" via a stale email).
    const token = user.generateApprovalToken();
    await user.save();

    // Don't log the pending user in — no session cookie until approved.
    try {
      await notifyAdminOfSignup(user, token, token);
    } catch (mailErr) {
      // Don't fail the signup just because email delivery had a hiccup —
      // the account still exists as "pending" and can be approved once
      // email is fixed, or manually in the database.
      console.error("Failed to send admin approval-request email:", mailErr.message);
    }

    return res.status(201).json({
      pending: true,
      message: "Account created. An admin will review your request — you'll get an email once it's approved.",
    });
  } catch (err) {
    console.error("Signup error:", err);
    return res.status(500).json({ error: "Signup failed. Try again." });
  }
});

router.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) {
      return res.status(400).json({ error: "Email and password required." });
    }
    const user = await User.findOne({ email: email.toLowerCase().trim() });
    if (!user) return res.status(401).json({ error: "Invalid email or password." });

    const ok = await user.checkPassword(password);
    if (!ok) return res.status(401).json({ error: "Invalid email or password." });

    if (user.status === "pending") {
      return res.status(403).json({
        error: "Your account is awaiting admin approval. You'll get an email once it's approved.",
      });
    }
    if (user.status === "rejected") {
      return res.status(403).json({
        error: "Your access request was not approved.",
      });
    }

    setSessionCookie(res, user);
    return res.json({ user: user.toSafeJSON() });
  } catch (err) {
    console.error("Login error:", err);
    return res.status(500).json({ error: "Login failed. Try again." });
  }
});

// ---------------------------------------------------------------------
// Approve / reject links from the admin-notification email. Intentionally
// NOT behind requireAuth — the token itself is the credential, so the
// admin can act with one click straight from their inbox. Each token is
// single-use (cleared immediately on first use) and expires after 7 days
// (set in User.generateApprovalToken). GET, not POST, because email
// clients only follow plain links.
// ---------------------------------------------------------------------
function renderResult(res, status, title, message) {
  res.status(status).send(`<!DOCTYPE html><html><head><meta charset="UTF-8">
<title>${title}</title>
<style>body{font-family:-apple-system,system-ui,sans-serif;max-width:480px;margin:80px auto;padding:0 24px;color:#1a1a1a;}
h1{font-size:20px;}p{color:#555;line-height:1.5;}</style></head>
<body><h1>${title}</h1><p>${message}</p></body></html>`);
}

router.get("/approve/:token", async (req, res) => {
  try {
    const user = await User.findOne({
      approvalToken: req.params.token,
      approvalTokenExpires: { $gt: new Date() },
    }).select("+approvalToken +approvalTokenExpires");

    if (!user) {
      return renderResult(
        res, 400, "Link expired or already used",
        "This approval link is invalid, expired, or has already been used."
      );
    }
    if (user.status !== "pending") {
      return renderResult(res, 200, "Already handled", `This account is already marked as "${user.status}".`);
    }

    user.status = "approved";
    user.approvalToken = null;
    user.approvalTokenExpires = null;
    await user.save();

    notifyUserApproved(user).catch((err) => console.error("Failed to send approval email to user:", err.message));

    return renderResult(res, 200, "Account approved", `${user.email} can now log in.`);
  } catch (err) {
    console.error("Approve error:", err);
    return renderResult(res, 500, "Something went wrong", "Please try again or check the server logs.");
  }
});

router.get("/reject/:token", async (req, res) => {
  try {
    const user = await User.findOne({
      approvalToken: req.params.token,
      approvalTokenExpires: { $gt: new Date() },
    }).select("+approvalToken +approvalTokenExpires");

    if (!user) {
      return renderResult(
        res, 400, "Link expired or already used",
        "This link is invalid, expired, or has already been used."
      );
    }
    if (user.status !== "pending") {
      return renderResult(res, 200, "Already handled", `This account is already marked as "${user.status}".`);
    }

    user.status = "rejected";
    user.approvalToken = null;
    user.approvalTokenExpires = null;
    await user.save();

    notifyUserRejected(user).catch((err) => console.error("Failed to send rejection email to user:", err.message));

    return renderResult(res, 200, "Request rejected", `${user.email} has been marked as rejected.`);
  } catch (err) {
    console.error("Reject error:", err);
    return renderResult(res, 500, "Something went wrong", "Please try again or check the server logs.");
  }
});

router.post("/logout", (req, res) => {
  clearSessionCookie(res);
  return res.json({ ok: true });
});

router.get("/me", requireAuth, async (req, res) => {
  const user = await User.findById(req.user.sub);
  if (!user) return res.status(401).json({ error: "User not found." });
  return res.json({ user: user.toSafeJSON() });
});

module.exports = router;
