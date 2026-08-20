// Lightweight HTTP API for voice-Alani (running locally on the user's PC,
// not always online, and with no way to reach orkus-info.db directly —
// it lives only on THIS host's disk) to trigger things here that need a
// live Discord connection or the database. Reminders only for now:
//   POST /voice/reminder         { text, remindAt } -> add
//   GET  /voice/reminders        -> list
//   POST /voice/reminder/delete  { id } -> delete
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

import http from "http";
import { config } from "../../common/config.js";
import { getClient } from "../../common/discordClient.js";
import orkusInfoActions, { addReminderRecord } from "../orkus-info/actions.js";
import { parseIct, fmtIct } from "../orkus-info/format.js";

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

  const { text, remindAt: remindAtRaw } = payload;
  const remindAt = parseIct(remindAtRaw);
  if (!text || !remindAt) {
    return sendJson(res, 400, { error: "text and remindAt (YYYY-MM-DDTHH:MM, 24hr, Indochina Time) are required" });
  }

  if (!config.ownerZeroId) {
    return sendJson(res, 500, { error: "DISCORD_OWNER_0 not configured on the bot — can't set a default DM target" });
  }

  // Voice-added reminders always DM owner_0, never a channel — see the
  // spec this was built against (root README's "Voice bridge" section).
  const reply = await addReminderRecord({
    text,
    remindAt,
    channelId: null,
    createdBy: config.ownerZeroId,
    force: false,
  });

  // Announce it in the command box too, so it's visible there was a
  // voice-originated add, not just a silent DM later.
  try {
    const channel = await getClient().channels.fetch(config.commandBoxChannelId);
    await channel.send(`Added reminder "${text}" at ${fmtIct(remindAt.toISOString())} by voice.`);
  } catch (err) {
    console.error("[voiceApi] failed to announce in command box:", err);
  }

  sendJson(res, 200, { message: reply });
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

export function startVoiceApi() {
  if (!config.voiceApiSecret) {
    console.log("[voiceApi] VOICE_API_SECRET not set — voice bridge disabled");
    return;
  }

  const server = http.createServer(async (req, res) => {
    if (req.headers.authorization !== `Bearer ${config.voiceApiSecret}`) {
      return sendJson(res, 401, { error: "Unauthorized" });
    }

    try {
      if (req.method === "POST" && req.url === "/voice/reminder") {
        return await handleReminder(req, res);
      }
      if (req.method === "GET" && req.url === "/voice/reminders") {
        return await handleListReminders(req, res);
      }
      if (req.method === "POST" && req.url === "/voice/reminder/delete") {
        return await handleDeleteReminder(req, res);
      }
    } catch (err) {
      console.error(`[voiceApi] error handling ${req.method} ${req.url}:`, err);
      return sendJson(res, 500, { error: "Internal error" });
    }

    sendJson(res, 404, { error: "Not found" });
  });

  server.listen(config.voiceApiPort, () => {
    console.log(`[voiceApi] listening on port ${config.voiceApiPort}`);
  });
}
