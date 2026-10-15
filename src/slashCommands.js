// The bot's slash commands. Every command that has a `description` in its `data` becomes one, and each
// takes one optional text option, "input": whatever you would type after the command name
// (`/db input:list reminders` = `.a db list reminders`). They work in servers, in the bot's DMs and in
// group DMs, so a DM has the same "/" menu as everywhere else.
//
// Registered at start-up when the definitions changed (a hash is kept in data/), and by
// `npm run deploy-commands` for a manual run.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { REST, Routes } from "discord.js";

const STRING_OPTION = 3;
const INPUT_OPTION = { type: STRING_OPTION, name: "input", description: "What you would type after the command name", required: false, max_length: 1000 };
const CONTEXTS = [0, 1, 2]; // a server, the bot's DM, group DMs and other private channels
const INTEGRATION_TYPES = [0]; // installed to a server

const STATE_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "data", "slash-commands.json");

export function buildSlashBody(commands) {
  return [...commands.values()]
    .filter((command) => command.data.description)
    .map(({ data }) => ({ name: data.name, description: data.description, options: [INPUT_OPTION], contexts: CONTEXTS, integration_types: INTEGRATION_TYPES }));
}

// Puts the commands on Discord. With `onlyIfChanged`, nothing is sent when the last registration was identical.
export async function registerSlashCommands({ commands, token, clientId, onlyIfChanged = false, stateFile = STATE_FILE, rest = new REST({ version: "10" }).setToken(token) }) {
  const body = buildSlashBody(commands);
  const hash = crypto.createHash("sha256").update(JSON.stringify(body)).digest("hex");
  if (onlyIfChanged) {
    try {
      if (JSON.parse(fs.readFileSync(stateFile, "utf8")).hash === hash) return { registered: false, count: body.length };
    } catch {
      // no record yet: register
    }
  }
  await rest.put(Routes.applicationCommands(clientId), { body });
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  fs.writeFileSync(stateFile, JSON.stringify({ hash }));
  return { registered: true, count: body.length };
}
