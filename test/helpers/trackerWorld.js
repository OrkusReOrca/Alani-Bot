// A complete tracker world for tests: a real (in-memory) tracker database, the real
// `.at` command, and fake Discord pieces (users, channels, confirmation, clock).

import { DatabaseSync } from "node:sqlite";
import { createTrackerStore } from "../../src/features/tracker/storeFactory.js";

export const IDS = {
  botOwner: "100000000000000001",
  user: "200000000000000002",
  friend: "300000000000000003",
  stranger: "500000000000000005",
  guild: "900000000000000009",
  otherGuild: "900000000000000010",
  channel: "400000000000000004",
  foreignChannel: "400000000000000044",
};

// 2026-10-11 is a Sunday. 12:00 UTC = 19:00 in GMT+7.
export const NOW = Date.UTC(2026, 9, 11, 12, 0);

export async function makeWorld({ now = NOW, taggedUsers = [IDS.user, IDS.friend] } = {}) {
  const { createExecute } = await import("../../src/features/tracker/command.js");
  const store = createTrackerStore(new DatabaseSync(":memory:"));
  const clock = { now };
  const calls = { primedTrackers: [], primedPills: [], forgottenPills: [] };
  const tagged = new Set(taggedUsers);
  const directory = { higgorca: IDS.user, david: "600000000000000006", sam: "700000000000000007", friend: IDS.friend }; // usernames the fake server knows

  const deps = {
    store,
    now: () => clock.now,
    engine: {
      primeTracker: (tracker) => calls.primedTrackers.push(tracker.id),
      primePill: (pill) => calls.primedPills.push(pill.id),
      forgetPill: (pill) => calls.forgottenPills.push(pill.id),
    },
    // Like the real tag check: bot owners hold every tag.
    hasTrackerTag: (userId) => userId === IDS.botOwner || tagged.has(userId),
    resolveUsers: async (text) => {
      const resolved = [];
      const unresolved = [];
      for (const entry of text.split(",").map((e) => e.trim()).filter(Boolean)) {
        if (/^\d{15,20}$/.test(entry)) resolved.push(entry);
        else if (directory[entry.toLowerCase()]) resolved.push(directory[entry.toLowerCase()]);
        else unresolved.push(entry);
      }
      return { resolved, unresolved };
    },
    // Only the channels of the right server are "postable".
    checkChannel: async (channelId, guildId) => {
      if (channelId === IDS.foreignChannel) return guildId ? "A server tracker can only send to a channel of its own server." : null;
      return channelId === IDS.channel ? null : `Can't send in channel \`${channelId}\` — check the ID and that Alani can post there.`;
    },
  };
  const execute = createExecute(deps);

  // Runs ".at <line>" as `user` and returns everything the bot said back.
  async function run(line, { user = IDS.user, guildId = null, confirmAnswer = true, viaAI = false } = {}) {
    const out = { replies: [], files: [], pages: null, pageOptions: null, confirmations: [] };
    const ctx = {
      userId: user,
      channelId: "c1",
      guildId,
      viaAI,
      reply: async (text) => out.replies.push(text),
      replyWithFile: async (buffer, name) => out.files.push({ text: buffer.toString("utf8"), name }),
      replyPages: async (pages, options) => Object.assign(out, { pages, pageOptions: options }),
      confirm: async (prompt) => (out.confirmations.push(prompt), confirmAnswer),
    };
    await execute(ctx, line.split(/\s+/).filter(Boolean));
    out.text = out.replies.join("\n");
    return out;
  }

  return { store, run, clock, calls, tagged, deps, IDS };
}
