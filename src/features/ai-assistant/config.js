import { readEnv } from "../../common/env.js";

export const config = {
  // OpenRouter key (same account the emotion service uses) and model. Haiku 4.5
  // was picked for reliable tool-calling and exact command syntax at low cost.
  apiKey: readEnv("OPENROUTER_API_KEY"),
  model: readEnv("AI_MODEL") || "anthropic/claude-haiku-4.5",
};

// Behavior limits (not env-tunable on purpose — they're cost/safety bounds).
export const limits = {
  maxRounds: 6, // model calls per .aii request
  maxOutputTokens: 1200,
  memoryTurns: 10,
  memoryWindowMs: 60 * 60 * 1000,
  confirmTimeoutMs: 60 * 1000,
  maxResultCharsForModel: 3000,
  maxWebSearchesPerRequest: 2,
};
