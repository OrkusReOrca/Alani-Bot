// Lightweight HTTP API for voice-Alani (running locally on the user's PC,
// not always online, and with no way to reach orkus-info.db directly —
// it lives only on THIS host's disk) to trigger things here that need a
// live Discord connection or the database.
//   GET  /voice/databases        -> list every database (name, kind) —
//                                  voice-Alani always authenticates as
//                                  DISCORD_OWNER_0, so it can see
//                                  everything, same as any bot owner
//   POST /voice/reminder         { text, remindAt, database?, channelId? } -> add
//                                  (database omitted = "main"; channelId
//                                  omitted = DM, same as before)
//   GET  /voice/reminders        -> list (Main tier only, unchanged)
//   POST /voice/reminder/delete  { id } -> delete (Main tier only, unchanged)
//   POST /voice/event            { title, start, end?, allDay?, database? } -> add
//                                  (end omitted = 1hr duration, allDay
//                                  true = all-day event; database omitted
//                                  = "main", which also syncs to Google
//                                  Calendar same as the chat command —
//                                  other databases never sync there)
//   GET  /voice/events           -> list (Main tier only, unchanged)
//   POST /voice/event/delete     { id } -> delete (Main tier only, unchanged)
//
// Not routed through Discord itself, deliberately: this bot's own
// messageCreate handler ignores messages from any bot account
// (message.author.bot), so voice-Alani posting via its own bot identity
// or a webhook would never reach the ".a db" command parser anyway — and
// even if it did, the owner check keys off a real Discord user ID, which
// neither a webhook nor a second bot has. A small authenticated HTTP
// endpoint sidesteps both problems and is the actually-correct way to
// bridge two independent services, rather than working around Discord's
// bot-message-ignore behavior.
//
// Auth: a single shared secret (VOICE_API_SECRET), checked as a bearer
// token. No TLS termination on bot-hosting.net's exposed port (no reverse
// proxy in front, per their own docs) — so this secret travels in
// cleartext over the public internet on every call. Acceptable for a
// personal hobby bridge; if that's ever a real concern, put a domain +
// TLS in front (bot-hosting.net's "Domains" feature) rather than trusting
// this endpoint bare.
//
// The add/database-listing routes CAN now reach any database (added for
// voice-Alani's "console add" manual-entry UI — a click-driven form, not
// LLM/spoken tool-calling) — resolved the same way command.js resolves
// an explicit name, via store.js, falling back to orkus-info/actions.js
// only for "main". The LLM-facing spoken tools (tools.py's set_reminder/
// add_calendar_event) deliberately still only ever call this with no
// database/channelId fields at all, so spoken reminders/events stay
// exactly Main+DM, unchanged — this is a widening of what the BRIDGE can
// do, not what voice conversation itself does. List/delete routes are
// intentionally NOT widened (out of scope, Main tier only for now).

import { config } from "../../common/config.js";
import { getClient } from "../../common/discordClient.js";
import orkusInfoActions, { addReminderRecord } from "../orkus-info/actions.js";
import { parseIct, fmtIct } from "../orkus-info/format.js";
import * as store from "./store.js";
import { actionsForInstance } from "../../common/dbInstanceActions.js";

// Resolves a database name to either the special "main" sentinel or a
// real store.js instance row — shared by the reminder/event add routes
// below. Always includeAll: true, since voice-Alani acts with bot-owner
// privileges (matches config.ownerZeroId, which every route here already
// assumes for Main's own DM-default behavior).
function resolveDatabase(name) {
  const normalized = (name || "main").toLowerCase();
  if (normalized === "main" || normalized === "orkus-info") return { kind: "main" };
  return store.getDatabaseByName(normalized, config.ownerZeroId, { includeAll: true });
}

