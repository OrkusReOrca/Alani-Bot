// Parsing of the reminder / event arguments of `.a db add|edit ...`, shared by every database kind
// (the local tiered databases in recordActions.js and the Alatomy account DB in
// features/alatomy-account/). Pure: it turns the argument tokens into a plain object, or returns
// { usage } with the text to show when the arguments are wrong. Nothing here touches storage.

import { extractQuoted, stripTrailingModifiers } from "./textParsing.js";
import { DEFAULT_EVENT_DURATION_MS } from "./recordRules.js";
import { parseIct, startOfIctDay } from "../features/orkus-info/format.js";

export const ADD_REMINDER_USAGE =
  'Usage: `.a db [<name>] add reminder <YYYY-MM-DDTHH:MM> "<text>" [mentions] [channel-id] [force]` (24hr time, Indochina/Bangkok timezone; mentions is a comma-separated list of user IDs and/or usernames, tagged when the reminder fires)';

export const EDIT_REMINDER_USAGE =
  'Usage: `.a db edit reminder <id> <YYYY-MM-DDTHH:MM> "<text>"` (replaces both fields; destination/channel/mentions unchanged — delete and re-add to change those)';

export const ADD_EVENT_USAGE =
  'Usage: `.a db add event <start> [end|allday] "<title>" [| <location>] [force]` (24hr time, Indochina/Bangkok timezone, e.g. 2026-08-25T15:00 — year/month optional, assumes current; end defaults to 1 hour after start if omitted; use `allday` in place of end for an all-day event; `| <location>` is optional, defaults to this database\'s name; add `force` at the end to skip the duplicate check)';

export const EDIT_EVENT_USAGE =
  'Usage: `.a db edit event <id> <start> <end> "<title>" [| <location>]` (replaces all fields, 24hr time, Indochina/Bangkok timezone; location unchanged if omitted)';

// Splits the tokens AFTER a quoted title's closing quote on a literal "|" — everything before it (if
// any) is checked for "force", everything after (joined back with spaces) is the location. Location
// itself isn't quoted (only the title/text "name" fields are, per the standard).
export function parseEventModifiers(tokens) {
  const pipeIdx = tokens.indexOf("|");
  const modifierTokens = pipeIdx === -1 ? tokens : tokens.slice(0, pipeIdx);
  const location = pipeIdx === -1 ? null : tokens.slice(pipeIdx + 1).join(" ").trim() || null;
  const force = modifierTokens.some((t) => t.toLowerCase() === "force");
  return { force, location };
}

/** `<when> "<text>" [mentions] [channel-id] [force]` -> { text, remindAt, force, channelId, mentions } */
export function parseAddReminder(args) {
  const [when, ...afterWhen] = args;
  const remindAt = parseIct(when);
  const quoted = extractQuoted(afterWhen);
  if (!remindAt || !quoted || !quoted.text.trim()) return { usage: ADD_REMINDER_USAGE };
  const { force, channelId, mentions } = stripTrailingModifiers(quoted.after, { allowMentions: true });
  return { text: quoted.text.trim(), remindAt, force, channelId, mentions };
}

/** `<id> <when> "<text>"` -> { displayNumber, remindAt, text } */
export function parseEditReminder(args) {
  const quoted = extractQuoted(args);
  const [displayNumber, when] = quoted?.before ?? [];
  const text = quoted?.text.trim();
  const remindAt = parseIct(when);
  if (!displayNumber || !remindAt || !text) return { usage: EDIT_REMINDER_USAGE };
  return { displayNumber, remindAt, text };
}

/** `<start> [end|allday] "<title>" [| <location>] [force]` -> { title, startTime, endTime, allDay, force, location } (location null if not given) */
export function parseAddEvent(args) {
  const quoted = extractQuoted(args);
  if (!quoted) return { usage: ADD_EVENT_USAGE };
  const { force, location } = parseEventModifiers(quoted.after);
  const [startRaw, second] = quoted.before;
  const parsedStart = parseIct(startRaw);
  if (!parsedStart) return { usage: ADD_EVENT_USAGE };

  let startTime = parsedStart;
  let endTime;
  let allDay = false;
  if (second?.toLowerCase() === "allday") {
    allDay = true;
    startTime = startOfIctDay(parsedStart);
    endTime = new Date(startTime.getTime() + 24 * 60 * 60 * 1000);
  } else if (second) {
    const parsedEnd = parseIct(second);
    if (!parsedEnd) return { usage: ADD_EVENT_USAGE };
    endTime = parsedEnd;
  } else {
    endTime = new Date(parsedStart.getTime() + DEFAULT_EVENT_DURATION_MS);
  }

  const title = quoted.text.trim();
  if (!title || endTime <= startTime) return { usage: ADD_EVENT_USAGE };
  return { title, startTime, endTime, allDay, force, location };
}

/** `<id> <start> <end> "<title>" [| <location>]` -> { id, startTime, endTime, title, location } (location null if not given) */
export function parseEditEvent(args) {
  const quoted = extractQuoted(args);
  const [id, start, end] = quoted?.before ?? [];
  const title = quoted?.text.trim();
  const { location } = parseEventModifiers(quoted?.after ?? []);
  const startTime = parseIct(start);
  const endTime = parseIct(end);
  if (!id || !startTime || !endTime || !title || endTime <= startTime) return { usage: EDIT_EVENT_USAGE };
  return { id, startTime, endTime, title, location };
}
