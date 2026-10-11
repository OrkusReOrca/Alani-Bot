// The reminder engine. tick() looks at every enabled tracker and sends whatever
// is due:
//
//   Bloodpressure / Activity   the tracker's own message at its schedule. A blood
//                              pressure reminder is skipped if a reading was
//                              already logged that day.
//   Pill                       one message per moment, listing every pill due then
//                              that hasn't been logged as taken that day. In a DM
//                              it also waits for a plain yes/no reply (pillReply.js).
//
// A reminder fires at most once per occurrence (reminderState.js). If the bot was
// down at the time, an occurrence up to an hour late is still sent; older ones are
// skipped. Everything outside this file is injected (store, state, delivery, clock),
// so the whole thing runs in tests without Discord.

import { parseSchedule, latestOccurrence, localDay } from "./schedule.js";
import { formatLocal } from "./format.js";

export const LATE_LIMIT_MS = 60 * 60 * 1000;

// Who the tracker belongs to as a person: the user, or whoever created a server's tracker.
export const recipientOf = (tracker) => (tracker.ownerKind === "user" ? tracker.ownerId : tracker.createdBy);

const unique = (items) => [...new Set(items)];
const plural = (n, one, many) => (n === 1 ? one : many);
const scheduleKey = {
  tracker: (tracker) => `tracker:${tracker.id}`,
  pill: (pill) => `pill:${pill.id}`,
};

// delivery: { dm(userId, text), channel(channelId, text) } — both return promises.
export function createReminderEngine({ store, state, delivery, now = Date.now, log = console }) {
  // Sends `text` where the tracker's settings say, to the owner and anyone tagged.
  async function send(tracker, settings, text) {
    const people = unique([recipientOf(tracker), ...settings.tagIds]);
    if (settings.sentTo === "dm") {
      for (const userId of people) {
        await delivery.dm(userId, text).catch((err) => log.error(`[tracker] couldn't DM ${userId}:`, err.message));
      }
      return;
    }
    const mentions = unique([...settings.tagIds, ...(tracker.ownerKind === "user" ? [tracker.ownerId] : [])]).map((id) => `<@${id}>`).join(" ");
    await delivery.channel(settings.sentTo, mentions ? `${text} ${mentions}` : text);
  }

  async function remindSingle(tracker, settings, nowMs) {
    if (!settings.spec) return;
    const parsed = parseSchedule(settings.spec);
    if (!parsed.schedule) return;

    const occurrence = latestOccurrence(parsed.schedule, settings.tzMinutes, nowMs, LATE_LIMIT_MS);
    const key = scheduleKey.tracker(tracker);
    if (occurrence === null || state.firedAt(key) >= occurrence) return;
    state.markFired(key, occurrence);

    if (tracker.type === "bloodpressure") {
      const day = localDay(occurrence, settings.tzMinutes);
      if (store.hasBpLogBetween(tracker.id, day.start, day.end)) return; // today's reading is already in
    }
    await send(tracker, settings, settings.message ?? `Time for ${tracker.name}!`);
  }

  async function remindPills(tracker, settings, nowMs) {
    const dueByMoment = new Map(); // occurrence (ms) -> pills due then
    for (const pill of store.listPills(tracker.id)) {
      const parsed = parseSchedule(pill.spec);
      if (!parsed.schedule) continue;
      const occurrence = latestOccurrence(parsed.schedule, settings.tzMinutes, nowMs, LATE_LIMIT_MS);
      const key = scheduleKey.pill(pill);
      if (occurrence === null || state.firedAt(key) >= occurrence) continue;
      state.markFired(key, occurrence);

      const day = localDay(occurrence, settings.tzMinutes);
      if (store.wasPillTakenBetween(pill.id, day.start, day.end)) continue; // already taken today
      dueByMoment.set(occurrence, [...(dueByMoment.get(occurrence) ?? []), pill]);
    }

    for (const pills of dueByMoment.values()) {
      const names = pills.map((pill) => pill.name).join(", ");
      const inDm = settings.sentTo === "dm";
      const ask = inDm ? "Reply **yes** or **no**." : "Log it with `.at la p <pill> y`.";
      await send(tracker, settings, `💊 Reminder to take ${plural(pills.length, "pill", "pills")} "${names}" — have you taken ${plural(pills.length, "it", "them")} yet? ${ask}`);
      if (inDm) state.setPending(recipientOf(tracker), { trackerId: tracker.id, pillIds: pills.map((pill) => pill.id) }, nowMs);
    }
  }

  return {
    async tick() {
      const nowMs = now();
      for (const tracker of store.listEnabledTrackers()) {
        try {
          const settings = store.getSettings(tracker.id);
          await (tracker.type === "pill" ? remindPills(tracker, settings, nowMs) : remindSingle(tracker, settings, nowMs));
        } catch (err) {
          log.error(`[tracker] reminder for "${tracker.name}" (${tracker.id}) failed:`, err);
        }
      }
    },

    // A schedule that was just set starts from its NEXT occurrence — one that
    // already passed an hour ago today must not fire the moment it's configured.
    primeTracker: (tracker) => state.markFired(scheduleKey.tracker(tracker), now()),
    primePill: (pill) => state.markFired(scheduleKey.pill(pill), now()),
    forgetPill: (pill) => state.forget(scheduleKey.pill(pill)),

    describeMoment: (tracker, ms) => formatLocal(ms, store.getSettings(tracker.id).tzMinutes),
  };
}

// Runs the engine every `intervalMs` (default: every 30 seconds, like the other schedulers).
export function startReminderEngine(engine, intervalMs = 30 * 1000) {
  const timer = setInterval(() => engine.tick().catch((err) => console.error("[tracker] tick failed:", err)), intervalMs);
  console.log("[tracker] reminder engine started");
  return timer;
}
