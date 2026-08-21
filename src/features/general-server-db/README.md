# general-server-db

**Tier Server**'s own database kind — see `src/features/db/README.md`'s
"Tiers" section for the full picture. A user an owner has granted Tier
Server to can create exactly one of these, scoped to a single Discord
guild (whichever one the `create` command was run in — rejected from a
DM). Usable by the creator, bot owners, and any collaborators the creator
adds — from any channel, not just that guild.

Same shared-table storage as general-user-db (`src/features/db/store.js`'s
`databases`/`gen_reminders`/`gen_events`, scoped by `database_id`) — see
that feature's own README for the schema shape.

## Getting one

```
.a db grant server <user-id>                 (a bot owner does this)
.a db create server <name> <channel-id|dm>   (must be run inside the target guild)
```

The primary channel, if not `dm`, must belong to that same guild. One per
owner — `.a db drop <name>` an existing one before creating another.

## Collaborators

```
.a db collab add <name> <user-id>
.a db collab remove <name> <user-id>
```

Owner (or bot owner) only. A collaborator gets full reminder/event rights
— same as the owner — but can't manage other collaborators or drop the
database.

## Using it

Same reminder/event commands as everywhere else — see
`src/features/db/README.md`'s "Reminders and events" section for the
exact syntax.

**Events also create a real Discord Scheduled Event** in the owning
guild (create/edit/delete, mirrored via `src/common/discordScheduledEvents.js`,
using `discord.js`'s `guild.scheduledEvents.*` — the bot needs the
**Manage Events** permission in that guild). Best-effort, same treatment
orkus-info gives Google Calendar sync failures: logged, never blocks or
rolls back the local SQLite write that already succeeded.

Discord's Scheduled Event API requires a text **location** for an event
not tied to a voice/stage channel (which these never are) — add it with
a pipe:

```
.a db add event <start> [end|allday] <title> | <location>
.a db edit event <id> <start> <end> <title> | <location>
```

Omitted on add: defaults to the database's own name. Omitted on edit:
stays whatever it already was — editing doesn't reset it back to the
default.

No Google Calendar sync — that stays exclusive to Main tier (orkus-info).

## Revoking

If the **creator's** Tier Server is revoked, the whole database freezes —
collaborators included, not just the creator — fully inaccessible to
anyone but a bot owner. `.a db transfer <name> <new-owner-id>` (bot owner
only) reassigns ownership and un-freezes it; re-granting the original
creator's tier also auto-unfreezes it if nobody's transferred it away in
the meantime.

## Setup

No new env vars — entirely command-driven. Just make sure the bot has
**Manage Events** permission in any guild a Tier-Server user might create
a database in, or event mirroring will silently fail (logged
server-side, local SQLite write still succeeds either way).
