// The /info slash command — a brief self-introduction plus a live list of
// commands and features. COMMANDS/FEATURES are the single source of truth
// for this text; update them here when adding a new slash command or
// scheduled feature so /info doesn't go stale.
//
// Each entry is marked `private: true` if it shouldn't be advertised to
// anyone Alani shares a server with generally (uni-application-updater,
// the db admin command) — those only show up when /info or .a info is
// run inside Alani's own private server (PRIVATE_SERVER_ID below).
// Everywhere else (other servers, DMs), only the public entries show.

import { chunkMessage } from "../../common/discordApi.js";

export const data = {
  name: "info",
  description: "About Alani — what she can do and how to use her",
};

export const aiGuide = `
.a info          — what Alani is and the list of commands/features
.a info db       — full explanation of the database tier system
.a info emo      — explanation of emotion detection (private server only)
.a info setting  — explanation of settings and cloud backup (private server only)
.a info ai       — explanation of the .aii assistant (private server only)
.a info avc      — explanation of the voice player
Read-only.`;

const PRIVATE_SERVER_ID = "1539132003109314572";

const COMMANDS = [
  { text: "**/info** or **.a info** — this message. **.a info db** — full detail on the reminders/events database system, its tiers, and every command.", private: false },
  { text: "**.a fjamtrack shop** — sends the current Fortnite Jam Tracks shop grid.", private: false },
  {
    text: "**.a db [<database>] <add|list|delete|edit> [args...]** — reminders/events, in a database you own or have been given access to. See `.a info db`.",
    private: false,
  },
  { text: "**.a list db** — which database(s) you can see and use.", private: false },
  {
    text: "**.a emo <run1|runany|runall> m<modalities> <d|s>** — runs the emotion-detection pipeline on Google Drive clips. Needs the AIallowed tag, one dedicated channel. See `.a info emo`.",
    private: true,
  },
  {
    text: "**.avc join|play|pause|skip|queue|remove|status|leave ...** — Alani plays audio from a Google Drive folder in your voice call, with a saved queue, loop and shuffle. See `.a info avc`.",
    private: false,
  },
  {
    text: "**.aii <request>** — tell Alani what to do in plain language and she runs the commands for you. Needs the AIallowed tag. See `.a info ai`.",
    private: true,
  },
  {
    text: "**.a tag list | .a tag <TAG> list | .a tag add|remove <TAG> <user>** — tags (AIallowed, SongMaster) and who holds them. Owner-only.",
    private: true,
  },
  {
    text: "**.a setting [routine|cloud] ...** — turn routines on/off, inspect or run the cloud backup. Owner-only. See `.a info setting`.",
    private: true,
  },
];

const FEATURES = [
  {
    text: "**Fortnite Jam Tracks tracker** — daily channel posts tracking new/leaving Jam Tracks, including a grid image of everything currently in the purchasable shop.",
    private: false,
  },
  {
    text: "**Uni application updater** — daily channel post + change-alert DMs tracking master's program admission status across Tsinghua/NTU/NUS.",
    private: true,
  },
  {
    text: "**Reminders & events** — a tiered database system: a fixed admin database, plus private/guild databases regular users can be granted. See `.a info db` for the full picture.",
    private: false,
  },
  { text: "**orkus-info** — the admin tier's database specifically: SQLite-backed, synced to Google Calendar, duplicate/overlap detection. See `.a db`.", private: true },
  {
    text: "**Voice player** — `.avc` plays audio files from a Google Drive folder in a voice call. Queue, loop and shuffle are saved per server. See `.a info avc`.",
    private: false,
  },
  {
    text: "**AI assistant** — `.aii` turns plain-language requests into commands (with web search), remembers recent turns, and logs everything to AIcommandHistory. See `.a info ai`.",
    private: true,
  },
  {
    text: "**Cloud backup** — every 6 hours (from midnight, GMT+7) all databases and settings are verified against their change logs and saved (encrypted) to a private Discord channel, keeping the last 16 versions. See `.a info setting`.",
    private: true,
  },
  {
    text: "**Status channel** — one-line updates on Alani going online/offline, tracker runs, cloud backups, emotion runs and database changes.",
    private: true,
  },
  {
    text: "**Emotion detection** — a Qwen3-VL-8B-Instruct VLM pipeline (from a JAIST research thesis) predicting emotional state from video-call clips uploaded to Google Drive. See `.a info emo`.",
    private: true,
  },
];

