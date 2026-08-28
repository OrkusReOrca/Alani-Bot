import dotenv from "dotenv";
dotenv.config();

function required(name) {
  return process.env[name] && process.env[name].trim() !== "" ? process.env[name].trim() : null;
}

// Bot-level config, shared by the persistent bot (bot.js) and command
// registration (deployCommands.js) — as opposed to per-feature config,
// which stays in each feature's own config.js.
export const config = {
  botToken: required("DISCORD_BOT_TOKEN"),
  clientId: required("DISCORD_CLIENT_ID"),
  // The "Orkus Info" channel — admin db commands only respond here. See
  // src/features/db/command.js.
  commandBoxChannelId: required("DISCORD_COMMAND_BOX"),
  // Voice bridge (voice-Alani, running on the user's PC) — see
  // src/features/db/voiceApi.js. Listens on the host's already-exposed
  // network port (SERVER_PORT is set automatically by bot-hosting.net)
  // rather than needing a second port opened.
  voiceApiSecret: required("VOICE_API_SECRET"),
  voiceApiPort: Number(required("VOICE_API_PORT") || process.env.SERVER_PORT) || 3000,
  // Default DM target for voice-added reminders — see voiceApi.js.
  ownerZeroId: required("DISCORD_OWNER_0"),
  // Google service account credentials (the whole downloaded JSON key,
  // as one env var value) — shared across every database's calendar
  // sync (see src/common/googleCalendar.js); which CALENDAR a given
  // database syncs to is that database's own config (e.g. orkus-info's
  // own config.js), not this one.
  googleServiceAccountKey: required("GOOGLE_SERVICE_ACCOUNT_KEY"),
  // Fine-grained GitHub PAT (Actions: write, Contents: read, this repo
  // only) + "owner/repo" — lets an admin command fire a workflow_dispatch
  // event (see src/common/githubActions.js). Currently only used by
  // ".a fjamtrack refresh". If unset, that command just reports itself
  // unconfigured — nothing else is affected.
  githubToken: required("GITHUB_ACTIONS_TOKEN"),
  githubRepo: required("GITHUB_REPO"),
};
