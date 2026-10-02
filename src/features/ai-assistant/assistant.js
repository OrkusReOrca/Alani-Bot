// The assistant loop for one .aii request. Everything it touches is injected
// (llm, history, the Discord-side `env`, the command registry), so it runs
// end-to-end in tests with fakes; handler.js supplies the real ones.
//
// Flow: ask the model -> it replies with run_command calls -> run each one
// AS THE CALLER (so a command's own permission/channel checks still apply and
// a refusal simply comes back as its reply) -> feed the replies back -> repeat
// until the model answers in plain text or the round limit is hit.
//
// env: {
//   user: { id }, channelId, guildId,
//   post(text)               send text to the channel
//   postFile(buffer, name)   send a file
//   confirm(text) -> bool    ask the caller to confirm (destructive commands)
// }

import { parseCommandLine } from "../../common/commandParsing.js";
import { limits } from "./config.js";

const REFUSED_NOT_COMMAND = 'Error: the command must be a single line starting with ".a" or ".avc".';

const clip = (text, max) => (text.length > max ? `${text.slice(0, max)}… [truncated]` : text);

// Runs one `.a ...` line for the caller. Returns the text to hand back to the
// model. Posts "Ran `...`" and the command's own replies to the channel as it goes.
async function runCommandLine(line, { env, commands, recordEvent }) {
  const parsed = !/[\r\n]/.test(line) && parseCommandLine(line);
  if (!parsed?.name) return REFUSED_NOT_COMMAND;

  const command = commands.get(parsed.name);
  if (!command) return `Error: there is no command ".a ${parsed.name}". Available: ${[...commands.keys()].join(", ")}.`;

  const shown = line.trim();
  if (command.isDestructive?.(parsed.args)) {
    const confirmed = await env.confirm(`About to run \`${shown}\` — reply **yes** within ${limits.confirmTimeoutMs / 1000}s to confirm.`);
    if (!confirmed) {
      recordEvent("declined", shown);
      await env.post(`Okay, I didn't run \`${shown}\`.`);
      return "The user did not confirm, so the command was NOT run.";
    }
  }

  recordEvent("command", shown);
  await env.post(`Ran \`${shown}\``);

  const replies = [];
  const ctx = {
    userId: env.user.id,
    channelId: env.channelId,
    guildId: env.guildId,
    voiceChannelId: env.voiceChannelId ?? null,
    viaAI: true,
    reply: async (text) => {
      replies.push(String(text));
      await env.post(String(text));
    },
    replyWithFile: async (buffer, filename) => {
      replies.push(`[sent the file ${filename}]`);
      await env.postFile(buffer, filename);
    },
  };

  try {
    await command.execute(ctx, parsed.args);
  } catch (err) {
    console.error(`[ai-assistant] command "${shown}" crashed:`, err);
    replies.push(`Error: the command crashed (${err.message}).`);
  }

  const result = replies.join("\n") || "(the command produced no reply — it may be restricted to a different channel or user)";
  recordEvent("result", result);
  return clip(result, limits.maxResultCharsForModel);
}

function parseToolArguments(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export async function runAssistant({ text, systemPrompt, memory, env, commands, llm, history, model }) {
  const callId = history.startCall({ userId: env.user.id, channelId: env.channelId, guildId: env.guildId, userText: text, model });
  const recordEvent = (kind, content) => history.recordEvent(callId, kind, content);

  const messages = [{ role: "system", content: systemPrompt }, ...memory, { role: "user", content: text }];
  const usage = { promptTokens: 0, completionTokens: 0 };
  let finalText = null;

  try {
    for (let round = 1; round <= limits.maxRounds; round++) {
      const { message, usage: roundUsage } = await llm.chat(messages);
      usage.promptTokens += roundUsage.prompt_tokens ?? 0;
      usage.completionTokens += roundUsage.completion_tokens ?? 0;
      messages.push(message);

      const toolCalls = message.tool_calls ?? [];
      if (toolCalls.length === 0) {
        finalText = message.content?.trim() || null;
        break;
      }

      for (const call of toolCalls) {
        const args = call.function?.name === "run_command" ? parseToolArguments(call.function.arguments) : null;
        const result =
          typeof args?.command === "string"
            ? await runCommandLine(args.command, { env, commands, recordEvent })
            : "Error: only run_command(command) is available, with a JSON argument {\"command\": \"...\"}.";
        messages.push({ role: "tool", tool_call_id: call.id, content: result });
      }

      if (round === limits.maxRounds) finalText = `I stopped after ${limits.maxRounds} steps — try asking for less at once.`;
    }
  } catch (err) {
    console.error("[ai-assistant] request failed:", err);
    finalText = `I couldn't finish that: ${err.message}`;
  }

  if (finalText) await env.post(finalText);
  history.finishCall(callId, { responseText: finalText, ...usage });
  return finalText;
}