function sendJson(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

async function readBody(req) {
  let body = "";
  for await (const chunk of req) body += chunk;
  return body;
}

async function handleReminder(req, res) {
  let payload;
  try {
    payload = JSON.parse(await readBody(req));
  } catch {
    return sendJson(res, 400, { error: "Invalid JSON body" });
  }

  const { text, remindAt: remindAtRaw, database, channelId = null } = payload;
  const remindAt = parseIct(remindAtRaw);
  if (!text || !remindAt) {
    return sendJson(res, 400, { error: "text and remindAt (YYYY-MM-DDTHH:MM, 24hr, Indochina Time) are required" });
  }

  if (!config.ownerZeroId) {
    return sendJson(res, 500, { error: "DISCORD_OWNER_0 not configured on the bot — can't set a default DM target" });
  }

  const resolved = resolveDatabase(database);
  if (!resolved) {
    return sendJson(res, 400, { error: `No database "${database}"` });
  }

  // Main tier: unchanged behavior — always DM owner_0, never a channel,
  // unless the spoken/tool-calling path is used (which never sends
  // channelId at all, so this only ever changes for the console-add UI's
  // explicit channel field). Other databases: same addReminderRecord
  // shape, just against that instance instead — see
  // common/dbInstanceActions.js.
  const reply =
    resolved.kind === "main"
      ? await addReminderRecord({ text, remindAt, channelId, createdBy: config.ownerZeroId, force: false })
      : await actionsForInstance(resolved).addReminderRecord({
          text,
          remindAt,
          channelId,
          createdBy: config.ownerZeroId,
          force: false,
        });

  // Announce it in the command box too, so it's visible there was a
  // voice-originated add, not just a silent DM later. Best-effort,
  // regardless of which database this landed in.
  try {
    const channel = await getClient().channels.fetch(config.commandBoxChannelId);
    await channel.send(`Added reminder "${text}" at ${fmtIct(remindAt.toISOString())} by voice.`);
  } catch (err) {
    console.error("[voiceApi] failed to announce in command box:", err);
  }

  sendJson(res, 200, { message: reply });
}

async function handleListDatabases(req, res) {
  const rows = store.listAccessibleDatabases(config.ownerZeroId, { includeAll: true });
  const databases = [{ name: "main", kind: "main" }, ...rows.map((r) => ({ name: r.name, kind: r.kind }))];
  sendJson(res, 200, { databases });
}

// Reuses the exact same dispatcher the chat command goes through
// (list(["reminders"]) / delete(["reminder", id])) rather than
// duplicating the query/format logic here — no ownership scoping on
// either side (any owner, or voice, can list/delete any reminder,
// matching ".a db list/delete reminder" today).
async function handleListReminders(req, res) {
  const message = await orkusInfoActions.list(["reminders"]);
  sendJson(res, 200, { message });
}

async function handleDeleteReminder(req, res) {
  let payload;
  try {
    payload = JSON.parse(await readBody(req));
  } catch {
    return sendJson(res, 400, { error: "Invalid JSON body" });
  }

  const { id } = payload;
  if (!id) return sendJson(res, 400, { error: "id is required" });

  const message = await orkusInfoActions.delete(["reminder", String(id)]);
  sendJson(res, 200, { message });
}

// Events' title is now a double-quoted "name" field in the chat grammar
// (see common/textParsing.js's extractQuoted, and actions.js's addEvent)
// — since this handler forwards to that same token-based dispatcher
// rather than a JSON-native insert path (events never got the direct-call
// treatment addReminderRecord did), it has to fake the quote marks onto
// the token array itself: a multi-word title becomes ["\"first", "word",
// "last\""], not a single already-quoted string, matching exactly what
// the chat tokenizer would have produced from someone typing it.
function quoteTokens(text) {
  const words = text.trim().split(/\s+/);
  if (words.length === 1) return [`"${words[0]}"`];
  return [`"${words[0]}`, ...words.slice(1, -1), `${words[words.length - 1]}"`];
}

// Events: no owner/DM defaulting to work out like reminders needed —
// they don't have a "who gets notified" concept, so this just forwards
// straight to the same dispatcher the chat command uses. end/allDay are
// both optional — omitted end defaults to 1hr duration, allDay:true
// makes it an all-day event instead — same as the chat command's
// "<start> [end|allday] <title>" shorthand (see actions.js's addEvent),
// just via explicit fields here instead of positional-token guessing,
// since this is JSON not chat tokens.
async function handleAddEvent(req, res) {
  let payload;
  try {
    payload = JSON.parse(await readBody(req));
  } catch {
    return sendJson(res, 400, { error: "Invalid JSON body" });
  }

  const { title, start, end, allDay, database } = payload;
  if (!title || !parseIct(start)) {
    return sendJson(res, 400, { error: "title and start (YYYY-MM-DDTHH:MM, 24hr, Indochina Time) are required" });
  }

  const resolved = resolveDatabase(database);
  if (!resolved) {
    return sendJson(res, 400, { error: `No database "${database}"` });
  }

  const titleTokens = quoteTokens(title);
  const eventArgs = allDay ? [start, "allday", ...titleTokens] : end ? [start, end, ...titleTokens] : [start, ...titleTokens];

  const message =
    resolved.kind === "main"
      ? await orkusInfoActions.add(["event", ...eventArgs])
      : await actionsForInstance(resolved).addEvent(eventArgs, { userId: config.ownerZeroId, guildId: resolved.guild_id });
  sendJson(res, 200, { message });
}

async function handleListEvents(req, res) {
  const message = await orkusInfoActions.list(["events"]);
  sendJson(res, 200, { message });
}

async function handleDeleteEvent(req, res) {
  let payload;
  try {
    payload = JSON.parse(await readBody(req));
  } catch {
    return sendJson(res, 400, { error: "Invalid JSON body" });
  }

  const { id } = payload;
  if (!id) return sendJson(res, 400, { error: "id is required" });

  const message = await orkusInfoActions.delete(["event", String(id)]);
  sendJson(res, 200, { message });
}

// Registers every /voice/* route into the shared bridge server (see
// common/bridgeServer.js) under VOICE_API_SECRET.
export function registerVoiceRoutes(registerRoute) {
  if (!config.voiceApiSecret) {
    console.log("[voiceApi] VOICE_API_SECRET not set — voice bridge disabled");
    return;
  }

  registerRoute("GET", "/voice/databases", config.voiceApiSecret, handleListDatabases);
  registerRoute("POST", "/voice/reminder", config.voiceApiSecret, handleReminder);
  registerRoute("GET", "/voice/reminders", config.voiceApiSecret, handleListReminders);
  registerRoute("POST", "/voice/reminder/delete", config.voiceApiSecret, handleDeleteReminder);
  registerRoute("POST", "/voice/event", config.voiceApiSecret, handleAddEvent);
  registerRoute("GET", "/voice/events", config.voiceApiSecret, handleListEvents);
  registerRoute("POST", "/voice/event/delete", config.voiceApiSecret, handleDeleteEvent);
}
