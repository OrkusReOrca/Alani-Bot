// Thin wrapper around the Google Calendar API, authenticated once as a
// shared service account and reused by any database that wants to sync
// its events to a calendar (calendarId is always a parameter, never
// hardcoded here — see orkus-info/actions.js for the current caller,
// and orkus-info/config.js for why the calendar ID itself lives in the
// database's own config, not this shared one).
//
// One-way sync only: the local database stays the source of truth, this
// just mirrors adds/edits/deletes out to Google Calendar. Every function
// here is best-effort from the caller's perspective — they catch and log
// rather than let a Google API hiccup block the local database write
// that already succeeded.
//
// Auth: a service account (not OAuth) — no interactive consent flow, no
// token refresh to manage. The user creates the calendar themselves in
// their own Google Calendar and shares it WITH the service account
// (write access), rather than the service account owning the calendar
// and sharing it out — keeps calendar management (rename, delete, revoke
// access) in the user's normal Google Calendar UI, not requiring Cloud
// Console for anything after initial setup.

import { google } from "googleapis";
import { config } from "./config.js";

let cachedClient = null;

function getClient() {
  if (cachedClient) return cachedClient;
  if (!config.googleServiceAccountKey) return null;

  const credentials = JSON.parse(config.googleServiceAccountKey);
  const auth = new google.auth.JWT({
    email: credentials.client_email,
    key: credentials.private_key,
    scopes: ["https://www.googleapis.com/auth/calendar"],
  });
  cachedClient = google.calendar({ version: "v3", auth });
  return cachedClient;
}

// Returns the created event's Google-side ID (needed later for
// update/delete), or null if the calendar sync isn't configured at all
// (missing key or calendarId — not an error, just means this database
// hasn't set up a calendar yet).
export async function createEvent(calendarId, { summary, start, end }) {
  const client = getClient();
  if (!client || !calendarId) return null;

  const res = await client.events.insert({
    calendarId,
    requestBody: {
      summary,
      start: { dateTime: start.toISOString() },
      end: { dateTime: end.toISOString() },
    },
  });
  return res.data.id;
}

export async function updateEvent(calendarId, googleEventId, { summary, start, end }) {
  const client = getClient();
  if (!client || !calendarId || !googleEventId) return;

  await client.events.update({
    calendarId,
    eventId: googleEventId,
    requestBody: {
      summary,
      start: { dateTime: start.toISOString() },
      end: { dateTime: end.toISOString() },
    },
  });
}

export async function deleteEvent(calendarId, googleEventId) {
  const client = getClient();
  if (!client || !calendarId || !googleEventId) return;

  try {
    await client.events.delete({ calendarId, eventId: googleEventId });
  } catch (err) {
    // 404/410 = already gone on the Google side (deleted directly in
    // Google Calendar, say) — not a real error, nothing left to do.
    if (err.code !== 404 && err.code !== 410) throw err;
  }
}
