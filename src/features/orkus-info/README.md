# orkus-info

The default database behind `.a db` (see `src/features/db/`) —
reminders and calendar events for now, more record types (email, etc.)
later. SQLite, via Node's built-in `node:sqlite` (not an npm package —
see `db.js` for why that matters).

## Commands

All go through `.a db` (defaults to this database, so `orkus-info` can be
omitted — see `src/features/db/README.md`):

```
.a db add reminder <YYYY-MM-DDTHH:MM> <text> [channel-id] [force]
.a db add event <start> [end|allday] <title>
.a db list reminders
.a db list events
.a db delete reminder <id|all>
.a db delete event <id>
.a db edit reminder <id> <YYYY-MM-DDTHH:MM> <text>
.a db edit event <id> <start> <end> <title>
```

**All times are 24-hour, Indochina/Bangkok time (ICT, UTC+7)** —
`format.js`'s `parseIct`/`fmtIct`, explicitly, regardless of what
timezone the host server itself happens to be running in (see `format.js`
for why that distinction matters — it's a real bug that shipped once).

**Partial dates**: the year and/or month can be left off any date given
to `add`/`edit` for either reminders or events — `parseIct` assumes the
current ICT year if omitted, and the current ICT month if the month's
also omitted (e.g. `25T14:00` on 2026-08-20 means 2026-08-25 14:00).
Applies identically to chat commands and voice.

**Events' end is optional**: `.a db add event <start> <title>` (no end)
defaults to a 1-hour event. Use `allday` in place of an end time/date for
an all-day event instead (`.a db add event 2026-08-25 allday <title>`) —
the second token is tried as a date first, then as the `allday` keyword,
and only falls through to being folded into the title if neither
matches. Voice has the same defaults via an explicit `all_day` flag
instead of guessing from a keyword (see the root README's "Voice bridge"
section).

## Reminder numbering

The `<id>` reminders are added/listed/edited/deleted by is **not** the
real database primary key — it's a small, reused `display_number` (see
`db.js`'s `getNextDisplayNumber()`). The real `id` (permanent, never
reused, used internally by the scheduler) would otherwise climb forever
as reminders fire and get deleted, eventually reaching awkward numbers
like #247 for someone's 5th active reminder.

`display_number` is always the smallest positive integer not currently
in use by an active reminder — so with a small number of reminders
active at once, numbers stay packed low and get recycled as soon as one
frees up (delete #2, the next add becomes #2 again, not #6). It only
grows past a round number once that many are genuinely active
simultaneously (e.g. past 20 only once all of 1-20 are truly in use at
the same time), and naturally drops back down as things get deleted — no
separate "current range" state to track, this behavior falls straight
out of "always take the smallest free number."

`.a db delete reminder all` clears every active reminder at once.

## Reminders: delivery

When a reminder's time arrives (checked every 30s — `scheduler.js`), it
sends and is removed from the database (one-shot, not recurring):

- **No channel given**: DMs the person who set it —
  `🚨 REMINDER: *text* at HH:MM YYYY/MM/DD`
- **Channel given** (trailing arg on `add reminder`, a plain channel ID):
  posts there instead —
  `🚨 REMINDER: *text* at HH:MM YYYY/MM/DD by *username*`

Giving a channel is checked **at add time**, not fire time — if Alani
can't post there (wrong ID, no permission), the add is rejected outright
with a "try again" message rather than silently failing hours later when
the reminder was actually due. Delivery itself is best-effort: a fire
that fails anyway (DM closed, channel deleted since) is logged
server-side and the reminder is still removed rather than retried forever.

Reminders can also come in from voice-Alani (see the root README's
"Voice bridge" section) — those always DM `DISCORD_OWNER_0` (no channel
option there) and get an extra "... by voice" announcement posted in the
command-box channel when added, on top of the normal delivery above.

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

## Google Calendar sync

Every event add/edit/delete also mirrors to a real Google Calendar —
one-way (this database stays the source of truth; changes made directly
in Google Calendar don't sync back), best-effort (a Google API failure
is logged server-side and never blocks the local write, which already
succeeded by the time the sync is attempted).

**How it's wired**: a single shared Google service account
(`GOOGLE_SERVICE_ACCOUNT_KEY`, bot-wide — see `src/common/googleCalendar.js`)
authenticates to whichever calendar this database is configured with
(`ORKUS_INFO_GOOGLE_CALENDAR_ID`, this database's own `config.js` — kept
separate on purpose, so a future database can get its own calendar via
its own `<NAME>_GOOGLE_CALENDAR_ID` env var, reusing the same service
account). The matching Google-side event ID is stored on the local row
(`events.google_event_id`) so later edits/deletes touch the right
Google Calendar event too, not just create new ones.

**Setup** (one-time, needs your Google account — can't be done from this
repo alone):
1. [console.cloud.google.com](https://console.cloud.google.com) -> new
   project -> **APIs & Services -> Library** -> enable "Google Calendar API".
2. **APIs & Services -> Credentials -> Create Credentials -> Service
   Account** -> then that account's **Keys -> Add Key -> JSON** ->
   downloads a key file. Its `client_email` field is the service
   account's own address (looks like
   `name@project-id.iam.gserviceaccount.com`).
3. In your own Google Calendar -> Settings -> "Create new calendar" ->
   name it whatever you like (e.g. "Alani").
4. That calendar's settings -> "Share with specific people" -> add the
   service account's email from step 2 -> permission **"Make changes to
   events."**
5. Same settings page -> "Integrate calendar" -> copy the **Calendar ID**.
6. Set `GOOGLE_SERVICE_ACCOUNT_KEY` (the whole JSON file's contents) and
   `ORKUS_INFO_GOOGLE_CALENDAR_ID` (from step 5) as env vars here.

Deliberately **not** the other direction (a calendar the service account
owns, shared out to you) — this way the calendar lives in your own
Google Calendar from the start, so renaming/deleting/revoking access
later is normal Google Calendar UI, not something requiring Cloud
Console again.

## Storage

`data/orkus-info/orkus-info.db` — lives on the bot's own persistent host
storage, **not** committed to git (see the root `.gitignore`'s `*.db`
entries). Unlike the JSON state files other features in this repo commit
back via their GitHub Actions workflows, this changes on every command and
doesn't benefit from git history — it just needs to survive bot restarts,
which the host's persistent storage already handles.

## Setup

Nothing specific to this database — just needs the persistent bot running
with the access-gate env vars from `src/features/db/README.md`. Reminder
delivery additionally needs the bot to actually be online for the DM/
channel send to go through, same as any other message it sends.
