// The /info slash command — a brief self-introduction plus a live list of
// commands and features. COMMANDS/FEATURES are the single source of truth
// for this text; update them here when adding a new slash command or
// scheduled feature so /info doesn't go stale.

export const data = {
  name: "info",
  description: "About Alani — what she can do and how to use her",
};

// Deliberately excludes uni-application-updater — that's a private feature,
// not something to advertise in a command anyone with Alani in a shared
// server can run.
const COMMANDS = [
  "**/info** or **.a info** — this message.",
  "**.a fjamtrack shop** — sends the current Fortnite Jam Tracks shop grid.",
];

const FEATURES = [
  "**Fortnite Jam Tracks tracker** — daily channel posts tracking new/leaving Jam Tracks, including a grid image of everything currently in the purchasable shop.",
];

// ctx: { reply } — a uniform interface over both a slash-command interaction
// and a prefix-command message, so this doesn't need to know which one
// triggered it. See bot.js's interactionCreate/messageCreate handlers for
// how each one adapts to this shape.
export async function execute(ctx, _args = []) {
  const reply = [
    "**Hi, I'm Alani** — a personal Discord bot that tracks and posts updates on a few things automatically, and answers a few commands directly.",
    "",
    "**Commands**",
    COMMANDS.join("\n"),
    "",
    "**Features**",
    FEATURES.join("\n"),
  ].join("\n");

  await ctx.reply(reply);
}
