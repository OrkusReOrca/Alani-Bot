// Google OAuth access tokens, obtained without any Google client library —
// see googleCalendar.js's header for why this repo keeps its dependency
// tree small (the host reinstalls it on every restart).
//
// Service-account credentials only (JWT bearer flow): non-interactive, used
// for the Calendar API. Tokens are cached per scope and refreshed shortly
// before expiry.

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
