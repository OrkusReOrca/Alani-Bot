// Whether the bot can actually post in a given channel — a bot-CAPABILITY
// check, not a user-authorization check (it says nothing about whether
// the calling Discord user should be allowed to target that channel,
// only whether Alani herself has permission to send there). Originally
// lived only in orkus-info/actions.js; pulled out here once a second
// caller needed it (the tier system's `.a db create` — see
// src/features/db/command.js) so both share one implementation instead
// of two copies drifting apart. Behavior is unchanged from the original.

import { PermissionsBitField } from "discord.js";

export async function canSendInChannel(client, channel) {
  if (!channel || typeof channel.isTextBased !== "function" || !channel.isTextBased()) return false;
  if (channel.guild) {
    const perms = channel.permissionsFor(client.user);
    return Boolean(perms?.has(PermissionsBitField.Flags.SendMessages));
  }
  return true; // DM/group channels: fetch succeeding is good enough
}
