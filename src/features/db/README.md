# db

`.a db [<database>] <verb> [args...]` — structured data (reminders,
calendar events), permissioned **per database**, not by one flat gate.
Not a database itself — a dispatcher (`registry.js`, keyed by database
*kind*: `orkus-info`, `general-user-db`, `general-server-db`) plus
resolution logic in `command.js` that figures out which specific database
*instance* a command is actually targeting (`store.js` holds that
instance metadata — tier grants, database ownership, collaborators).

Handled by the persistent bot process (`src/bot.js`) — needs the bot
running.

## The three tiers

| Tier | Database | Cap | Who can access | Channel restriction | Google Calendar | Discord Scheduled Event |
|---|---|---|---|---|---|---|
| **Main** | orkus-info (the original, fixed database) | 1 (fixed, always exists) | `DISCORD_OWNER_0`/`DISCORD_OWNER_1` only | `DISCORD_COMMAND_BOX` channel only | yes | no |
| **Personal** | `general-user-db` | 1 per Tier-Personal user | that user + bot owners | none — any channel | no | no |
| **Server** | `general-server-db` | 1 per Tier-Server user | that user + collaborators they add + bot owners | none — any channel | no | yes, mirrored (create/edit/delete) |

Bot owners can always reach every database everywhere, at every tier,
including frozen ones (see "Revoking a tier" below) — nobody else can.

Main tier is exactly the bot's original single-database design, kept
completely separate/untouched by the tier system added on top of it —
its own code (`src/features/orkus-info/`) doesn't share logic with the
two general-\*-db modules, and its Google Calendar sync stays exclusive
to it. See `src/features/orkus-info/README.md`.

## Granting/revoking tiers (bot owner only, any channel)

```
.a db grant personal <user-id>
.a db grant server <user-id>
.a db revoke personal <user-id>
.a db revoke server <user-id>
```

Revoking doesn't delete anything — it **freezes** every database that
user *owns* (not ones they merely collaborate on) — fully inaccessible to
anyone but a bot owner until either the tier is re-granted (which
auto-unfreezes it) or a bot owner reassigns it with `.a db transfer`.

If a general-server-db's *creator* loses Tier Server, the whole database
freezes — collaborators included — rather than silently picking a new
owner. `.a db transfer <name> <new-owner-id>` (bot owner only) is the
manual escape hatch, and un-freezes as a side effect.

## Creating/managing a database (the tiered user, any channel)

```
.a db create personal <name> <channel-id|dm>
.a db create server <name> <channel-id|dm>
.a db drop <name>
.a db collab add <name> <user-id>       (server-kind only)
.a db collab remove <name> <user-id>    (server-kind only)
```

- `create` needs the matching tier grant first, and enforces the 1-per-owner
  cap (a frozen database still counts — `drop` it before creating a fresh
  one). `<name>` can't collide with a reserved word or an already-existing
  database name anywhere in the bot (names are globally unique — see
  "Database resolution" below for why).
