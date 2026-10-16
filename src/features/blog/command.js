// ".ad" — Alani dev commands. For now: the Alatomy blog (alatomy.com/blog), posted from Discord.
//
//   .ad blog create <section> title:"TITLE" by:"WRITER" "TEXT"   (+ images attached to the message)
//   .ad blog approve latest yes|no  /  .ad blog approve name:"TITLE" yes|no      (owners)
//   .ad blog delete name:"TITLE"                                               (owners)
//   .ad blog pending                                                           (the posts waiting)
//
// Only in the blog channel. Bot owners and the tier1dev tag publish at once; the tierPRdev tag sends the
// post for approval and the first owner is tagged. Every post is shown and confirmed before it is sent.
// The posts and their images are stored by the website (the Alatomy account service's internal API).

import { readEnv } from "../../common/env.js";
import { isOwner, getOwnerIds } from "../../common/auth.js";
import { hasTag } from "../tags/store.js";
import { AccountApiError, accountClient } from "../alatomy-account/client.js";
import { config as accountConfig } from "../alatomy-account/config.js";
import { NOT_CONNECTED_HELP } from "../alatomy-account/link.js";
import { parseApprove, parseCreate, parseDelete } from "./parse.js";

export const data = { name: "ad" };

export const aiGuide = `
.ad blog ...  — Alatomy blog posting for developers (only in the blog channel; owners and the tier1dev / tierPRdev tags). Always confirmed by the person. Do not use this through .aii: tell the person to send the command themselves, with any images attached.`;

export const isDestructive = () => true;

const BLOG_CHANNEL = readEnv("DISCORD_BLOG_CHANNEL") || "1560629482182803456";
const MAX_IMAGES = 10;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const PREVIEW_CHARS = 400;
const USAGE = 'Usage: `.ad blog create <section> title:"TITLE" by:"WRITER" "TEXT"` · `.ad blog approve latest yes|no` · `.ad blog approve name:"TITLE" yes|no` · `.ad blog delete name:"TITLE"` · `.ad blog pending`';

const postUrl = (post) => `${accountConfig.siteUrl}${post.path}`;
const mention = (id) => (id ? `<@${id}>` : "");

/** The images attached to the message, downloaded, as base64 (or an error message). */
async function attachedImages(attachments, fetchImpl) {
  const images = (attachments ?? []).filter((a) => /^image\/(png|jpeg|gif|webp)\b/i.test(a.contentType ?? ""));
  if (images.length > MAX_IMAGES) return { error: `At most ${MAX_IMAGES} images per post.` };
  const tooBig = images.find((a) => a.size > MAX_IMAGE_BYTES);
  if (tooBig) return { error: `"${tooBig.name}" is larger than ${MAX_IMAGE_BYTES / 1024 / 1024} MB.` };
  const out = [];
  for (const image of images) {
    const response = await fetchImpl(image.url, { signal: AbortSignal.timeout(30_000) }).catch(() => null);
    if (!response?.ok) return { error: `Couldn't download "${image.name}" from Discord. Try sending it again.` };
    out.push({ data: Buffer.from(await response.arrayBuffer()).toString("base64") });
  }
  return { images: out, skipped: (attachments ?? []).length - images.length };
}

function preview(post, imageCount, pending) {
  const text = post.body.length > PREVIEW_CHARS ? `${post.body.slice(0, PREVIEW_CHARS)}…` : post.body;
  return [
    `**${pending ? "Send this post for approval" : "Publish this post"}?** (reply **yes** to ${pending ? "send" : "publish"}, anything else to cancel)`,
    `**Section:** \`${post.section}\` · **Title:** ${post.title} · **By:** ${post.author} · **Images:** ${imageCount}`,
    ">>> " + text,
  ].join("\n");
}

