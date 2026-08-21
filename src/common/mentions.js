// Resolves a comma-separated mentions field (from the trailing modifiers
// on `.a db add/edit reminder`) into real Discord user IDs to tag when
// the reminder fires. Each comma-separated entry is either a bare
// Discord snowflake (used directly, no lookup needed) or a
// username/nickname that needs a guild member search — Discord has no
// global username index, so that search needs SOME guild to run against.
//
// Resolved once at add-time, not deferred to fire-time: this matches the
// same "reject bad input immediately, don't add it and hope for the best
// later" philosophy channelAccess.js's canSendInChannel already follows
// for channel targets — a mention that can't be resolved now almost
// certainly still won't resolve hours/days later when the reminder fires,
// so there's nothing to gain by deferring the failure.

import { getClient } from "./discordClient.js";

const SNOWFLAKE_RE = /^\d{15,20}$/;

// guildId: the best guild to search for username lookups in — callers
// pick this (the reminder's own target channel's guild if it has one,
// else the database's own guild_id, else null if there's genuinely no
// guild context available at all, e.g. a DM-only personal database).
// Returns { resolved: string[], unresolved: string[] } — unresolved
// entries are exactly what the caller typed, for a clear error message.
export async function resolveMentions(mentionsToken, guildId) {
  const entries = mentionsToken
    .split(",")
    .map((e) => e.trim())
    .filter(Boolean);

  const resolved = [];
  const unresolved = [];

  for (const entry of entries) {
    if (SNOWFLAKE_RE.test(entry)) {
      resolved.push(entry);
      continue;
    }
    if (!guildId) {
      unresolved.push(entry);
      continue;
    }
    try {
      const guild = await getClient().guilds.fetch(guildId);
      const members = await guild.members.fetch({ query: entry, limit: 1 });
      const member = members.first();
      if (member) {
        resolved.push(member.id);
      } else {
        unresolved.push(entry);
      }
    } catch {
      unresolved.push(entry);
    }
  }

  return { resolved, unresolved };
}

// "<@id1> <@id2> ..." — appended to a reminder's fired message so those
// users actually get pinged. Only meaningfully notifies anyone when the
// reminder posts to a shared channel — a DM only reaches the original
// creator, so mentioning someone else there doesn't notify them at all
// (Discord doesn't deliver one user's DM channel to a third party
// regardless of `<@id>` syntax in the text). Still included as plain
// text either way rather than special-cased away, since that DM
// limitation is about Discord's delivery model, not something worth
// silently hiding data over.
export function formatMentions(userIds) {
  if (!userIds || userIds.length === 0) return "";
  return userIds.map((id) => `<@${id}>`).join(" ");
}
