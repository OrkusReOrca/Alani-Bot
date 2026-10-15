import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { commands } from "../src/commands.js";
import { buildSlashBody, registerSlashCommands } from "../src/slashCommands.js";

test("every command with a description is a slash command, usable in servers and in DMs", () => {
  const body = buildSlashBody(commands);
  const names = body.map((c) => c.name).sort();
  assert.deepEqual(names, ["account", "at", "avc", "db", "fjamtrack", "info", "list"]);
  for (const command of body) {
    assert.deepEqual(command.contexts, [0, 1, 2], `${command.name} must be available in the bot's DM`);
    assert.deepEqual(command.integration_types, [0]);
    assert.equal(command.options[0].name, "input");
    assert.equal(command.options[0].required, false);
    assert.ok(command.description.length > 0 && command.description.length <= 100);
  }
});

test("registration happens when the commands changed, and not again while they are the same", async () => {
  const stateFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "slash-")), "slash.json");
  const puts = [];
  const rest = { put: async (route, { body }) => puts.push({ route, count: body.length }) };
  const args = { commands, clientId: "123", onlyIfChanged: true, stateFile, rest };

  assert.deepEqual(await registerSlashCommands(args), { registered: true, count: 7 });
  assert.deepEqual(await registerSlashCommands(args), { registered: false, count: 7 });
  assert.equal(puts.length, 1);
  assert.match(puts[0].route, /applications\/123\/commands$/);

  // forcing (npm run deploy-commands) always registers
  await registerSlashCommands({ ...args, onlyIfChanged: false });
  assert.equal(puts.length, 2);

  // a changed definition registers again
  const changed = new Map(commands);
  changed.set("account", { ...commands.get("account"), data: { name: "account", description: "Something else" } });
  assert.equal((await registerSlashCommands({ ...args, commands: changed })).registered, true);
});
