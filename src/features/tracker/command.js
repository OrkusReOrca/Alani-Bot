// ".at ..." — the trackers. See README.md for the full command list.
//
//   .at create type:"Bloodpressure tracker" me|server [name:"..."]
//   .at enable|disable "NAME" [me|server]
//   .at permission grant|revoke <username> [me|server]
//   .at setting "NAME" recuring:... at:... to:"..." tz:GMT+7 tag:a,b sent:dm|<channel id>
//   .at logadd (la) bp 120 80          .at la p bpl,fl y
//   .at bp list|export|delete          .at pill addpill|removepill|pills|list|export|delete
//   .at server <any of the above>      the server's tracker instead of yours
//   .at <user id|@user> <...>          someone else's tracker, if they granted you permission
//
// Everything needs the Tracker tag. A tracker belongs to ONE user or ONE server;
// its owner (and bot owners, and anyone the owner granted permission) can use it.

import { isOwner } from "../../common/auth.js";
import { pagesAsText } from "../../common/pagination.js";
import { TYPES, resolveType, creatableTypeNames } from "./types.js";
import { tokenize, optionsOf, wordsOf, quotedOf, splitList, parseTimezone, formatTimezone, parseRange, selectLogs, describeRange } from "./parse.js";
import { parseSchedule, describeSchedule, nextOccurrence } from "./schedule.js";
import { bpPages, pillPages, bpExportText, pillExportText, exportFileName, formatLocal } from "./format.js";
import { TrackerError } from "./storeFactory.js";

export const data = {
  name: "at",
};

export const aiGuide = `
.at is the tracker system (also typed "t" in a DM). Trackers belong to ONE user ("me", the default) or ONE server ("server"); put "server" right after .at to use the server's tracker, or a user ID/@mention to use someone else's tracker they gave permission for. Needs the Tracker tag.
Types (create only these): "Bloodpressure tracker" (one per owner), "Pill tracker" (one per owner), "Activity tracker" (many, each needs name:"...").
.at create type:"Bloodpressure tracker" me|server            — also type:"Pill tracker", or type:"Activity tracker" name:"Fortnite karaoke weekly"
.at enable|disable "TRACKER NAME" [me|server]                — turn reminders on/off (keeps all data)
.at permission grant|revoke <username> [me|server]           — let someone use all of the owner's trackers (owner only)
.at setting "TRACKER NAME" recuring:<daily|weekly|monthly|yearly> <days> at:<time> to:"reminder text" tz:GMT+7 tag:name1,name2 sent:<dm|channel id>
   daily: at:T21:00 · weekly: recuring:weekly friday,sunday at:T19:30 · monthly: recuring:monthly 1,15 at:T09:00 (or last) · yearly: recuring:yearly at:10,03,T09:00 (month,day,time)
   times are 24-hour in tz (default GMT+7). Blood pressure is daily only. A Pill tracker's setting only takes tz, tag and sent.
.at logadd bp <systolic> <diastolic>   (short: .at la bp 120 80)    — log a blood pressure reading now
.at logadd pill "Pill name","other" yes|no   (short: .at la p bpl,fl y)   — log pills taken/not taken now
.at bp list | .at bp export <range> | .at bp delete <range>          — range: latest14, oldest5, 2026/10/1-2026/11/13, all
.at pill addpill "Full name"/"alias" recuring:daily at:T21:00          — add a pill with its own reminder schedule
.at pill removepill <name|alias> · .at pill pills · .at pill list [pill] · .at pill export [pill] <range> · .at pill delete <pill> <range>
.at list                                                              — your trackers (and this server's)
Blood pressure and pill reminders are skipped if that day's reading / dose is already logged.`;

// Deleting data (or a pill with its logs) asks for a yes first.
export const isDestructive = (args) => args.slice(0, 4).some((word) => ["delete", "removepill"].includes(word.toLowerCase()));

const SCOPE_WORDS = ["me", "server"];
const USER_ID = /^<@!?(\d{15,20})>$|^(\d{15,20})$/;

