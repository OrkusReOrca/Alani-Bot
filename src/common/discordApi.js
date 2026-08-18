const DISCORD_MAX_LEN = 2000;

// Splits a long message into <=2000-char chunks, breaking on blank lines
// where possible so a program block never gets cut in half.
function chunkMessage(message) {
  if (message.length <= DISCORD_MAX_LEN) return [message];

  const blocks = message.split("\n\n");
  const chunks = [];
  let current = "";

  for (const block of blocks) {
    const candidate = current ? `${current}\n\n${block}` : block;
    if (candidate.length > DISCORD_MAX_LEN) {
      if (current) chunks.push(current);
      current = block;
    } else {
      current = candidate;
    }
  }
  if (current) chunks.push(current);

  return chunks;
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
