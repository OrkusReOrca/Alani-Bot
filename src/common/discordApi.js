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

async function discordApi(botToken, path, options = {}) {
  const res = await fetch(`https://discord.com/api/v10${path}`, {
    ...options,
    headers: {
      Authorization: `Bot ${botToken}`,
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });
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

// Sends one message containing 1+ rich embeds (title + large image +
// fields) rather than plain text — Discord renders embed.image inline and
// large, which a plain-content image URL only does as a small unfurled
// preview. Each embed in the array renders as its own card within the
// single message (Discord allows up to 10 per message).
export async function sendEmbedsViaBotChannel(botToken, channelId, embeds) {
  await discordApi(botToken, `/channels/${channelId}/messages`, {
    method: "POST",
    body: JSON.stringify({ embeds }),
  });
}

export async function sendEmbedViaBotChannel(botToken, channelId, embed) {
  await sendEmbedsViaBotChannel(botToken, channelId, [embed]);
}