const VERBS = { create: "create", enable: "enable", disable: "disable", permission: "permission", perm: "permission", setting: "setting", set: "setting", list: "list", ls: "list", logadd: "logadd", la: "logadd", bp: "bp", bloodpressure: "bp", pill: "pill", p: "pill", pills: "pills", help: "help" };
const LOG_TARGETS = { bp: "bloodpressure", bloodpressure: "bloodpressure", p: "pill", pill: "pill", pills: "pill" };
const SETTING_KEYS = {
  bloodpressure: ["recurring", "at", "to", "tz", "tag", "sent"],
  pill: ["tz", "tag", "sent"],
  activity: ["recurring", "at", "to", "tz", "tag", "sent"],
};

const BP_LIMITS = { min: 30, max: 300 };
const MAX_NAME_LENGTH = 60;

const USAGE = [
  "**Trackers** — `.at create type:\"Bloodpressure tracker\" me|server` · `.at setting \"NAME\" recuring:daily at:T21:00 to:\"...\" sent:dm`",
  "`.at la bp 120 80` · `.at bp list|export|delete` · `.at pill addpill \"Name\"/\"alias\" recuring:daily at:T21:00` · `.at la p bpl y` · `.at pill list|export|delete`",
  "`.at enable|disable \"NAME\"` · `.at permission grant|revoke <user>` · `.at list` · add `server` after `.at` for the server's tracker",
].join("\n");

const lower = (word) => word?.toLowerCase();

// ---------- scope, access ----------

// A scope says whose trackers a command is about: the caller's ("me"), this server's, or another user's.
const scopeFor = (ctx, kind) => (kind === "guild" ? { kind, word: "server", id: ctx.guildId, label: "this server's" } : { kind, word: "me", id: ctx.userId, label: "your" });

// "me" / "server" / a user mention or ID -> a scope, or null if the word isn't one.
function scopeFromWord(ctx, word) {
  const w = lower(word);
  if (w === "server") return scopeFor(ctx, "guild");
  if (w === "me") return scopeFor(ctx, "user");
  const match = USER_ID.exec(word ?? "");
  if (!match) return null;
  const id = match[1] ?? match[2];
  return id === ctx.userId ? scopeFor(ctx, "user") : { kind: "user", word: id, id, label: "that user's" };
}

function createdBy(tracker, userId) {
  return tracker.ownerKind === "user" ? tracker.ownerId === userId : tracker.createdBy === userId;
}

// Owner, bot owners, or someone the owner granted permission.
function hasAccess(store, tracker, userId) {
  return isOwner(userId) || createdBy(tracker, userId) || store.hasGrant(tracker.ownerKind, tracker.ownerId, userId);
}

// Who may hand out permission for a scope: the user themself, or whoever created a tracker for the server.
function mayManagePermissions(store, scope, userId) {
  return isOwner(userId) || (scope.kind === "user" ? scope.id === userId : store.createdAnyFor("guild", scope.id, userId));
}

const prefixFor = (scope) => (scope.kind === "guild" ? ".at server" : scope.word === "me" ? ".at" : `.at ${scope.id}`);

// The tracker of this type in the scope, if the caller may use it. -> { tracker } | { error }
function trackerOfType(ctx, deps, scope, typeId, { writing = false } = {}) {
  const type = TYPES[typeId];
  const tracker = deps.store.findByType(scope.kind, scope.id, typeId);
  if (!tracker) return { error: `${scope.kind === "guild" ? "This server doesn't" : "You don't"} have a ${type.name} yet — create it with \`${prefixFor(scope)} create type:"${type.name}" ${scope.word}\`.` };
  if (!hasAccess(deps.store, tracker, ctx.userId)) return { error: `You don't have access to ${scope.label} ${type.name} — only its owner and people they've given permission to.` };
  if (writing && !tracker.enabled) return { error: `${tracker.name} is disabled — turn it on with \`${prefixFor(scope)} enable "${tracker.name}"\`.` };
  return { tracker };
}

// Finds a tracker by name in the given scope (or, with none given, in yours and this server's).
function trackerByName(ctx, deps, name, explicitScope) {
  const scopes = explicitScope ? [explicitScope] : [scopeFor(ctx, "user"), ...(ctx.guildId ? [scopeFor(ctx, "guild")] : [])];
  const found = scopes.map((scope) => deps.store.findByName(scope.kind, scope.id, name)).filter(Boolean);
  if (found.length === 0) return { error: `No tracker called "${name}". See \`.at list\`.` };
  if (found.length > 1) return { error: `"${name}" exists both for you and for this server — add \`me\` or \`server\`.` };
  const [tracker] = found;
  if (!hasAccess(deps.store, tracker, ctx.userId)) return { error: `You don't have access to "${tracker.name}".` };
  return { tracker };
}

