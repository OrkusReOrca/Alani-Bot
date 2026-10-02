import { test } from "node:test";
import assert from "node:assert/strict";
import { runAssistant } from "../src/features/ai-assistant/assistant.js";
import { buildContext, buildSystemPrompt } from "../src/features/ai-assistant/prompt.js";
import { parseAiInvocation } from "../src/features/ai-assistant/handler.js";
import { commands } from "../src/commands.js";

// ---- fakes ----
function fakeHistory() {
  const calls = [];
  return {
    calls,
    startCall: (info) => calls.push({ ...info, events: [] }) && calls.length,
    recordEvent: (id, kind, content) => calls[id - 1].events.push({ kind, content }),
    finishCall: (id, result) => Object.assign(calls[id - 1], { result }),
  };
}

// An LLM that plays back scripted assistant messages and records what it was sent.
function scriptedLlm(...script) {
  const seen = [];
  return {
    seen,
    chat: async (messages) => {
      seen.push(structuredClone(messages));
      const message = script.shift();
      assert.ok(message, "the assistant asked the model more times than scripted");
      return { message, usage: { prompt_tokens: 100, completion_tokens: 20 } };
    },
  };
}

const toolCall = (id, command) => ({ id, type: "function", function: { name: "run_command", arguments: JSON.stringify({ command }) } });
const callsMessage = (...calls) => ({ role: "assistant", content: null, tool_calls: calls });
const textMessage = (content) => ({ role: "assistant", content });

function fakeEnv({ confirmAnswer = true } = {}) {
  const posted = [];
  return {
    posted,
    user: { id: "42" },
    channelId: "c1",
    guildId: "g1",
    post: async (text) => posted.push(text),
    postFile: async (buf, name) => posted.push(`[file ${name}]`),
    confirm: async (prompt) => (posted.push(`CONFIRM? ${prompt}`), confirmAnswer),
  };
}

function fakeCommands(extra = {}) {
  const ran = [];
  const make = (name, execute, isDestructive) => ({ data: { name }, aiGuide: `guide for ${name}`, execute, isDestructive });
  return {
    ran,
    commands: new Map([
      ["db", make("db", async (ctx, args) => (ran.push({ args, ctx }), ctx.reply("Added reminder #1")), (args) => args[0] === "delete")],
      ["quiet", make("quiet", async () => {})],
      ["boom", make("boom", async () => { throw new Error("kaput"); })],
      ...Object.entries(extra),
    ]),
  };
}

const run = (overrides) =>
  runAssistant({ text: "do it", systemPrompt: "SYS", memory: [], model: "m", history: fakeHistory(), ...overrides });

// ---- tests ----
test("runs the command as the caller, echoes it, posts its reply, and adds nothing when the model stays quiet", async () => {
  const { commands, ran } = fakeCommands();
  const env = fakeEnv();
  const history = fakeHistory();
  const llm = scriptedLlm(callsMessage(toolCall("t1", '.a db add reminder 2026-10-03T10:55 "Fortnite" kk')), textMessage(""));

  await run({ env, commands, llm, history });

  assert.deepEqual(env.posted, ['Ran `.a db add reminder 2026-10-03T10:55 "Fortnite" kk`', "Added reminder #1"]);
  assert.deepEqual(ran[0].args, ["add", "reminder", "2026-10-03T10:55", '"Fortnite"', "kk"]);
  assert.equal(ran[0].ctx.userId, "42");
  assert.equal(ran[0].ctx.channelId, "c1");
  assert.equal(ran[0].ctx.viaAI, true);

  // The model was shown the command's reply as a tool result.
  const toolMessage = llm.seen[1].at(-1);
  assert.equal(toolMessage.role, "tool");
  assert.equal(toolMessage.tool_call_id, "t1");
  assert.equal(toolMessage.content, "Added reminder #1");

  // Everything is recorded, with token usage.
  assert.deepEqual(history.calls[0].events, [
    { kind: "command", content: '.a db add reminder 2026-10-03T10:55 "Fortnite" kk' },
    { kind: "result", content: "Added reminder #1" },
  ]);
  assert.deepEqual(history.calls[0].result, { responseText: null, promptTokens: 200, completionTokens: 40 });
});

