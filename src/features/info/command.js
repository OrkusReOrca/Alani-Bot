// The /info slash command — a brief self-introduction plus a live list of
// commands and features. COMMANDS/FEATURES are the single source of truth
// for this text; update them here when adding a new slash command or
// scheduled feature so /info doesn't go stale.

export const data = {
  name: "info",
  description: "About Alani — what she can do and how to use her",
};

const COMMANDS = ["**/info** — this message."];

const FEATURES = [
  "**Uni application updater** — daily channel post + change-alert DMs tracking master's program admission status across Tsinghua/NTU/NUS.",
  "**Fortnite Jam Tracks tracker** — daily channel posts tracking new/leaving Jam Tracks, including a grid image of everything currently in the purchasable shop.",
];

export async function execute(interaction) {
  const reply = [
    "**Hi, I'm Alani** — a personal Discord bot that tracks and posts updates on a few things automatically, and answers a few commands directly.",
    "",
    "**Commands**",
    COMMANDS.join("\n"),
    "",
    "**Features**",
    FEATURES.join("\n"),
  ].join("\n");

  await interaction.reply(reply);
}
