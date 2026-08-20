// ".a fjamtrack shop" — on-demand grid image, replied in whatever channel
// asked (as opposed to postGridImage.js's postShopGridImage(), which posts
// to the fixed tracking channel on a schedule). Prefix-only for now — not
// registered as a slash command, since "fjamtrack shop" is a two-word
// name/subcommand that doesn't map onto a single slash command the way
// info's does.

import { buildShopGridImageBuffer } from "./postGridImage.js";

export const data = {
  name: "fjamtrack",
};

export async function execute(ctx, args = []) {
  const sub = args[0]?.toLowerCase();
  if (sub !== "shop") {
    await ctx.reply("Usage: `.a fjamtrack shop` — sends the current Jam Tracks shop grid.");
    return;
  }

  const { imageBuffer, dateLabel } = await buildShopGridImageBuffer();
  await ctx.replyWithFile(imageBuffer, `jam-tracks-shop-${dateLabel}.png`);
}
