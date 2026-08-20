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

export const data = {
  name: "info",
  description: "About Alani — what she can do and how to use her",
};

const PRIVATE_SERVER_ID = "1539132003109314572";

const COMMANDS = [
  { text: "**/info** or **.a info** — this message.", private: false },
  { text: "**.a fjamtrack shop** — sends the current Fortnite Jam Tracks shop grid.", private: false },
  {
    text: "**.a db [<database>] <add|list|delete|edit> [args...]** — admin-level access to reminders/events, defaults to `orkus-info` (owner-only, Orkus Info channel only).",
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
  { text: "**orkus-info** — SQLite-backed reminders and calendar events, with duplicate and overlap detection. See `.a db`.", private: true },
];

// ctx: { reply, guildId, ... } — a uniform interface over both a
// slash-command interaction and a prefix-command message, so this doesn't
// need to know which one triggered it. See bot.js's
// interactionCreate/messageCreate handlers for how each one adapts to
// this shape.
export async function execute(ctx, _args = []) {
  const showPrivate = ctx.guildId === PRIVATE_SERVER_ID;
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
