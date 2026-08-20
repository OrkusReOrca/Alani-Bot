# orkus-info

The default database behind `.a db` (see `src/features/db/`) —
reminders and calendar events for now, more record types (email, etc.)
later. SQLite, via Node's built-in `node:sqlite` (not an npm package —
see `db.js` for why that matters).

## Commands

All go through `.a db` (defaults to this database, so `orkus-info` can be
omitted — see `src/features/db/README.md`):

```
.a db add reminder <YYYY-MM-DDTHH:MM> <text>
.a db add event <start> <end> <title>          (both ISO datetimes)
.a db list reminders
.a db list events
.a db delete reminder <id>
.a db delete event <id>
.a db edit reminder <id> <YYYY-MM-DDTHH:MM> <text>
.a db edit event <id> <start> <end> <title>
```

## Duplicate detection

Before adding a reminder or event, checks for an existing one with the
same normalized text/title within an hour of the same time — if found,
it doesn't add a second one, it tells you and asks you to add `force` at
the end if you really meant to. This is deliberately loose (an hour-wide
window, exact-ish text match) — good enough to catch "did I already ask
for this" re-entry, not meant to be a fuzzy semantic match.

## Overlap detection

Adding an event always succeeds even if it overlaps an existing one — but
the reply tells you what it overlaps with (`start_time < new.end AND
end_time > new.start`, the standard interval-overlap query), since
overlaps are sometimes intentional and shouldn't be silently blocked.

## Storage

`data/orkus-info/orkus-info.db` — lives on the bot's own persistent host
storage, **not** committed to git (see the root `.gitignore`'s `*.db`
entries). Unlike the JSON state files other features in this repo commit
back via their GitHub Actions workflows, this changes on every command and
doesn't benefit from git history — it just needs to survive bot restarts,
which the host's persistent storage already handles.

## Setup

Nothing specific to this database — just needs the persistent bot running
with the access-gate env vars from `src/features/db/README.md`.