// ---------- shared pieces ----------

// Takes a trailing "me" / "server" word (the `enable "NAME" server` style) out of the
// words. The scope is that word's, else the leading one the command was typed with.
function takeScope(ctx, words, leading) {
  const word = words.find((w) => SCOPE_WORDS.includes(lower(w)));
  return { scope: (word && scopeFromWord(ctx, word)) || leading || null, words: words.filter((w) => w !== word) };
}

function checkScopeAvailable(ctx, scope) {
  return scope.kind === "guild" && !ctx.guildId ? "That's for a server — run it inside the server." : null;
}

async function confirmDeletion(ctx, prompt) {
  if (ctx.viaAI) return true; // .aii already asked before running this
  if (!ctx.confirm) return false;
  return ctx.confirm(prompt);
}

async function showPages(ctx, pages, detail) {
  await (ctx.replyPages ? ctx.replyPages(pages, { detail }) : ctx.reply(pagesAsText(pages)));
}

const pluralize = (n, one, many) => `${n} ${n === 1 ? one : many}`;

// ---------- create / enable / disable ----------

const nextSteps = {
  bloodpressure: (scope, tracker) =>
    `Set up its daily reminder (you can change it any time):\n\`${prefixFor(scope)} setting "${tracker.name}" recuring:daily at:T21:00 to:"Register today blood pressure" sent:dm\`\nThen log readings with \`${prefixFor(scope)} la bp 120 80\`.`,
  pill: (scope, tracker) =>
    `Add your pills (each with its own schedule):\n\`${prefixFor(scope)} pill addpill "Bloodpressure lowerer"/"bpl" recuring:daily at:T21:00\`\nReminders go to your DMs unless you change it: \`${prefixFor(scope)} setting "${tracker.name}" sent:<channel id>\`.`,
  activity: (scope, tracker) =>
    `Set when it reminds (you can change it any time):\n\`${prefixFor(scope)} setting "${tracker.name}" recuring:weekly friday,sunday at:T19:30 to:"It's time!" tag:name1,name2 sent:<channel id>\``,
};

async function handleCreate(ctx, deps, rest, leading) {
  const tokens = tokenize(rest.join(" "));
  const options = optionsOf(tokens);
  const { scope: chosen, words } = takeScope(ctx, wordsOf(tokens), leading);

  if (!options.type) return `Say what to create: \`.at create type:"Bloodpressure tracker" me\`. Available: ${creatableTypeNames().join(", ")}.`;
  const resolved = resolveType(options.type);
  if (resolved.status === "none") return `I don't know a tracker type "${options.type}". Available: ${creatableTypeNames().join(", ")}.`;
  if (resolved.status === "category") {
    const names = resolved.creatable.map((t) => `\`${t.name}\``).join(", ");
    return `"${resolved.name}" is only a category — it has nothing of its own. Create one of its trackers instead: ${names}.`;
  }

  const { type } = resolved;
  const scope = chosen ?? scopeFor(ctx, "user");
  if (scope.kind === "user" && scope.id !== ctx.userId) return "You can only create trackers for yourself or for a server.";
  const unavailable = checkScopeAvailable(ctx, scope);
  if (unavailable) return unavailable;
  if (words.length > 0) return `I didn't understand "${words.join(" ")}" — end with \`me\` or \`server\`.`;

  const name = (options.name ?? (type.onePerOwner ? type.name : "")).trim();
  if (!name) return `An ${type.name} needs a name: \`.at create type:"${type.name}" name:"Fortnite karaoke weekly" ${scope.word}\`.`;
  if (name.length > MAX_NAME_LENGTH) return `Keep the name under ${MAX_NAME_LENGTH} characters.`;

  let tracker;
  try {
    tracker = deps.store.createTracker({ type: type.type, name, ownerKind: scope.kind, ownerId: scope.id, createdBy: ctx.userId });
  } catch (err) {
    if (err instanceof TrackerError) return err.message;
    throw err;
  }
  return `✅ Created **${tracker.name}** for ${scope.kind === "guild" ? "this server" : "you"} (${type.path.join(" › ")}).\n${nextSteps[type.type](scope, tracker)}`;
}