export function createExecute({ client = accountClient, fetchImpl = (...a) => fetch(...a), blogChannel = BLOG_CHANNEL } = {}) {
  async function create(ctx) {
    const owner = isOwner(ctx.userId);
    const direct = owner || hasTag(ctx.userId, "tier1dev");
    if (!direct && !hasTag(ctx.userId, "tierPRdev")) return "Posting to the blog needs the tier1dev or tierPRdev tag.";
    const post = parseCreate(ctx.content);
    if (post.usage) return post.usage;
    if (!ctx.confirm) return "Send the command yourself (with any images attached) so I can ask you to confirm it.";

    const downloaded = await attachedImages(ctx.attachments, fetchImpl);
    if (downloaded.error) return downloaded.error;
    const note = downloaded.skipped ? `\n(${downloaded.skipped} attachment(s) that are not PNG, JPEG, GIF or WebP images are left out.)` : "";
    if (!(await ctx.confirm(preview(post, downloaded.images.length, !direct) + note))) return "Cancelled: nothing was posted.";

    const result = await client.createBlogPost({ ...post, images: downloaded.images, status: direct ? "published" : "pending", submittedBy: ctx.userId });
    if (!result.ok) return result.data.error ?? "The website did not take the post.";
    const saved = result.data.post;
    if (direct) return `Published: **${saved.title}**\n${postUrl(saved)}`;
    return `${mention(getOwnerIds()[0])} **Blog post waiting for your approval:** "${saved.title}" by ${saved.author} (\`${saved.section}\`, ${saved.images.length} image(s)), sent by ${mention(ctx.userId)}.\nApprove with \`.ad blog approve latest yes\` or \`.ad blog approve name:"${saved.title}" yes\` (or \`no\` to reject).`;
  }

  async function approve(ctx) {
    if (!isOwner(ctx.userId)) return "Only a bot owner can approve blog posts.";
    const decision = parseApprove(ctx.content);
    if (decision.usage) return decision.usage;
    const result = await client.decideBlogPost({ ...(decision.which ? { which: "latest" } : { title: decision.title }), approve: decision.approve, decidedBy: ctx.userId });
    if (!result.ok) return result.data.error ?? "That didn't work.";
    const saved = result.data.post;
    return decision.approve
      ? `Approved and published: **${saved.title}** ${mention(saved.submittedBy)}\n${postUrl(saved)}`
      : `Rejected: **${saved.title}** ${mention(saved.submittedBy)} (it is not published, and its images are deleted).`;
  }

  async function remove(ctx) {
    if (!isOwner(ctx.userId)) return "Only a bot owner can delete blog posts.";
    const target = parseDelete(ctx.content);
    if (target.usage) return target.usage;
    if (!ctx.confirm || !(await ctx.confirm(`**Delete the blog post "${target.title}" and its images for good?** (reply **yes** to delete)`))) return "Cancelled: nothing was deleted.";
    const result = await client.deleteBlogPost(target.title);
    return result.ok ? `Deleted: **${result.data.post.title}**.` : result.data.error ?? "That didn't work.";
  }

  async function pending() {
    const posts = await client.pendingBlogPosts();
    if (posts.length === 0) return "No blog posts are waiting for approval.";
    return ["**Waiting for approval** (newest first):", ...posts.map((p) => `• "${p.title}" by ${p.author} (\`${p.section}\`, ${p.images.length} image(s)) from ${mention(p.submittedBy)}`)].join("\n");
  }

  return async function execute(ctx, args = []) {
    if (ctx.channelId !== blogChannel) return void (await ctx.reply(`Use the blog commands in <#${blogChannel}>.`));
    if (args[0]?.toLowerCase() !== "blog") return void (await ctx.reply(USAGE));
    if (!client.isConfigured()) return void (await ctx.reply(NOT_CONNECTED_HELP));
    const verbs = { create, approve, delete: remove, pending };
    const verb = verbs[args[1]?.toLowerCase()];
    if (!verb) return void (await ctx.reply(USAGE));
    try {
      await ctx.reply(await verb(ctx));
    } catch (error) {
      if (!(error instanceof AccountApiError)) throw error;
      await ctx.reply(error.message);
    }
  };
}

export const execute = createExecute();