// `.a info db` — the full picture of the reminders/events database
// system: every tier, every command, in one place. Deliberately public
// (usable by anyone, anywhere, unlike orkus-info's own private FEATURES
// entry above) — unlike Main tier itself, the tier system as a whole
// isn't a secret; regular users are meant to discover and use it. Kept
// as one string here (not the COMMANDS/FEATURES array-of-fragments
// pattern above) since it's read top-to-bottom as connected prose, not a
// flat list — see src/features/db/README.md for the source of truth this
// is a condensed version of.
const DB_INFO = [
  "**Reminders & events — how the tiers work**",
  "",
  "Every database uses the same commands once you're using it — " +
    "`.a db [<name>] add|list|delete|edit reminder|event ...` — the " +
    "difference between tiers is who can reach which database, not how " +
    "you use one.",
  "",
  "**Main** — the original database. Owner-only, one fixed channel, the " +
    "only one synced to Google Calendar. Most people will never touch this one.",
  "**Tier Personal** — a bot owner can grant you this. You get one " +
    "private database, usable from any channel: `.a db create personal " +
    "<name> <channel-id|dm>`.",
  "**Tier Server** — same, but your one database is scoped to a server " +
    "and can have collaborators you add yourself (`.a db collab add " +
    "<name> <user-id>`). Its events also show up as real Discord server " +
    "events, not just in the database.",
  "",
  "**Getting reminded/events delivered**: whichever channel (or DM) you " +
    "pick when creating your database is where its reminders/events post " +
    "by default — you can still send an individual one somewhere else by " +
    "adding a channel ID at the end.",
  "",
  "**Dates**: 24-hour time, Indochina/Bangkok timezone. Year, month, and " +
    "even the whole date can be left off and today's is assumed — " +
    "`T19:00` alone means \"today at 7pm\".",
  "",
  "**Text fields are quoted**: reminder text and event titles go in " +
    "double quotes — `\"like this\"` — so they can contain spaces, " +
    "commas, or emoji freely. It's required, not optional.",
  "**Reminders can tag people**: add a comma-separated list of user IDs " +
    "and/or usernames after the text and they'll be tagged when it fires " +
    "— `... \"take out the trash\" alice,791886420435533864`.",
  "",
  "**If you've lost track of what you can access**: `.a list db`.",
  "",
  "**Once you have a database**:",
  "```",
  '.a db [<name>] add reminder <YYYY-MM-DDTHH:MM> "<text>" [mentions] [channel-id] [force]',
  '.a db [<name>] add event <start> [end|allday] "<title>" [| <location>]',
  ".a db [<name>] list reminders / events",
  ".a db [<name>] delete reminder <id|all> / event <id>",
  '.a db [<name>] edit reminder <id> <YYYY-MM-DDTHH:MM> "<text>"',
  '.a db [<name>] edit event <id> <start> <end> "<title>" [| <location>]',
  "```",
  "`<name>` can be left off once you only have one database to pick from.",
].join("\n");