async function handleEnable(ctx, deps, rest, enable, leading) {
  const tokens = tokenize(rest.join(" "));
  const { scope, words } = takeScope(ctx, wordsOf(tokens), leading);
  const name = quotedOf(tokens)[0] ?? words.join(" ");
  if (!name) return `Usage: \`.at ${enable ? "enable" : "disable"} "TRACKER NAME" me|server\``;

  const { tracker, error } = trackerByName(ctx, deps, name, scope);
  if (error) return error;
  deps.store.setEnabled(tracker.id, enable);
  return enable ? `✅ **${tracker.name}** is on again.` : `⏸ **${tracker.name}** is off — no reminders and no new logs, but nothing was deleted. Turn it back on with \`.at enable "${tracker.name}"\`.`;
}

// ---------- permission ----------

async function handlePermission(ctx, deps, rest, leading) {
  const [action, ...others] = rest;
  const { scope: chosen, words } = takeScope(ctx, others, leading);
  if (!["grant", "revoke"].includes(lower(action)) || words.length === 0) return "Usage: `.at permission grant|revoke <username> [me|server]`";

  const scope = chosen ?? scopeFor(ctx, "user");
  const unavailable = checkScopeAvailable(ctx, scope);
  if (unavailable) return unavailable;
  if (!mayManagePermissions(deps.store, scope, ctx.userId)) return `Only ${scope.kind === "guild" ? "the people who created this server's trackers" : "the tracker's owner"} can change who has permission.`;

  const { resolved, unresolved } = await deps.resolveUsers(words.join(" "), ctx.guildId);
  if (unresolved.length > 0 || resolved.length === 0) return `Couldn't find "${unresolved.join(", ") || words.join(" ")}" — try their user ID${ctx.guildId ? "" : " (usernames can only be looked up in a server)"}.`;

  const [userId] = resolved;
  if (lower(action) === "revoke") {
    return deps.store.revoke(scope.kind, scope.id, userId) ? `Removed <@${userId}>'s permission on ${scope.label} trackers.` : `<@${userId}> didn't have permission on ${scope.label} trackers.`;
  }
  const added = deps.store.grant(scope.kind, scope.id, userId, ctx.userId);
  const needsTag = deps.hasTrackerTag(userId) ? "" : "\nThey'll also need the Tracker tag to use `.at` (a bot owner can grant it).";
  return added ? `✅ <@${userId}> can now add, log, edit and view ${scope.label} trackers.${needsTag}` : `<@${userId}> already has permission on ${scope.label} trackers.${needsTag}`;
}

// ---------- setting ----------

async function resolveSent(ctx, deps, tracker, value) {
  if (lower(value) === "dm") return { sentTo: "dm" };
  if (!/^\d{15,20}$/.test(value)) return { error: "`sent:` is `dm` or a channel ID." };
  const problem = await deps.checkChannel(value, tracker.ownerKind === "guild" ? tracker.ownerId : null);
  return problem ? { error: problem } : { sentTo: value };
}

