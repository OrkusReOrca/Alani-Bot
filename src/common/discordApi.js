const DISCORD_MAX_LEN = 2000;

// Greedily packs `units` (each already <=max on its own) into <=max chunks,
// joined by `joiner`.
function packUnits(units, joiner) {
  const chunks = [];
  let current = "";

  for (const unit of units) {
    const candidate = current ? `${current}${joiner}${unit}` : unit;
    if (candidate.length > DISCORD_MAX_LEN) {
      if (current) chunks.push(current);
      current = unit;
    } else {
      current = candidate;
    }
  }
  if (current) chunks.push(current);

  return chunks;
}

// Splits a long message into <=2000-char chunks. Prefers breaking on blank
// lines so a paragraph/program block never gets cut in half; falls back to
// single-line boundaries for messages with no blank lines at all (e.g. a
// dense list, one entry per line); falls back to a hard character split as
// a last resort for a single line that's still too long on its own.
function chunkMessage(message) {
  if (message.length <= DISCORD_MAX_LEN) return [message];

  const blocks = message.split("\n\n");
  if (blocks.every((b) => b.length <= DISCORD_MAX_LEN)) {
    return packUnits(blocks, "\n\n");
  }

  // At least one block is itself oversized (or there was only one block to
  // begin with) — split by line instead.
  const lines = message.split("\n");
  if (lines.every((l) => l.length <= DISCORD_MAX_LEN)) {
    return packUnits(lines, "\n");
  }

  // A single line exceeds the limit on its own — hard-split it.
  const hardChunks = [];
  for (let i = 0; i < message.length; i += DISCORD_MAX_LEN) {
    hardChunks.push(message.slice(i, i + DISCORD_MAX_LEN));
  }
  return hardChunks;
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Sending many messages in a burst (e.g. dozens of batched embeds) reliably
// hits Discord's rate limit — retrying with the `retry_after` it tells you
// to wait is expected/normal behavior here, not an error path.
async function discordApi(botToken, path, options = {}, retriesLeft = 5) {
  const res = await fetch(`https://discord.com/api/v10${path}`, {
    ...options,
    headers: {
      Authorization: `Bot ${botToken}`,
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });

  if (res.status === 429 && retriesLeft > 0) {
    const { retry_after } = await res.json();
    const waitMs = Math.ceil((retry_after ?? 1) * 1000) + 50;
    await sleep(waitMs);
    return discordApi(botToken, path, options, retriesLeft - 1);
  }

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Discord API ${path} failed: ${res.status} ${res.statusText} - ${body}`);
  }
  return res.status === 204 ? null : res.json();
}

// Finds the most recent message in a channel with an image attachment,
// e.g. to relay a previously-posted image on demand without regenerating
// it. Returns { url, filename } or null if none of the last `limit`
// messages has one.
export async function getLatestImageAttachment(botToken, channelId, limit = 10) {
  const messages = await discordApi(botToken, `/channels/${channelId}/messages?limit=${limit}`);
  for (const msg of messages) {
    const attachment = msg.attachments?.find((a) => a.content_type?.startsWith("image/"));
    if (attachment) return { url: attachment.url, filename: attachment.filename };
  }
  return null;
}

export async function sendViaDM(botToken, userId, message) {
  const dmChannel = await discordApi(botToken, "/users/@me/channels", {
    method: "POST",
    body: JSON.stringify({ recipient_id: userId }),
  });

  const chunks = chunkMessage(message);
  for (const content of chunks) {
    await discordApi(botToken, `/channels/${dmChannel.id}/messages`, {
      method: "POST",
      body: JSON.stringify({ content }),
    });
  }
}

export async function sendViaBotChannel(botToken, channelId, message) {
  const chunks = chunkMessage(message);
  for (const content of chunks) {
    await discordApi(botToken, `/channels/${channelId}/messages`, {
      method: "POST",
      body: JSON.stringify({ content }),
    });
  }
}

// Sends a binary file (e.g. a generated PNG) as a message attachment.
// Uses multipart/form-data, NOT the JSON path above — fetch sets its own
// Content-Type with the multipart boundary when given a FormData body, so
// this deliberately doesn't go through discordApi()'s JSON header default.
export async function sendFileViaBotChannel(
  botToken,
  channelId,
  buffer,
  filename,
  content = "",
  retriesLeft = 5
) {
  const form = new FormData();
  form.append("payload_json", JSON.stringify({ content }));
  form.append("files[0]", new Blob([buffer]), filename);

  const res = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
    method: "POST",
    headers: { Authorization: `Bot ${botToken}` },
    body: form,
  });

  if (res.status === 429 && retriesLeft > 0) {
    const { retry_after } = await res.json();
    await sleep(Math.ceil((retry_after ?? 1) * 1000) + 50);
    return sendFileViaBotChannel(botToken, channelId, buffer, filename, content, retriesLeft - 1);
  }

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Discord file send failed: ${res.status} ${res.statusText} - ${body}`);
  }
}