// `.a info emo` — same "one connected explanation, gated to the private
// server" treatment as DB_INFO's public counterpart, except this one
// actually IS gated (unlike the db tier system, this feature is a
// personal research demo, not something meant to be discoverable by
// anyone Alani shares a server with) — see execute()'s privacy check
// below. Source of truth for the exact command shape is
// src/features/emotion-detect/README.md; keep this in sync with it.
const EMO_INFO = [
  "**Emotion detection — how it works**",
  "",
  "Reproduces a JAIST research thesis's VLM emotion-recognition pipeline " +
    "(Qwen3-VL-8B-Instruct via OpenRouter, four-class circumplex model) " +
    "against video-call clips sitting in a Google Drive folder. Needs the AIallowed tag, " +
    "and only responds in its one dedicated channel — silent everywhere else.",
  "",
  "```",
  ".a emo <run1|runany|runall> m<modality dot-list|all> <d|s> [mif]",
  "```",
  "",
  "**Run mode** (which clip(s) to process):",
  "- `run1` — exactly one pending clip (any clip not already prefixed `DONE_`)",
  "- `runany` — every pending clip found, however many there are",
  "- `runall` — force-reprocess **every** clip, `DONE_` or not",
  "",
  "**Modality list** — a dot-separated subset of `AU` (facial action units), " +
    "`T` (speech transcript), `VO` (voice acoustics), `ET` (eye gaze), `HT` " +
    "(head pose), e.g. `mAU.T.VO`, or `mall` for all five. This is what " +
    "actually goes into the VLM's prompt for this run.",
  "",
  "**Cache mode**:",
  "- `d` (default) — extract & cache **all 5** modalities for each clip " +
    "regardless of the modality list, so a later run with a different list " +
    "is instant (already on disk)",
  "- `s` (specified-only) — only extract what's in the modality list this time",
  "",
  "**More info** (optional 4th arg): `mif` — each result also gets the " +
    "full prompt text (both ValAro steps) as follow-up messages, and the " +
    "attached image is py-feat's own annotated frame (face box, landmarks, " +
    "AU bars, head pose) instead of the plain first frame. The two prompts " +
    "are separate messages, followed by a timeline (upload time and command " +
    "time in GMT+7, then T+X for preprocess done, VLM done, final message " +
    "sent). Left off = today's lighter result.",
  "",
  "Example: `.a emo runany mAU.T d` — process every pending clip using " +
    "AU + transcript in the prompt, caching all five for later.",
  "",
  "**What happens**: the ack names the actual clip(s) resolved (a fast " +
    "Drive listing happens up front), then a result message per finished " +
    "clip (prediction + the clip's first frame attached) as it's ready, " +
    "then a short summary once the whole run is done. Videos longer than " +
    "2 minutes are silently truncated to the first 2:00 before anything " +
    "else happens. A clip that fails is left unprefixed so the next " +
    "`run1`/`runany` retries it automatically.",
  "",
  "**Resend (no recompute)**:",
  "```",
  ".a emo resend <all|recent|<filename>>",
  "```",
  "Re-posts an already-computed result straight from Alani Emotion's own " +
    "records — no Drive listing, no preprocessing, no OpenRouter calls. " +
    "For when a run finished successfully (clip already renamed `DONE_...`) " +
    "but the final Discord delivery got lost to a network blip. `all` = " +
    "every clip ever processed successfully, `recent` = the last 24 hours, " +
    "anything else = a filename (matches with or without the `DONE_` prefix).",
].join("\n");

// `.a info setting` — same private-server gating as EMO_INFO. Source of
// truth: src/features/settings/README.md and src/features/cloud-backup/README.md.
const SETTING_INFO = [
  "**Settings & cloud backup**",
  "",
  "Owner-only.",
  "```",
  ".a setting",
  ".a setting routine",
  ".a setting routine <unitracker|fortnite> <setON|setOFF>",
  ".a setting cloud [status|push|resume <cloud|host> [db|settings]]",
  "```",
  "",
  "**Routines** — `unitracker` (the daily uni post, runs in the bot) and " +
    "`fortnite` (the shop check/post, which runs as scheduled GitHub " +
    "workflows — switching it enables/disables those workflows). Off means " +
    "it doesn't fire until turned back on.",
  "",
  "**Cloud backup** — at 00:00, 06:00, 12:00 and 18:00 (GMT+7) the bot " +
    "checks every database and the settings against their change logs and " +
    "saves a new encrypted version when something really changed (the " +
    "last 16 versions are kept, per group). It also runs every time the " +
    "bot comes online, and `push` runs it on demand.",
  "",
  "**If the check fails** (the data, the change log and the stored copy " +
    "don't agree): you're tagged in the status channel, the host's copy is " +
    "saved as a separate `FAULTY_...` backup, the host is reset to the last " +
    "good stored version, and a report of what differs goes to the command " +
    "box. Answer there with `resume cloud` (keep the stored version) or " +
    "`resume host` (keep the host's). Backups of that group stay paused " +
    "until you do.",
].join("\n");

// `.a info ai` — same private-server gating as EMO_INFO. Source of truth:
// src/features/ai-assistant/README.md and src/features/tags/README.md.
const AI_INFO = [
  "**AI assistant (`.aii`)**",
  "",
  "Say what you want in plain language and Alani runs the right commands for " +
    "you, showing each one (`Ran ...`) and its reply. Works in any channel, " +
    "server or DM. Needs the **AIallowed** tag.",
  "```",
  ".aii add a reminder in kk server db for when the new fortnite version drops, tag me and @KK",
  ".aii run the one latest video on emotion prediction, more info, use AU T and VO, cache all",
  "```",
  "",
  "It knows every command, uses UTC+7 24-hour time, can search the web for " +
    "current info, and invents names for reminders/events when you don't give one. " +
    "It runs commands as **you**, so each command's own permissions still apply " +
    "(if something isn't allowed it tells you).",
  "",
  "**Confirmations**: delete/drop/revoke/transfer-type commands ask first — " +
    "reply `yes` within 60 s or nothing runs.",
  "**Follow-ups**: it remembers your last 10 requests from the past hour, so " +
    "\"make it 11:00 instead\" works.",
  "**History**: every request, command and reply is saved (AIcommandHistory) " +
    "and backed up.",
  "",
  "**Access**: bot owners always have it. They grant it with " +
    "`.a tag add AIallowed <user>` (also `remove` / `list`). AIallowed also " +
    "unlocks `.a emo`.",
].join("\n");