function describeSettings(tracker, settings, nowMs) {
  const parsed = settings.spec ? parseSchedule(settings.spec) : null;
  const next = parsed?.schedule ? nextOccurrence(parsed.schedule, settings.tzMinutes, nowMs) : null;
  const lines = [];
  if (tracker.type !== "pill") {
    lines.push(`• When: ${parsed?.schedule ? `${describeSchedule(parsed.schedule)} (${formatTimezone(settings.tzMinutes)})` : "not set — add `recuring:` and `at:`"}`);
    lines.push(`• Message: ${settings.message ? `"${settings.message}"` : "default"}`);
  } else lines.push(`• Timezone: ${formatTimezone(settings.tzMinutes)} (each pill has its own schedule)`);
  if (settings.tagIds.length > 0) lines.push(`• Tags: ${settings.tagIds.map((id) => `\`${id}\``).join(", ")}`);
  lines.push(`• Sent to: ${settings.sentTo === "dm" ? "DM" : `<#${settings.sentTo}>`}`);
  if (next) lines.push(`• Next reminder: ${formatLocal(next, settings.tzMinutes)}`);
  return lines.join("\n");
}

async function handleSetting(ctx, deps, rest, leading) {
  const tokens = tokenize(rest.join(" "));
  const options = optionsOf(tokens);
  const { scope, words } = takeScope(ctx, wordsOf(tokens), leading);
  const name = quotedOf(tokens)[0];
  if (!name) return 'Usage: `.at setting "TRACKER NAME" recuring:daily at:T21:00 to:"..." tz:GMT+7 tag:name1,name2 sent:dm`';

  const { tracker, error } = trackerByName(ctx, deps, name, scope);
  if (error) return error;
  const allowed = SETTING_KEYS[tracker.type];
  const unknown = Object.keys(options).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) {
    const hint = tracker.type === "pill" ? " Pills get their schedule from `.at pill addpill`." : "";
    return `${tracker.name} doesn't take ${unknown.map((k) => `\`${k}:\``).join(", ")}. It takes: ${allowed.map((k) => `\`${k}:\``).join(", ")}.${hint}`;
  }
  if (Object.keys(options).length === 0) return `${tracker.name}\n${describeSettings(tracker, deps.store.getSettings(tracker.id), deps.now())}`;

  const current = deps.store.getSettings(tracker.id);
  const next = { ...current };

  if (options.recurring || options.at || words.length > 0) {
    const spec = {
      recurring: options.recurring ?? current.spec?.recurring ?? (tracker.type === "bloodpressure" ? "daily" : undefined),
      words: words.length > 0 ? words : current.spec?.words ?? [],
      at: options.at ?? current.spec?.at,
    };
    if (tracker.type === "bloodpressure" && lower(spec.recurring) !== "daily") return "Blood pressure is logged daily, so its reminder is `recuring:daily`.";
    const parsed = parseSchedule(spec);
    if (parsed.error) return parsed.error;
    next.spec = { ...spec, recurring: lower(spec.recurring) };
  }
  if (options.tz !== undefined) {
    const tz = parseTimezone(options.tz);
    if (tz === null) return "`tz:` looks like `GMT+7` or `GMT-5` (or `GMT+5:30`).";
    next.tzMinutes = tz;
  }
  if (options.to !== undefined) next.message = options.to.trim() || null;
  if (options.tag !== undefined) {
    const { resolved, unresolved } = await deps.resolveUsers(options.tag, tracker.ownerKind === "guild" ? tracker.ownerId : ctx.guildId);
    if (unresolved.length > 0) return `Couldn't find ${unresolved.map((u) => `"${u}"`).join(", ")} to tag — try their user IDs${ctx.guildId ? "" : " (usernames can only be looked up in a server)"}.`;
    next.tagIds = resolved;
  }
  if (options.sent !== undefined) {
    const sent = await resolveSent(ctx, deps, tracker, options.sent);
    if (sent.error) return sent.error;
    next.sentTo = sent.sentTo;
  }

  deps.store.saveSettings(tracker.id, next);
  if (next.spec) deps.engine.primeTracker(tracker); // starts from the NEXT occurrence
  return `✅ Updated **${tracker.name}**\n${describeSettings(tracker, next, deps.now())}`;
}

// ---------- list ----------

async function handleList(ctx, deps) {
  const lines = [];
  for (const scope of [scopeFor(ctx, "user"), ...(ctx.guildId ? [scopeFor(ctx, "guild")] : [])]) {
    const trackers = deps.store.listTrackers(scope.kind, scope.id).filter((t) => hasAccess(deps.store, t, ctx.userId));
    lines.push(`**${scope.kind === "guild" ? "This server's trackers" : "Your trackers"}**`);
    if (trackers.length === 0) lines.push("none");
    for (const t of trackers) {
      const settings = deps.store.getSettings(t.id);
      const schedule = settings.spec ? parseSchedule(settings.spec).schedule : null;
      const detail = t.type === "pill" ? pluralize(deps.store.listPills(t.id).length, "pill", "pills") : schedule ? describeSchedule(schedule) : "no reminder set";
      lines.push(`• **${t.name}** (${TYPES[t.type].name}) — ${t.enabled ? "on" : "off"} · ${detail}`);
    }
  }
  return lines.join("\n");
}

// ---------- log ranges: list / export / delete ----------

