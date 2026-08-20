// Thin wrapper around the Google Calendar API — raw REST + fetch, NOT the
// `googleapis` npm package. That package (plus google-auth-library, its
// auth dependency) pulled in a large enough dependency tree to OOM-kill
// `npm install` on bot-hosting.net's free tier (256MB RAM) — this host
// reinstalls the entire tree from scratch on every restart, so dependency
// weight directly costs real reliability here, not just install time.
// Authenticating a Google service account and calling a REST API is
// simple enough to do by hand (this file), matching how this repo
// already talks to Discord's own REST API (see discordApi.js) rather
// than pulling in discord.js's heavier alternatives for that.
//
// Auth: a JWT signed with the service account's private key (Node's
// built-in crypto, RS256), exchanged for a short-lived OAuth access
// token at Google's token endpoint — the standard "service account JWT
// profile" flow, cached and refreshed automatically as it nears expiry.
//
// calendarId is always a parameter, never hardcoded — see
// orkus-info/actions.js for the current caller, and orkus-info/config.js
// for why the calendar ID itself lives in the database's own config, not
// this shared one (the service account/credentials ARE shared bot-wide).
//
// One-way sync only: the local database stays the source of truth, this
// just mirrors adds/edits/deletes out to Google Calendar. Every function
// here is best-effort from the caller's perspective — they catch and log
// rather than let a Google API hiccup block the local database write
// that already succeeded.

import crypto from "crypto";
import { config } from "./config.js";

let cachedToken = null; // { accessToken, expiresAt } — expiresAt in epoch seconds

function base64url(input) {
  return Buffer.from(input).toString("base64url");
}

function getCredentials() {
  if (!config.googleServiceAccountKey) return null;
  return JSON.parse(config.googleServiceAccountKey);
}

// Exchanges the service account's private key for a short-lived access
// token, per Google's OAuth 2.0 JWT bearer flow — no library needed, just
// signing a JWT with the private key and POSTing it. Returns null (not an
// error) if the sync isn't configured at all.
async function getAccessToken() {
  const credentials = getCredentials();
  if (!credentials) return null;

  const now = Math.floor(Date.now() / 1000);
  if (cachedToken && cachedToken.expiresAt > now + 60) {
    return cachedToken.accessToken;
  }

  const header = { alg: "RS256", typ: "JWT" };
  const claims = {
    iss: credentials.client_email,
    scope: "https://www.googleapis.com/auth/calendar",
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600,
  };
  const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(claims))}`;
  const signature = crypto.createSign("RSA-SHA256").update(signingInput).sign(credentials.private_key, "base64url");
  const jwt = `${signingInput}.${signature}`;

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    }),
  });
  if (!res.ok) {
    throw new Error(`Google token exchange failed: ${res.status} ${await res.text()}`);
  }
  const data = await res.json();
  cachedToken = { accessToken: data.access_token, expiresAt: now + data.expires_in };
  return cachedToken.accessToken;
}

// Returns undefined (not an error) if the sync isn't configured — lets
// callers treat "not configured" and "configured but nothing to do"
// (e.g. no calendarId for this particular database) the same way.
async function calendarRequest(method, path, body) {
  const accessToken = await getAccessToken();
  if (!accessToken) return undefined;

  const res = await fetch(`https://www.googleapis.com/calendar/v3${path}`, {
    method,
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!res.ok) {
    const err = new Error(`Google Calendar API ${method} ${path} failed: ${res.status} ${await res.text()}`);
    err.status = res.status;
    throw err;
  }
  return res.status === 204 ? null : res.json();
}

// Returns the created event's Google-side ID (needed later for
// update/delete), or null if the calendar sync isn't configured at all
// (missing key or calendarId — not an error, just means this database
// hasn't set up a calendar yet).
export async function createEvent(calendarId, { summary, start, end }) {
  if (!calendarId) return null;
  const data = await calendarRequest("POST", `/calendars/${encodeURIComponent(calendarId)}/events`, {
    summary,
    start: { dateTime: start.toISOString() },
    end: { dateTime: end.toISOString() },
  });
  return data?.id ?? null;
}

export async function updateEvent(calendarId, googleEventId, { summary, start, end }) {
  if (!calendarId || !googleEventId) return;
  await calendarRequest(
    "PUT",
    `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(googleEventId)}`,
    { summary, start: { dateTime: start.toISOString() }, end: { dateTime: end.toISOString() } }
  );
}

export async function deleteEvent(calendarId, googleEventId) {
  if (!calendarId || !googleEventId) return;
  try {
    await calendarRequest(
      "DELETE",
      `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(googleEventId)}`
    );
  } catch (err) {
    // 404/410 = already gone on the Google side (deleted directly in
    // Google Calendar, say) — not a real error, nothing left to do.
    if (err.status !== 404 && err.status !== 410) throw err;
  }
}
