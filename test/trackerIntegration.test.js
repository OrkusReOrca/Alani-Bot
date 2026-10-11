import { test } from "node:test";
import assert from "node:assert/strict";

process.env.DISCORD_OWNER_0 = "100000000000000001";

const { parseCommandLine } = await import("../src/common/commandParsing.js");
const { parseAiInvocation } = await import("../src/features/ai-assistant/handler.js");
const { commands } = await import("../src/commands.js");
const { buildSystemPrompt } = await import("../src/features/ai-assistant/prompt.js");
const { TAG_DEFINITIONS, canonicalTag } = await import("../src/features/tags/store.js");
const { BACKUP_GROUPS } = await import("../src/features/cloud-backup/groups.js");
const { listDataTables } = await import("../src/features/cloud-backup/changeLog.js");
const tagCommand = await import("../src/features/tags/command.js");

// ---------- the prefix, and dropping it in DMs ----------
test(".at is a command prefix of its own, in servers and DMs", () => {
  assert.deepEqual(parseCommandLine('.at bp list'), { name: "at", args: ["bp", "list"] });
  assert.deepEqual(parseCommandLine(".AT la bp 120 80"), { name: "at", args: ["la", "bp", "120", "80"] });
  assert.deepEqual(parseCommandLine('.at create type:"Bloodpressure tracker" me').args.slice(0, 2), ["create", 'type:"Bloodpressure']);
  assert.equal(parseCommandLine("at bp list"), null); // in a server the dot is required
  assert.equal(parseCommandLine(".attack"), null);
});

test("in a DM the leading .a can be dropped: t for .at, vc for .avc, and every command name", () => {
  const dm = { dm: true };
  assert.deepEqual(parseCommandLine("t p list bpl", dm), { name: "at", args: ["p", "list", "bpl"] });
  assert.deepEqual(parseCommandLine("T bp list", dm), { name: "at", args: ["bp", "list"] });
  assert.deepEqual(parseCommandLine("vc list m", dm), { name: "avc", args: ["list", "m"] });
  assert.deepEqual(parseCommandLine("info db", dm), { name: "info", args: ["db"] });
  assert.deepEqual(parseCommandLine("db list reminders", dm), { name: "db", args: ["list", "reminders"] });
  assert.deepEqual(parseCommandLine("tag list", dm), { name: "tag", args: ["list"] });

  // The dotted forms still work in a DM.
  assert.deepEqual(parseCommandLine(".at bp list", dm), { name: "at", args: ["bp", "list"] });
  assert.deepEqual(parseCommandLine(".a info", dm), { name: "info", args: [] });
  assert.deepEqual(parseCommandLine(".avc q", dm), { name: "avc", args: ["q"] });
});

test("the dropped prefix is a DM-only convenience; in a server only the dotted forms count", () => {
  for (const text of ["t bp list", "info", "db list", "vc list", "hello there"]) assert.equal(parseCommandLine(text), null, text);
  assert.equal(parseCommandLine("   ", { dm: true }), null);
});

test("ordinary DM chat turns into a 'command' that no command matches, so it's ignored", () => {
  const parsed = parseCommandLine("hello there, how are you", { dm: true });
  assert.equal(commands.has(parsed.name), false);
  assert.equal(commands.has(parseCommandLine("yes", { dm: true }).name), false); // pill answers are never swallowed as a command
  assert.equal(commands.has(parseCommandLine("y", { dm: true }).name), false);
  assert.equal(commands.has(parseCommandLine("no", { dm: true }).name), false);
});

test(".aii loses its dot in a DM too (ii), but not in a server", () => {
  assert.equal(parseAiInvocation("ii add a reminder", { dm: true }), "add a reminder");
  assert.equal(parseAiInvocation(".aii add a reminder", { dm: true }), "add a reminder");
  assert.equal(parseAiInvocation("ii add a reminder"), null);
  assert.equal(parseAiInvocation(".aii add a reminder"), "add a reminder");
  assert.equal(parseAiInvocation("iii", { dm: true }), null);
});

// ---------- registration ----------
test(".at is registered, documents itself for .aii, and the assistant labels it .at", () => {
  const at = commands.get("at");
  assert.ok(at, "the at command must be registered");
  assert.match(at.aiGuide, /Bloodpressure tracker/);
  assert.match(at.aiGuide, /\.at la bp 120 80/);
  assert.equal(at.isDestructive(["bp", "delete", "all"]), true);

  const prompt = buildSystemPrompt(commands, "context");
  assert.match(prompt, /### \.at\n/);
  assert.match(prompt, /### \.avc\n/);
  assert.match(prompt, /### \.a db\n/);
});

test("the Tracker tag exists and `.a tag list` describes it", async () => {
  assert.equal(canonicalTag("tracker"), "Tracker");
  assert.match(TAG_DEFINITIONS.Tracker, /`.at`/);
  const replies = [];
  await tagCommand.execute({ userId: "100000000000000001", channelId: "c", guildId: null, reply: async (t) => replies.push(t) }, ["list"]);
  assert.match(replies[0], /\*\*Tracker\*\* — use the `.at` trackers/);
});

// ---------- backup ----------
test("the cloud backup has ONE file for the whole tracker feature, containing every tracker table", () => {
  const group = BACKUP_GROUPS.find((g) => g.id === "tracker");
  assert.ok(group, "a tracker backup group must exist");
  assert.equal(group.databases.length, 1);
  assert.equal(group.databases[0].name, "Tracker"); // stored as Tracker.db
  assert.deepEqual(listDataTables(group.databases[0].db), ["bp_logs", "pill_logs", "pills", "tracker_permissions", "tracker_settings", "trackers"]);
  assert.equal(BACKUP_GROUPS.filter((g) => g.label === "Tracker").length, 1);
});