// Shared by the blood pressure and pill groups.
//   source: { logs, tracker, tz, pages, exportText, exportPrefix, noun }
async function handleLogRange(ctx, deps, sub, rangeArg, source) {
  const range = parseRange(rangeArg);
  if (range.error) return range.error;
  const selected = selectLogs(source.logs, range, source.tz);
  const rangeText = describeRange(range);
  if (selected.length === 0) return `No ${source.noun}s in ${rangeText}.`;

  if (sub === "export") {
    const text = source.exportText(selected, { trackerName: source.tracker.name, tzMinutes: source.tz, rangeText, nowMs: deps.now() });
    await ctx.replyWithFile(Buffer.from(text, "utf8"), exportFileName(source.exportPrefix, deps.now(), source.tz));
    return `📄 Exported ${pluralize(selected.length, source.noun, `${source.noun}s`)} (${rangeText}).`;
  }

  const [newest, oldest] = [selected[0], selected.at(-1)];
  const span = `${formatLocal(Date.parse(oldest.loggedAt), source.tz)} → ${formatLocal(Date.parse(newest.loggedAt), source.tz)}`;
  const confirmed = await confirmDeletion(ctx, `Delete **${pluralize(selected.length, source.noun, `${source.noun}s`)}** (${rangeText}, ${span}) from ${source.tracker.name}? This can't be undone. Reply **yes** within 60 seconds.`);
  if (!confirmed) return "Okay, nothing was deleted.";
  source.remove(selected.map((log) => log.id));
  return `🗑 Deleted ${pluralize(selected.length, source.noun, `${source.noun}s`)} (${rangeText}).`;
}

const SUBS = { list: "list", l: "list", ls: "list", export: "export", exp: "export", delete: "delete", del: "delete", rm: "delete" };

// ---------- blood pressure ----------

function validBloodPressure(systolic, diastolic) {
  const numbers = [systolic, diastolic];
  if (numbers.some((n) => !Number.isInteger(n) || n < BP_LIMITS.min || n > BP_LIMITS.max)) return `Readings should be whole numbers between ${BP_LIMITS.min} and ${BP_LIMITS.max}.`;
  return systolic > diastolic ? null : "The first number (systolic) has to be higher than the second (diastolic) — e.g. `120 80`.";
}

async function logBloodPressure(ctx, deps, scope, args) {
  const [systolic, diastolic] = args.map((a) => (/^\d+$/.test(a) ? Number(a) : NaN));
  if (args.length !== 2) return `Usage: \`${prefixFor(scope)} la bp <systolic> <diastolic>\` — e.g. \`${prefixFor(scope)} la bp 120 80\``;
  const problem = validBloodPressure(systolic, diastolic);
  if (problem) return problem;

  const { tracker, error } = trackerOfType(ctx, deps, scope, "bloodpressure", { writing: true });
  if (error) return error;
  const now = new Date(deps.now());
  deps.store.addBpLog(tracker.id, systolic, diastolic, ctx.userId, now);
  return `🩺 Logged **${systolic}/${diastolic}** at ${formatLocal(now.getTime(), deps.store.getSettings(tracker.id).tzMinutes)}.`;
}

async function handleBloodPressure(ctx, deps, scope, rest) {
  const sub = SUBS[lower(rest[0])];
  if (!sub) return `Usage: \`${prefixFor(scope)} bp list\` · \`bp export <range>\` · \`bp delete <range>\` — range: \`latest14\`, \`oldest5\`, \`2026/10/1-2026/11/13\`, \`all\``;
  const { tracker, error } = trackerOfType(ctx, deps, scope, "bloodpressure");
  if (error) return error;
  const tz = deps.store.getSettings(tracker.id).tzMinutes;
  const logs = deps.store.listBpLogs(tracker.id);

  if (sub === "list") {
    const detail = logs.length === 0 ? "No readings." : logs.map((l) => `${formatLocal(Date.parse(l.loggedAt), tz)} ${l.systolic}/${l.diastolic}`).join("\n");
    await showPages(ctx, bpPages(logs, tracker.name, tz), detail);
    return null;
  }
  if (!rest[1]) return `Usage: \`${prefixFor(scope)} bp ${sub} <latestX|oldestX|date-date|all>\``;
  return handleLogRange(ctx, deps, sub, rest[1], { logs, tracker, tz, noun: "reading", exportText: bpExportText, exportPrefix: "bloodpressure", remove: (ids) => deps.store.deleteBpLogs(ids) });
}

// ---------- pills ----------

const YES_WORDS = new Set(["y", "yes"]);
const NO_WORDS = new Set(["n", "no"]);