test("a plain-text answer (e.g. after a web search) is posted", async () => {
  const env = fakeEnv();
  await run({ env, commands: fakeCommands().commands, llm: scriptedLlm(textMessage("Fortnite Chapter 7 starts on Dec 5.")) });
  assert.deepEqual(env.posted, ["Fortnite Chapter 7 starts on Dec 5."]);
});

test("destructive commands wait for confirmation; declining doesn't run them", async () => {
  const { commands, ran } = fakeCommands();
  const env = fakeEnv({ confirmAnswer: false });
  const history = fakeHistory();
  const llm = scriptedLlm(callsMessage(toolCall("t1", ".a db delete reminder all")), textMessage("Cancelled."));

  await run({ env, commands, llm, history });

  assert.equal(ran.length, 0);
  assert.match(env.posted[0], /CONFIRM\? About to run `\.a db delete reminder all`/);
  assert.equal(llm.seen[1].at(-1).content, "The user did not confirm, so the command was NOT run.");
  assert.deepEqual(history.calls[0].events, [{ kind: "declined", content: ".a db delete reminder all" }]);

  const confirmedEnv = fakeEnv({ confirmAnswer: true });
  await run({ env: confirmedEnv, commands, llm: scriptedLlm(callsMessage(toolCall("t1", ".a db delete reminder 1")), textMessage("")) });
  assert.equal(ran.length, 1);
});

test("a refusal comes back as the command's own reply and the model explains it", async () => {
  const denied = { data: { name: "setting" }, aiGuide: "x", execute: async (ctx) => ctx.reply("Unauthorized user, no permission") };
  const env = fakeEnv();
  const llm = scriptedLlm(callsMessage(toolCall("t1", ".a setting routine unitracker setOFF")), textMessage("You don't have permission to change settings."));

  await run({ env, commands: new Map([["setting", denied]]), llm });

  assert.deepEqual(env.posted, ["Ran `.a setting routine unitracker setOFF`", "Unauthorized user, no permission", "You don't have permission to change settings."]);
});

test("a silent command, a crashing command, an unknown command and a non-command are all reported to the model", async () => {
  const { commands } = fakeCommands();
  const env = fakeEnv();
  const llm = scriptedLlm(
    callsMessage(toolCall("a", ".a quiet"), toolCall("b", ".a boom"), toolCall("c", ".a nope"), toolCall("d", "rm -rf /"), toolCall("e", ".a db x\n.a db y")),
    textMessage("")
  );

  await run({ env, commands, llm });

  const results = llm.seen[1].filter((m) => m.role === "tool").map((m) => m.content);
  assert.match(results[0], /produced no reply/);
  assert.match(results[1], /crashed \(kaput\)/);
  assert.match(results[2], /no command "\.a nope"/);
  assert.match(results[3], /must be a single line starting with "\.a"/);
  assert.match(results[4], /must be a single line/);
});

test("the model can't recurse into .aii or call tools that don't exist", async () => {
  const env = fakeEnv();
  const llm = scriptedLlm(
    callsMessage(toolCall("a", ".aii do something"), { id: "b", type: "function", function: { name: "hack", arguments: "{}" } }),
    textMessage("")
  );
  await run({ env, commands: fakeCommands().commands, llm });
  const results = llm.seen[1].filter((m) => m.role === "tool").map((m) => m.content);
  assert.match(results[0], /must be a single line starting with "\.a"/);
  assert.match(results[1], /only run_command/);
});

