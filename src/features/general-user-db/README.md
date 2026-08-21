# general-user-db

**Tier Personal**'s own database kind — see `src/features/db/README.md`'s
"Tiers" section for the full picture. A user an owner has granted Tier
Personal to can create exactly one of these, private to them (plus bot
owners), usable from any channel — not the command-box restriction Main
tier (orkus-info) has.

Unlike orkus-info, this isn't a single fixed database — many people can
each have their own instance. `src/features/db/store.js` holds the
metadata (who owns which instance, its name, its primary channel) in a
`databases` table; the actual reminders/events live in shared
`gen_reminders`/`gen_events` tables scoped by a `database_id` column, not
a separate SQLite file per user.

## Getting one

```
.a db grant personal <user-id>              (a bot owner does this)
.a db create personal <name> <channel-id|dm>
```

Any channel, for both. `create` needs the grant first, and each user can
own only one — `.a db drop <name>` an existing one before creating
another.

## Using it

Same reminder/event commands orkus-info has — see
`src/features/db/README.md`'s "Reminders and events" section for the
exact syntax. No Google Calendar sync, no Discord Scheduled Event — this
is SQLite only. The `location`/`| ` syntax on add/edit event is accepted
but has no effect here (it only matters for general-server-db).

`<name>` in `.a db <name> ...` can be omitted once you have exactly one
accessible database — the common case for a Tier Personal user with just
their own.

## Revoking

If a bot owner revokes your Tier Personal, your database freezes (not
deleted) — fully inaccessible to you or anyone but a bot owner until
either the tier is re-granted (auto-unfreezes it) or a bot owner runs
`.a db transfer` to reassign it.

## Setup

No new env vars — entirely command-driven (`grant`, `create`, etc.).