async function logPills(ctx, deps, scope, args) {
  const answer = lower(args.at(-1));
  if (args.length < 2 || !(YES_WORDS.has(answer) || NO_WORDS.has(answer))) return `Usage: \`${prefixFor(scope)} la p <pill>,<pill> yes|no\` — e.g. \`${prefixFor(scope)} la p bpl,fl y\``;
  const { tracker, error } = trackerOfType(ctx, deps, scope, "pill", { writing: true });
  if (error) return error;

  const pills = [];
  for (const text of splitList(args.slice(0, -1).join(" "))) {
    const pill = deps.store.findPill(tracker.id, text);
    if (!pill) return `No pill "${text}" in ${tracker.name}. See \`${prefixFor(scope)} pill pills\`.`;
    pills.push(pill);
  }
  const now = new Date(deps.now());
  for (const pill of pills) deps.store.addPillLog(pill.id, YES_WORDS.has(answer), ctx.userId, "command", now);
  return `${YES_WORDS.has(answer) ? "✅ Logged as taken" : "📝 Logged as not taken"}: ${pills.map((p) => `**${p.name}**`).join(", ")} (${formatLocal(now.getTime(), deps.store.getSettings(tracker.id).tzMinutes)}).`;
}

async function addPill(ctx, deps, scope, tracker, rest) {
  const tokens = tokenize(rest.join(" "));
  const options = optionsOf(tokens);
  const pair = tokens.find((t) => t.kind === "pair");
  const name = pair?.first ?? quotedOf(tokens)[0];
  if (!name) return `Usage: \`${prefixFor(scope)} pill addpill "Full name"/"alias" recuring:daily at:T21:00\``;

  const spec = { recurring: options.recurring, words: wordsOf(tokens), at: options.at };
  const parsed = parseSchedule(spec);
  if (parsed.error) return parsed.error;

  let pill;
  try {
    pill = deps.store.addPill(tracker.id, { name, alias: pair?.second ?? null, spec: { ...spec, recurring: lower(spec.recurring) } });
  } catch (err) {
    if (err instanceof TrackerError) return err.message;
    throw err;
  }
  deps.engine.primePill(pill);
  const settings = deps.store.getSettings(tracker.id);
  const next = nextOccurrence(parsed.schedule, settings.tzMinutes, deps.now());
  return `💊 Added **${pill.name}**${pill.alias ? ` (alias \`${pill.alias}\`)` : ""} — ${describeSchedule(parsed.schedule)} (${formatTimezone(settings.tzMinutes)}).${next ? ` Next reminder: ${formatLocal(next, settings.tzMinutes)}.` : ""}`;
}

async function handlePills(ctx, deps, scope, rest) {
  const verb = lower(rest[0]);
  const { tracker, error } = trackerOfType(ctx, deps, scope, "pill", { writing: verb === "addpill" || verb === "removepill" });
  if (error) return error;
  const tz = deps.store.getSettings(tracker.id).tzMinutes;

  if (verb === "addpill") return addPill(ctx, deps, scope, tracker, rest.slice(1));

  if (verb === "pills") {
    const pills = deps.store.listPills(tracker.id);
    if (pills.length === 0) return `No pills yet — add one with \`${prefixFor(scope)} pill addpill "Name"/"alias" recuring:daily at:T21:00\`.`;
    return pills.map((p) => `• **${p.name}**${p.alias ? ` (\`${p.alias}\`)` : ""} — ${describeSchedule(parseSchedule(p.spec).schedule)}`).join("\n");
  }

  if (verb === "removepill") {
    const pill = deps.store.findPill(tracker.id, cleanName(rest.slice(1)));
    if (!pill) return `No pill "${cleanName(rest.slice(1))}". See \`${prefixFor(scope)} pill pills\`.`;
    const confirmed = await confirmDeletion(ctx, `Remove **${pill.name}** and all its logs from ${tracker.name}? This can't be undone. Reply **yes** within 60 seconds.`);
    if (!confirmed) return "Okay, nothing was removed.";
    deps.store.removePill(pill.id);
    deps.engine.forgetPill(pill);
    return `🗑 Removed **${pill.name}** and its logs.`;
  }

  const sub = SUBS[verb];
  if (!sub) return `Usage: \`${prefixFor(scope)} pill addpill|removepill|pills|list|export|delete\` — e.g. \`pill list bpl\`, \`pill export bpl latest14\`, \`pill delete bpl all\``;

  // list [pill] · export [pill] <range> · delete <pill> <range>
  const args = rest.slice(1);
  const rangeArg = sub === "list" ? null : args.at(-1);
  const nameWords = sub === "list" ? args : args.slice(0, -1);
  if (sub !== "list" && !rangeArg) return `Usage: \`${prefixFor(scope)} pill ${sub} ${sub === "delete" ? "<pill>" : "[pill]"} <latestX|oldestX|date-date|all>\``;
  if (sub === "delete" && nameWords.length === 0) return `Name the pill whose logs to delete: \`${prefixFor(scope)} pill delete <pill> <range>\``;

  const pills = nameWords.length > 0 ? [deps.store.findPill(tracker.id, cleanName(nameWords))].filter(Boolean) : deps.store.listPills(tracker.id);
  if (nameWords.length > 0 && pills.length === 0) return `No pill "${cleanName(nameWords)}". See \`${prefixFor(scope)} pill pills\`.`;
  const logs = deps.store.listPillLogs(pills.map((p) => p.id));

  if (sub === "list") {
    const detail = logs.length === 0 ? "No logs." : logs.map((l) => `${formatLocal(Date.parse(l.loggedAt), tz)} ${l.pillName} ${l.taken ? "taken" : "not taken"}`).join("\n");
    await showPages(ctx, pillPages(logs, pills.length === 1 ? `${tracker.name} · ${pills[0].name}` : tracker.name, tz), detail);
    return null;
  }
  return handleLogRange(ctx, deps, sub, rangeArg, { logs, tracker, tz, noun: "log", exportText: pillExportText, exportPrefix: "pills", remove: (ids) => deps.store.deletePillLogs(ids) });
}