test("the loop is capped, and an LLM failure is reported instead of thrown", async () => {
  const env = fakeEnv();
  const forever = Array.from({ length: 10 }, (_, i) => callsMessage(toolCall(`t${i}`, ".a quiet")));
  await run({ env, commands: fakeCommands().commands, llm: scriptedLlm(...forever) });
  assert.match(env.posted.at(-1), /stopped after 6 steps/);

  const failing = { chat: async () => { throw new Error("OpenRouter 402: out of credits"); } };
  const env2 = fakeEnv();
  await run({ env: env2, commands: fakeCommands().commands, llm: failing });
  assert.match(env2.posted[0], /couldn't finish that: OpenRouter 402/);
});

test("memory and the system prompt reach the model; the user's text is last", async () => {
  const llm = scriptedLlm(textMessage("ok"));
  const memory = [{ role: "user", content: "earlier" }, { role: "assistant", content: "Ran `.a quiet`" }];
  await run({ env: fakeEnv(), commands: fakeCommands().commands, llm, memory, text: "make it 11:00" });
  assert.deepEqual(llm.seen[0].map((m) => m.role), ["system", "user", "assistant", "user"]);
  assert.equal(llm.seen[0].at(-1).content, "make it 11:00");
});

test("context and prompt: time in UTC+7 24h, mentions, databases, and every command's guide", () => {
  const context = buildContext({
    now: Date.UTC(2026, 9, 2, 17, 5), // 2026-10-03 00:05 ICT, a Saturday
    user: { id: "1", username: "higgorca" },
    channelId: "c9",
    channelName: "text-chat",
    guildId: "g9",
    guildName: "KK server",
    mentionedUsers: [{ id: "950734654128926753", username: "kk" }],
    mentionedChannels: [],
    databases: [{ name: "KKserver", kind: "server" }],
  });
  assert.match(context, /Now: 2026-10-03T00:05 \(Saturday\), UTC\+7/);
  assert.match(context, /kk = 950734654128926753/);
  assert.match(context, /KKserver \(server\)/);

  const prompt = buildSystemPrompt(new Map([["db", { aiGuide: "DB-GUIDE" }], ["emo", { aiGuide: "EMO-GUIDE" }]]), context);
  assert.match(prompt, /### \.a db\nDB-GUIDE/);
  assert.match(prompt, /### \.a emo\nEMO-GUIDE/);
});

test("only '.aii' as its own word triggers the assistant", () => {
  assert.equal(parseAiInvocation(".aii add a reminder"), "add a reminder");
  assert.equal(parseAiInvocation(".AII hi"), "hi");
  assert.equal(parseAiInvocation(".aii"), "");
  assert.equal(parseAiInvocation(".a info"), null);
  assert.equal(parseAiInvocation(".aiii x"), null);
  assert.equal(parseAiInvocation("hello .aii"), null);
});

test("every registered command documents itself for the assistant", () => {
  for (const [name, command] of commands) {
    assert.equal(typeof command.aiGuide, "string", `.a ${name} must export an aiGuide`);
    assert.ok(command.aiGuide.trim().length > 20, `.a ${name}'s aiGuide is too thin`);
    assert.ok(command.isDestructive === undefined || typeof command.isDestructive === "function", `.a ${name}'s isDestructive must be a function`);
  }
});

test("destructive detection on the real commands", () => {
  const db = commands.get("db");
  assert.equal(db.isDestructive(["delete", "reminder", "all"]), true);
  assert.equal(db.isDestructive(["KKserver", "delete", "event", "3"]), true);
  assert.equal(db.isDestructive(["drop", "x"]), true);
  assert.equal(db.isDestructive(["collab", "remove", "x", "123"]), true);
  assert.equal(db.isDestructive(["KKserver", "add", "reminder", "T10:00", '"x"']), false);
  assert.equal(db.isDestructive(["list", "reminders"]), false);
  assert.equal(commands.get("setting").isDestructive(["cloud", "resume", "host"]), true);
  assert.equal(commands.get("setting").isDestructive(["cloud", "push"]), false);
  assert.equal(commands.get("tag").isDestructive(["remove", "AIallowed", "1"]), true);
});
