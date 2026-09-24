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
// Auth: service-account access tokens, see googleAuth.js.
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

import { getServiceAccountToken } from "./googleAuth.js";

const CALENDAR_SCOPE = "https://www.googleapis.com/auth/calendar";

// Returns undefined (not an error) if the sync isn't configured — lets
// callers treat "not configured" and "configured but nothing to do"
// (e.g. no calendarId for this particular database) the same way.
async function calendarRequest(method, path, body) {
  const accessToken = await getServiceAccountToken(CALENDAR_SCOPE);
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

// start/end: Date objects for a timed event, or "YYYY-MM-DD" strings for
// an all-day one (allDay: true) — Google represents these two cases with
// genuinely different field shapes (dateTime vs date), not just a time of
// 00:00, so the caller (orkus-info/actions.js) decides which to build
// rather than this file guessing from the value's shape.
function eventTimeFields(start, end, allDay) {
  return allDay
    ? { start: { date: start }, end: { date: end } }
    : { start: { dateTime: start.toISOString() }, end: { dateTime: end.toISOString() } };
}

// Returns the created event's Google-side ID (needed later for
// update/delete), or null if the calendar sync isn't configured at all
// (missing key or calendarId — not an error, just means this database
// hasn't set up a calendar yet).
export async function createEvent(calendarId, { summary, start, end, allDay = false }) {
  if (!calendarId) return null;
  const data = await calendarRequest("POST", `/calendars/${encodeURIComponent(calendarId)}/events`, {
    summary,
    ...eventTimeFields(start, end, allDay),
  });
  return data?.id ?? null;
}

export async function updateEvent(calendarId, googleEventId, { summary, start, end, allDay = false }) {
  if (!calendarId || !googleEventId) return;
  await calendarRequest(
    "PUT",
    `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(googleEventId)}`,
    { summary, ...eventTimeFields(start, end, allDay) }
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
