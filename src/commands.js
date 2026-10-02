// The registry of every ".a <name>" command. A command module exports:
//
//   data           { name, description? } — description also makes it a slash command
//   execute        (ctx, args) — see bot.js for ctx
//   aiGuide        REQUIRED: plain-text description of the command's syntax and
//                  behavior. It's fed to the .aii assistant (features/ai-assistant/),
//                  which is how .aii learns every command — a command without an
//                  aiGuide can't be used through it, and the test suite fails.
//   isDestructive  optional (args) => boolean — .aii asks the user to confirm
//                  before running such a call.

import * as infoCommand from "./features/info/command.js";
import * as fjamtrackCommand from "./features/fortnite-jam-tracks-tracker/shop/command.js";
import * as dbCommand from "./features/db/command.js";
import * as listDbCommand from "./features/db/listDbCommand.js";
import * as emotionCommand from "./features/emotion-detect/command.js";
import * as settingCommand from "./features/settings/command.js";
import * as tagCommand from "./features/tags/command.js";
import * as voiceCommand from "./features/voice-player/command.js";

export const commands = new Map(
  [infoCommand, fjamtrackCommand, dbCommand, listDbCommand, emotionCommand, settingCommand, tagCommand, voiceCommand].map((c) => [c.data.name, c])
);