// `.a info avc` — the voice player. Public (anyone in the bot's call may use it).
// Source of truth: src/features/voice-player/README.md.
const AVC_INFO = [
  "**Voice player (`.avc`)**",
  "",
  "Alani joins your voice call and plays audio files from a Google Drive folder " +
    "(sound only — a bot can't share video).",
  "```",
  ".avc join                      join your voice channel",
  ".avc play FILE NAME            add to the end of the queue",
  ".avc force play FILE NAME      SongMaster: play next, skip the current",
  ".avc pause                     pause (again to resume)",
  ".avc skip",
  ".avc queue                     the queue with lengths",
  ".avc queue loop on|off",
  ".avc queue shuffle on|off      (shuffle also means loop)",
  ".avc queue playcall on|off     \"Now playing\" messages on/off",
  ".avc remove FILE NAME",
  ".avc removeall                 SongMaster: clear the queue",
  ".avc status",
  ".avc leave                     the queue is kept",
  "```",
  "",
  "**File names** ignore case and extension, and a partial name works if it " +
    "matches exactly one file.",
  "**Who**: anyone can view `queue`/`status`; everything else needs you to be in " +
    "the bot's voice channel (`play`/`join` make it join yours). `force play` and " +
    "`removeall` need the **SongMaster** tag.",
  "**Queue**: finished tracks are removed, unless loop or shuffle is on (then " +
    "they go to the back). The queue, loop, shuffle and PlayCall (the \"Now playing\" messages) are saved per server, so " +
    "`leave` then `join` resumes where you left off (from the start of the " +
    "first track). The bot leaves by itself after 5 min idle or 1 min alone.",
].join("\n");

// ctx: { reply, guildId, ... } — a uniform interface over both a
// slash-command interaction and a prefix-command message, so this doesn't
// need to know which one triggered it. See bot.js's
// interactionCreate/messageCreate handlers for how each one adapts to
// this shape.
export async function execute(ctx, args = []) {
  const showPrivate = ctx.guildId === PRIVATE_SERVER_ID;

  if (args[0]?.toLowerCase() === "db") {
    // Chunked (not a single ctx.reply()) since this has grown past
    // Discord's 2000-char single-message limit — safe to call ctx.reply()
    // more than once here since `.a info db` is prefix-only (message-
    // based ctx), never a slash interaction (which could only ever
    // reply once without a followUp ctx doesn't expose).
    for (const chunk of chunkMessage(DB_INFO)) {
      await ctx.reply(chunk);
    }
    return;
  }

  if (args[0]?.toLowerCase() === "emo") {
    // Unlike `.a info db`, this one IS gated — see EMO_INFO's own
    // comment on why. Outside the private server this just falls through
    // to the regular info reply below (private COMMANDS/FEATURES entries
    // already hidden there too), rather than confirming the topic exists
    // at all with a distinct "not available" message.
    if (!showPrivate) {
      await execute(ctx, []);
      return;
    }
    for (const chunk of chunkMessage(EMO_INFO)) {
      await ctx.reply(chunk);
    }
    return;
  }

  if (args[0]?.toLowerCase() === "avc") {
    for (const chunk of chunkMessage(AVC_INFO)) {
      await ctx.reply(chunk);
    }
    return;
  }

  if (args[0]?.toLowerCase() === "ai") {
    if (!showPrivate) {
      await execute(ctx, []);
      return;
    }
    for (const chunk of chunkMessage(AI_INFO)) {
      await ctx.reply(chunk);
    }
    return;
  }

  if (args[0]?.toLowerCase() === "setting") {
    if (!showPrivate) {
      await execute(ctx, []);
      return;
    }
    for (const chunk of chunkMessage(SETTING_INFO)) {
      await ctx.reply(chunk);
    }
    return;
  }

  const commands = COMMANDS.filter((c) => showPrivate || !c.private).map((c) => c.text);
  const features = FEATURES.filter((f) => showPrivate || !f.private).map((f) => f.text);

  const reply = [
    "**Hi, I'm Alani** — a personal Discord bot that tracks and posts updates on a few things automatically, and answers a few commands directly.",
    "",
    "**Commands**",
    commands.join("\n"),
    "",
    "**Features**",
    features.join("\n"),
  ].join("\n");

  await ctx.reply(reply);
}
