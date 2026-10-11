// The texts behind `.at help`, `.at type list` and `.a info at`. Kept apart from
// command.js so the info command can show the same text without importing the
// tracker's database.

import { TRACKER_TREE } from "./types.js";

export const HELP_TEXT = [
  "**Trackers (`.at`)** — in a DM just `t ...`. Needs the Tracker tag.",
  "",
  "A tracker belongs to you (`me`, the default) or to a server (`server`). Put `server` right after `.at` to use the server's tracker, or a user ID/@mention to use a tracker whose owner granted you permission. See `.at type list` for the tracker types.",
  "",
  "**Set up**",
  "```",
  '.at create type:"Bloodpressure tracker" [me|server]',
  '.at create type:"Activity tracker" name:"Fortnite karaoke weekly"',
  '.at enable|disable "NAME"          reminders on/off (disabled also blocks logging, data is kept)',
  ".at permission grant|revoke USER   let someone use all of the owner's trackers",
  ".at list                           your trackers (and this server's)",
  "```",
  "**Reminders**",
  "```",
  '.at setting "NAME" recuring:daily at:T21:00 to:"text" tz:GMT+7 tag:a,b sent:dm|CHANNEL_ID',
  '.at setting "NAME" recuring:weekly friday,sunday at:T19:30 ...',
  '.at setting "NAME" recuring:monthly 1,15,last at:T09:00 ...',
  '.at setting "NAME" recuring:yearly at:10,03,T09:00 ...   (month,day,time)',
  "```",
  "Times are 24-hour in `tz` (default GMT+7). `tag:` takes user names or IDs, `sent:` is `dm` or a channel ID. Blood pressure is daily only; a pill tracker's setting only takes `tz`, `tag` and `sent`.",
  "",
  "**Blood pressure**",
  "```",
  ".at la bp 120 80          log a reading now (short for logadd)",
  ".at bp list               browse the logs",
  ".at bp export RANGE      export as a text file",
  ".at bp delete RANGE      delete logs (asks first)",
  "```",
  "**Pills**",
  "```",
  '.at pill addpill "Full name"/"alias" recuring:daily at:T21:00',
  ".at pill removepill NAME|ALIAS   remove a pill and its logs (asks first)",
  ".at pill pills                   the pills and their schedules",
  ".at la p bpl,fl y                log pills taken (y) or not taken (n)",
  ".at pill list|export|delete [PILL] [RANGE]",
  "```",
  "**Ranges**: `all`, `latest14`, `oldest5`, `2026/10/1`, `2026/10/1-2026/11/13`.",
  "**Reminders** for blood pressure and pills are skipped if that day's reading/dose is already logged. A pill reminder DM can be answered with a plain `y` or `n`.",
  "**Aliases**: `la` logadd, `p` pill, `set` setting, `ls` list.",
].join("\n");

const TYPE_USAGE = {
  bloodpressure: [
    '`.at create type:"Bloodpressure tracker" [me|server]` — one per owner.',
    "Log with `.at la bp 120 80` (30–300), view with `.at bp list|export|delete`.",
    'Daily reminder: `.at setting "Bloodpressure tracker" recuring:daily at:T21:00 to:"..." sent:dm`.',
  ],
  pill: [
    '`.at create type:"Pill tracker" [me|server]` — one per owner, holds all your pills.',
    'Add pills with `.at pill addpill "Full name"/"alias" recuring:daily at:T21:00`, log with `.at la p alias y|n`.',
    'Delivery: `.at setting "Pill tracker" tz:GMT+7 tag:a,b sent:dm`.',
  ],
  activity: [
    '`.at create type:"Activity tracker" name:"My activity" [me|server]` — as many as you like, each needs a name.',
    "A pure reminder: it has no logs.",
    '`.at setting "My activity" recuring:weekly friday,sunday at:T19:30 to:"It\'s Karaoke Time!!!" tag:a,b sent:CHANNEL_ID`.',
  ],
};

function describeNode(node, depth, lines) {
  const indent = "  ".repeat(depth);
  if (!node.type) {
    lines.push(`${indent}${node.name}`);
    for (const child of node.children) describeNode(child, depth + 1, lines);
    return;
  }
  lines.push(`${indent}${node.name}${node.onePerOwner ? " (one per owner)" : " (any number)"}`);
}

export function typeListText() {
  const tree = [];
  describeNode(TRACKER_TREE, 0, tree);
  const types = [];
  const walk = (node) => (node.type ? types.push(node) : node.children.forEach(walk));
  walk(TRACKER_TREE);
  return [
    "**Tracker types**",
    "```",
    ...tree,
    "```",
    "Only the types themselves can be created; the groups (Health tracker, Routine tracker) just organise them.",
    "",
    ...types.flatMap((t) => [`**${t.name}**`, ...TYPE_USAGE[t.type], ""]),
    "Full command list: `.at help`.",
  ].join("\n");
}
