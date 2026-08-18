// lib/google.js
//
// Thin wrapper around google-auth-library's OAuth2Client, used only for
// "Sign in with Google" (routes/auth.routes.js's /google and
// /google/callback). Deliberately NOT using passport — this app has no
// other OAuth providers and no session-serialization needs beyond the
// JWT cookie it already has (middleware/auth.js), so a full strategy
// framework would be more machinery than the app needs.

const { OAuth2Client } = require("google-auth-library");

let client = null;
function getClient() {
  if (!client) {
    const required = ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_CALLBACK_URL"];
    const missing = required.filter((key) => !process.env[key]);
    if (missing.length) {
      throw new Error(
        `Google sign-in is misconfigured — missing env var(s): ${missing.join(", ")}. ` +
          "See .env.example for where to get these from Google Cloud Console."
      );
    }
    client = new OAuth2Client(
      process.env.GOOGLE_CLIENT_ID,
      process.env.GOOGLE_CLIENT_SECRET,
      process.env.GOOGLE_CALLBACK_URL
    );
  }
  return client;
}

// Where /api/auth/google redirects the browser to.
function getAuthUrl(state) {
  return getClient().generateAuthUrl({
    access_type: "online", // no refresh token needed — this is login, not ongoing API access
    scope: ["openid", "email", "profile"],
    prompt: "select_account",
    state,
  });
}

// Exchanges the ?code=... query param (set by Google on the callback
// redirect) for tokens, then verifies the ID token and returns the
// verified profile. Throws if the code is invalid/expired/reused.
async function verifyCodeAndGetProfile(code) {
  const oauth2Client = getClient();
  const { tokens } = await oauth2Client.getToken(code);
  const ticket = await oauth2Client.verifyIdToken({
    idToken: tokens.id_token,
    audience: process.env.GOOGLE_CLIENT_ID,
  });
  const payload = ticket.getPayload();
  if (!payload?.email_verified) {
    throw new Error("Google account email is not verified.");
  }
  return {
    googleId: payload.sub,
    email: payload.email.toLowerCase(),
    name: payload.name || "",
  };
}

module.exports = { getAuthUrl, verifyCodeAndGetProfile };