- `<channel-id|dm>` is the **primary channel** — where that database's
  reminders/events get delivered by default (same "DM vs. a specific
  channel" choice orkus-info's reminders already have). It does **not**
  restrict where the database can be *managed* — every add/list/delete/edit
  command still works from any channel. An individual reminder/event add
  can still override its own destination with a trailing channel-id
  argument, exactly like orkus-info already supports.
- `create server` must be run inside the guild the database should be
  scoped to (rejected from a DM), and its primary channel (if not `dm`)
  must belong to that same guild.
- `drop` and `collab add/remove` are owner-or-bot-owner only — a
  collaborator gets full reminder/event rights on a server-kind database
  but can't manage who else has access or delete the database itself.

## Reminders and events

Once a database (Main or otherwise) is resolved, the verbs are identical
everywhere:

```
.a db [<name>] add reminder <YYYY-MM-DDTHH:MM> "<text>" [mentions] [channel-id] [force]
.a db [<name>] add event <start> [end|allday] "<title>" [| <location>] [force]
.a db [<name>] list reminders / events
.a db [<name>] delete reminder <id|all> / event <id>
.a db [<name>] edit reminder <id> <YYYY-MM-DDTHH:MM> "<text>"
.a db [<name>] edit event <id> <start> <end> "<title>" [| <location>]
```

**`"<text>"` / `"<title>"` are quoted** — required, not optional
punctuation. This is the standard for every free-text "name" field in
this repo now (reminders, events, and any future one): wrap it in double
quotes so it can safely contain spaces, commas, emoji, anything, without
being mistaken for a trailing modifier. `common/textParsing.js`'s
`extractQuoted()` re-joins the tokens between the opening and closing
`"` — necessary because bot.js's own message tokenizer has no
quote-awareness at all, splitting purely on whitespace before any of
this code sees it, so a typed `"hello there"` arrives as two separate
tokens (`"hello`, `there"`) that have to be reassembled. Missing quotes
is a usage error, not a silent fallback to the old unquoted behavior.

**`[mentions]`** (reminders only) — a comma-separated list of Discord
user IDs and/or usernames, tagged when the reminder fires (in addition to
its normal DM/channel delivery). Resolved to real user IDs once, at
add-time (fail clearly then, not hours later at fire-time) —
`common/mentions.js`. A username needs SOME guild to search in (Discord
has no global username index): the reminder's own target channel's
guild if one's given, else the database's own guild (informational for
general-user-db, functional for general-server-db), else Main's
command-box channel's guild. No guild context at all means only raw user
IDs work, not usernames. A single bare numeric mention with no comma is
indistinguishable from a channel-id and resolves as one — use a comma
(even for just one entry) or a username to avoid that ambiguity. Only
actually notifies anyone when the reminder posts to a shared channel — a
DM only reaches the original creator, so mentioning someone else there
doesn't ping them at all (Discord's DM channels aren't shared spaces).
Edit doesn't let you change mentions (same as channel destination) —
delete and re-add to change those.

**`| <location>`** is optional on add/edit event — only meaningful for
general-server-db (it's the location Discord's Scheduled Event API
requires; see that feature's own README), ignored everywhere else. Not
quoted (only the title/text fields use the quoting standard above) —
just whatever's left after the pipe, joined back with spaces. Defaults
to the database's own name if omitted on add; left unchanged if omitted
on edit.

**Dates**: 24-hour, Indochina/Bangkok time. Year, month, and the date
itself can each be omitted independently and today's ICT value is
assumed for whichever part is missing — `T19:00` alone means "today at
19:00", `25T14:00` means "the 25th of the current month, this year, at
14:00". Applies identically everywhere this parsing is used (every
database, plus voice-Alani's own reminders/events, which go through the
same `parseIct`).

## Database resolution

`<database>` (a name, not a tier or kind) is optional. Checked in this
order:

1. A reserved top-level verb (`grant`/`revoke`/`create`/`drop`/`collab`/
   `transfer`/`add`/`list`/`delete`/`edit`) is handled directly —
   database names can never collide with these.
2. `main` or `orkus-info` → Main tier.
3. Otherwise, matched by name against databases the caller can currently
   reach. **No match, or no name given at all**: if exactly one database
   is reachable (counting Main only for an owner standing in the
   command-box channel), that one is used automatically; zero or more
   than one always requires being explicit rather than guessing —
   e.g. `Multiple databases accessible: mystuff, teamdb — specify one:
   .a db <name> <verb> ...`.

Database names are **globally unique**, not scoped per-owner — two
different users can't both create one named `"mystuff"`. This is what
makes step 3's by-name lookup unambiguous; `create` enforces it at
creation time.

One deliberate behavior change from this bot's original single-database
design: `.a db` used to reply *only* to owners, staying completely silent
to everyone else in every other channel, since it was owner-only in the
first place. Now that real non-owner users (tier holders) are meant to
discover and use it in any channel, that blanket silence no longer makes
sense — a user with no access anywhere gets a clear "you don't have
access to any database here" instead of nothing. Main tier's own
owner+command-box gate is unchanged either way.

## Discovering databases: `.a list db`

A separate, read-only, publicly-usable command (`listDbCommand.js`, NOT
part of `.a db` itself — deliberately its own top-level command so it
can never collide with `.a db list reminders/events`, which lists
*records inside* an already-resolved database, a different thing
entirely). Content depends on who's asking and where:

- **Bot owner, in the command-box channel (or a DM)**: every database in
  the bot, Main included.
- **Bot owner, in any other guild channel**: just what was created in
  *that* guild — its server-tier database(s), plus any personal database
  that happened to be created while standing in that guild (informational
  only; a personal database isn't actually restricted to where it was
  created, `general-server-db`'s are the only kind that's guild-scoped
  for real).
- **Everyone else, anywhere**: only what they themselves own or
  collaborate on — the same set `.a db` would auto-select from when no
  name is given.

For anyone (any tier, no access required) wanting the full command
reference and an explanation of how the tiers work, see `.a info db` —
`src/features/info/command.js`.

## Audit history

Every tiered database's creation, every tier grant/revoke, every
collaborator add/remove, ownership transfer, and reminder/event creation
gets appended to `store.js`'s `audit_log` table (`who`, `what`, which
database, which channel/guild, when) — never deleted, even after the
database itself is dropped. Not surfaced through any command yet; it
exists as groundwork for the `.a list db` admin view showing history
later, and for possible future cascade-revoking (e.g. tracing which
collaborators a since-removed server-db owner had added). Deliberately
scoped to the two tiered database kinds only — Main/orkus-info stays
completely out of this too, consistent with the rest of this feature's
"don't touch orkus-info" approach. Query it directly via
`store.getAuditLog(databaseId)` if you need to look something up for now.

## Adding a new database kind

1. Build it as its own feature under `src/features/<name>/` — an
   `actions.js` exporting `{ add, list, delete, edit }`, each an
   `async (args: string[], ctx, instance) => string` reply (`instance` is
   the resolved database row from `store.js`, only needed if the new kind
   is a multi-instance one like the two tiered kinds; a fixed
   single-instance database like orkus-info can ignore it entirely, same
   as orkus-info's own handlers do).
2. In `command.js`, import its `actions.js` and call
   `register("<name>", actions)`.
3. If it's a multi-instance kind (most future kinds probably are, given
   the tier system), reuse `src/common/recordActions.js`'s factory for
   the reminder/event CRUD shape rather than writing it from scratch —
   see `general-user-db/actions.js` for the minimal-wrapper pattern, and
   `general-server-db/actions.js` for one with event-mirroring hooks.
4. Wire its tier (if it needs one) into `store.js`'s `grants` table and
   `command.js`'s resolution/verb-handling — this part currently has no
   generic plug-in point, since there have only ever been two tiers to
   support so far.
5. Any free-text "name" field (a title, a label, anything a user types
   that should safely allow spaces/commas/emoji) must use the double-quote
   standard — `common/textParsing.js`'s `extractQuoted()` — rather than a
   bespoke "everything after here, joined" parser. This is the
   established convention for the whole repo now, not just reminders/
   events.

## Setup

Needs `DISCORD_COMMAND_BOX`, `DISCORD_OWNER_0`, and `DISCORD_OWNER_1` in
`.env` (or the host's environment variables) for Main tier — see
`.env.example`. Tier Personal/Server need no additional env vars; they're
entirely commands (`grant`/`create`/etc.), no setup step. A
general-server-db's Discord Scheduled Event mirroring needs the bot to
have the **Manage Events** permission in that guild.
