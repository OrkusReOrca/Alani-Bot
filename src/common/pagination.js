// Multi-page embeds with ⬅️ ➡️ buttons (like a Mudae list).
//
// A page is plain data — { title, description, footer } — so callers stay free
// of discord.js. Only the person who asked can turn the pages; the buttons
// disappear after a couple of idle minutes.

import { ActionRowBuilder, ButtonBuilder, ButtonStyle, ComponentType, EmbedBuilder } from "discord.js";

const IDLE_TIMEOUT_MS = 2 * 60 * 1000;
const EMBED_COLOR = 0x5865f2;
const PREVIOUS = "pages:previous";
const NEXT = "pages:next";

const toEmbed = (page) => new EmbedBuilder().setTitle(page.title).setDescription(page.description).setFooter({ text: page.footer }).setColor(EMBED_COLOR);

function buttonRow(index, count) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(PREVIOUS).setEmoji("⬅️").setStyle(ButtonStyle.Secondary).setDisabled(index === 0),
    new ButtonBuilder().setCustomId(NEXT).setEmoji("➡️").setStyle(ButtonStyle.Secondary).setDisabled(index === count - 1)
  );
}

// The same pages as plain text, for places that can't show embeds or buttons
// (only the first page — there's nothing to click).
export function pagesAsText(pages) {
  const [first] = pages;
  return `**${first.title}**\n${first.description}\n${first.footer}`;
}

// Replies to `message` with the first page and wires up the buttons.
// `userId` is who may turn the pages (default: the message's author).
export async function sendPaginated(message, pages, { userId = message.author.id, idleMs = IDLE_TIMEOUT_MS } = {}) {
  const sent = await message.reply({
    embeds: [toEmbed(pages[0])],
    components: pages.length > 1 ? [buttonRow(0, pages.length)] : [],
    allowedMentions: { repliedUser: false },
  });
  if (pages.length < 2) return sent;

  let index = 0;
  const collector = sent.createMessageComponentCollector({ componentType: ComponentType.Button, idle: idleMs });

  collector.on("collect", async (interaction) => {
    try {
      if (interaction.user.id !== userId) {
        await interaction.reply({ content: "Only the person who asked can turn the pages.", ephemeral: true });
        return;
      }
      index = interaction.customId === NEXT ? Math.min(index + 1, pages.length - 1) : Math.max(index - 1, 0);
      await interaction.update({ embeds: [toEmbed(pages[index])], components: [buttonRow(index, pages.length)] });
    } catch (err) {
      console.error("[pagination] couldn't turn the page:", err);
    }
  });
  collector.on("end", () => sent.edit({ components: [] }).catch(() => {}));
  return sent;
}
