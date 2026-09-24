// Google OAuth access tokens, obtained without any Google client library —
// see googleCalendar.js's header for why this repo keeps its dependency
// tree small (the host reinstalls it on every restart).
//
// Two credential kinds, because they have different powers:
//   - service account (JWT bearer flow): non-interactive, used for the
//     Calendar API. It cannot create Drive files (no storage quota).
//   - OAuth refresh token (a real user's consent): acts as that user, so
//     it can create Drive files in that user's own storage.
// Tokens are cached per credential/scope and refreshed shortly before expiry.

import crypto from "crypto";
import { config } from "./config.js";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const REFRESH_MARGIN_SECONDS = 60;

const tokenCache = new Map(); // cache key -> { accessToken, expiresAt (epoch seconds) }

const base64url = (input) => Buffer.from(input).toString("base64url");
const nowSeconds = () => Math.floor(Date.now() / 1000);

async function cached(cacheKey, fetchToken) {
  const hit = tokenCache.get(cacheKey);
  if (hit && hit.expiresAt > nowSeconds() + REFRESH_MARGIN_SECONDS) return hit.accessToken;

  const { access_token: accessToken, expires_in: expiresIn } = await fetchToken();
  tokenCache.set(cacheKey, { accessToken, expiresAt: nowSeconds() + expiresIn });
  return accessToken;
}

async function requestToken(params) {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params),
  });
  if (!res.ok) throw new Error(`Google token request failed: ${res.status} ${await res.text()}`);
  return res.json();
}

// Access token for the service account in GOOGLE_SERVICE_ACCOUNT_KEY, or
// null if none is configured (callers treat "not configured" as "skip").
export async function getServiceAccountToken(scope) {
  if (!config.googleServiceAccountKey) return null;
  const credentials = JSON.parse(config.googleServiceAccountKey);

  return cached(`service-account:${scope}`, () => {
    const now = nowSeconds();
    const claims = { iss: credentials.client_email, scope, aud: TOKEN_URL, iat: now, exp: now + 3600 };
    const signingInput = `${base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${base64url(JSON.stringify(claims))}`;
    const signature = crypto.createSign("RSA-SHA256").update(signingInput).sign(credentials.private_key, "base64url");
    return requestToken({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: `${signingInput}.${signature}`,
    });
  });
}

export function isOAuthConfigured() {
  return Boolean(config.googleOAuthClientId && config.googleOAuthClientSecret && config.googleOAuthRefreshToken);
}

// Access token acting as the user who granted the refresh token.
export async function getOAuthToken() {
  if (!isOAuthConfigured()) {
    throw new Error("Google OAuth isn't configured — set GOOGLE_OAUTH_CLIENT_ID/_CLIENT_SECRET/_REFRESH_TOKEN");
  }
  return cached("oauth-user", () =>
    requestToken({
      grant_type: "refresh_token",
      client_id: config.googleOAuthClientId,
      client_secret: config.googleOAuthClientSecret,
      refresh_token: config.googleOAuthRefreshToken,
    })
  );
}
