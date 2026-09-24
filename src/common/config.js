import { readEnv } from "./env.js";

// Bot-level config, shared by the persistent bot (bot.js) and command
// registration (deployCommands.js) — as opposed to per-feature config,
// which stays in each feature's own config.js.
export const config = {
  botToken: readEnv("DISCORD_BOT_TOKEN"),
  clientId: readEnv("DISCORD_CLIENT_ID"),
  // The "Orkus Info" channel — admin db commands only respond here. See
  // src/features/db/command.js.
  commandBoxChannelId: readEnv("DISCORD_COMMAND_BOX"),
  // Voice bridge (voice-Alani, running on the user's PC) — see
  // src/features/db/voiceApi.js. Listens on the host's already-exposed
  // network port (SERVER_PORT is set automatically by bot-hosting.net)
  // rather than needing a second port opened.
  voiceApiSecret: readEnv("VOICE_API_SECRET"),
  voiceApiPort: Number(readEnv("VOICE_API_PORT") || process.env.SERVER_PORT) || 3000,
  // Default DM target for voice-added reminders — see voiceApi.js.
  ownerZeroId: readEnv("DISCORD_OWNER_0"),
  // Google service account credentials (the whole downloaded JSON key,
  // as one env var value) — shared across every database's calendar
  // sync (see src/common/googleCalendar.js); which CALENDAR a given
  // database syncs to is that database's own config (e.g. orkus-info's
  // own config.js), not this one.
  googleServiceAccountKey: readEnv("GOOGLE_SERVICE_ACCOUNT_KEY"),
  // Fine-grained GitHub PAT (Actions: write, Contents: read, this repo
  // only) + "owner/repo" — lets an admin command fire a workflow_dispatch
  // event (see src/common/githubActions.js). Currently only used by
  // ".a fjamtrack refresh". If unset, that command just reports itself
  // unconfigured — nothing else is affected.
  githubToken: readEnv("GITHUB_ACTIONS_TOKEN"),
  githubRepo: readEnv("GITHUB_REPO"),
  // The channel Alani posts one-line status updates to (online/offline,
  // tracker runs, cloud backups, database changes — see common/statusLog.js).
  statusChannelId: readEnv("DISCORD_STATUS_CHANNEL"),
  // Cloud backup (see features/cloud-backup/): the private channel that holds
  // the encrypted backup files, and the 64-hex-character AES key they're
  // encrypted with (generate one with `npm run backup-key` and keep a copy
  // somewhere safe — without it the backups can't be read).
  backupChannelId: readEnv("DISCORD_BACKUP_CHANNEL"),
  backupEncryptionKey: readEnv("BACKUP_ENCRYPTION_KEY"),
};