const cleanName = (words) => words.join(" ").trim().replace(/^["'`](.*)["'`]$/, "$1");

// ---------- dispatch ----------

async function run(ctx, args, deps) {
  if (!deps.hasTrackerTag(ctx.userId)) {
    await ctx.reply("You don't have permission to use `.at` — it needs the Tracker tag, which only a bot owner can grant (`.a tag add Tracker <user>`).");
    return;
  }

  // A leading "server" / "me" / user ID picks whose trackers the command is about.
  let rest = args;
  const leading = rest.length > 1 ? scopeFromWord(ctx, rest[0]) : null;
  if (leading) rest = rest.slice(1);
  const verb = VERBS[lower(rest[0])];
  const tail = rest.slice(1);
  const scope = leading ?? scopeFor(ctx, "user");

  const needsScope = ["bp", "pill", "pills", "logadd"].includes(verb);
  const unavailable = needsScope ? checkScopeAvailable(ctx, scope) : null;
  let reply;
  if (unavailable) reply = unavailable;
  else if (verb === "create") reply = await handleCreate(ctx, deps, tail, leading);
  else if (verb === "enable" || verb === "disable") reply = await handleEnable(ctx, deps, tail, verb === "enable", leading);
  else if (verb === "permission") reply = await handlePermission(ctx, deps, tail, leading);
  else if (verb === "setting") reply = await handleSetting(ctx, deps, tail, leading);
  else if (verb === "list") reply = await handleList(ctx, deps);
  else if (verb === "logadd") reply = await handleLogAdd(ctx, deps, scope, tail);
  else if (verb === "bp") reply = await handleBloodPressure(ctx, deps, scope, tail);
  else if (verb === "pill") reply = await handlePills(ctx, deps, scope, tail);
  else if (verb === "pills") reply = await handlePills(ctx, deps, scope, ["pills"]);
  else reply = USAGE;

  if (reply) await ctx.reply(reply);
}

async function handleLogAdd(ctx, deps, scope, args) {
  const target = LOG_TARGETS[lower(args[0])];
  if (target === "bloodpressure") return logBloodPressure(ctx, deps, scope, args.slice(1));
  if (target === "pill") return logPills(ctx, deps, scope, args.slice(1));
  return `Usage: \`${prefixFor(scope)} la bp 120 80\` or \`${prefixFor(scope)} la p bpl,fl y\``;
}

// `deps` is everything the command needs from the outside world; tests pass fakes.
export function createExecute(deps) {
  return (ctx, args = []) => run(ctx, args, deps);
}
