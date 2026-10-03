// Multi-page embeds with ⬅️ ➡️ buttons (like a Mudae list).
//
// A page is plain data — { title, description?, fields?, footer } — so callers stay free
// of discord.js. Only the person who asked can turn the pages; the buttons
// disappear after a couple of idle minutes.

import { ActionRowBuilder, ButtonBuilder, ButtonStyle, ComponentType, EmbedBuilder } from "discord.js";

const IDLE_TIMEOUT_MS = 2 * 60 * 1000;
// Alani's orange (RGB 218, 133, 82) — the bar down the left side of every list embed.
// (Discord only lets a bot colour that bar; the box behind the text is the viewer's own theme.)
const EMBED_COLOR = 0xda8552;
const PREVIOUS = "pages:previous";
const NEXT = "pages:next";

// `fields` ([{ name, value }]) are shown as inline columns.
function toEmbed(page) {
  const embed = new EmbedBuilder().setTitle(page.title).setFooter({ text: page.footer }).setColor(EMBED_COLOR);
  if (page.description) embed.setDescription(page.description);
  if (page.fields) embed.addFields(page.fields.map((field) => ({ name: field.name, value: field.value, inline: true })));
  return embed;
}

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
  const columns = (first.fields ?? []).map((field) => `**${field.name}**\n${field.value}`);
  return [`**${first.title}**`, first.description, ...columns, first.footer].filter(Boolean).join("\n");
}

// Replies to `message` with the first page and wires up the buttons.
// `userId` is who may turn the pages (default: the message's author); `startPage`
// is the 0-based page shown first.
export async function sendPaginated(message, pages, { userId = message.author.id, idleMs = IDLE_TIMEOUT_MS, startPage = 0 } = {}) {
  const sent = await message.reply({
    embeds: [toEmbed(pages[startPage])],
    components: pages.length > 1 ? [buttonRow(startPage, pages.length)] : [],
    allowedMentions: { repliedUser: false },
  });
  if (pages.length < 2) return sent;

  let index = startPage;
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
