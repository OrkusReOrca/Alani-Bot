// OpenRouter chat-completions client for the assistant. Two kinds of tools are
// offered to the model: our own `run_command` (a function the bot executes),
// and OpenRouter's `web_search` server tool (OpenRouter runs it, only when the
// model decides it needs the web — about $0.007 per search).

import { config, limits } from "./config.js";

const ENDPOINT = "https://openrouter.ai/api/v1/chat/completions";
const REQUEST_TIMEOUT_MS = 90 * 1000;

export const RUN_COMMAND_TOOL = {
  type: "function",
  function: {
    name: "run_command",
    description: 'Run ONE Alani command (".a ..." or ".avc ...") on behalf of the user, exactly as if they had typed it. Returns the command reply.',
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: 'The full command on a single line, starting with ".a" or ".avc", e.g. ".a db list reminders" or ".avc play rain".' },
      },
      required: ["command"],
    },
  },
};

const WEB_SEARCH_TOOL = {
  type: "openrouter:web_search",
  parameters: { max_uses: limits.maxWebSearchesPerRequest },
};

// Returns { message, usage }. Throws on transport/API errors.
export async function chat(messages) {
  if (!config.apiKey) throw new Error("OPENROUTER_API_KEY isn't set on the bot");

  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: { Authorization: `Bearer ${config.apiKey}`, "Content-Type": "application/json", "X-Title": "Alani" },
    body: JSON.stringify({
      model: config.model,
      messages,
      tools: [RUN_COMMAND_TOOL, WEB_SEARCH_TOOL],
      max_tokens: limits.maxOutputTokens,
      temperature: 0,
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`OpenRouter ${res.status}: ${(await res.text()).slice(0, 300)}`);

  const body = await res.json();
  const message = body.choices?.[0]?.message;
  if (!message) throw new Error(`OpenRouter returned no message: ${JSON.stringify(body).slice(0, 300)}`);
  return { message, usage: body.usage ?? {} };
}
