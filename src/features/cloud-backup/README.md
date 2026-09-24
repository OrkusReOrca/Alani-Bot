# Cloud backup

The bot saves all its databases and settings to a **private Discord channel**,
encrypted, so they survive the bot-hosting deployment being lost. It first
*verifies* that what it's about to save is consistent.

It runs:

- at **00:00, 06:00, 12:00 and 18:00 ICT (GMT+7)**,
- **every time the bot comes online** (so a restart never skips a check), and
- **on demand** with `.a setting cloud push`.

## What's backed up

| Group | Contents |
|---|---|
| `db` ("DB Backup") | `db-core.db` (tiers, `.a db` reminders/events) and `orkus-info.db` (Main) |
| `settings` ("Settings") | `settings.db` |

Each group is versioned independently: a settings change never creates a new
copy of the databases.

## How it's stored, and why it's safe

Each backup *instance* is one message in the backup channel:

```
alani-backup db instance_00007__2026-09-24T00-00-00Z     (+ attached: db-core.db.enc, orkus-info.db.enc)
```

Each file is gzip-compressed, then encrypted with **AES-256-GCM** using
`BACKUP_ENCRYPTION_KEY` (`crypto.js`). Discord only ever holds opaque bytes;
without the key nothing can be read. GCM also authenticates: a corrupted or
edited file — or one moved under a different name — fails to decrypt instead of
returning garbage. Only messages authored by the bot count, so nothing anyone
else posts in the channel is ever trusted.

- A new instance is only made when the change log says something changed —
  never a duplicate of identical data.
- The newest **16** per group are kept; the 17th removes the oldest.
- A faulty snapshot is stored as `FAULTY_<timestamp>` and doesn't count toward
  the 16.

## The change log

Every backed-up database has a `change_log` table filled by SQLite triggers
(`changeLog.js`): each insert/update/delete is recorded with the full row image,
whichever code path made it. The log lives inside the database, so each snapshot
carries its own history.

## The check

Before saving, the live database is compared with the latest stored instance:

1. **Stored copy intact?** It must decrypt. If not → problem `cloud`.
2. **Log continuous?** The live log must still contain the snapshot's log, entry
   for entry → else `log`.
3. **Data explained?** Snapshot plus the log entries written since must equal
   the live data, row for row → else `host`.

All good and nothing changed: nothing saved. All good and changed: a new
instance. Anything else is a **fault**. (A Discord outage is *not* a fault: the
group just reports an error and tries again next time.)

## A fault

1. You're tagged in the status channel (☁️‼️).
2. The host's current copy is stored as `FAULTY_<timestamp>` (nothing is
   overwritten) and kept locally.
3. The host is reset to the newest *intact* stored instance.
4. A report goes to the command box: what didn't add up, and the rows that
   differ (unexplained by the log).
5. That group's backups pause (and re-tag you each pass) until you answer, in the
   command box:
   - `.a setting cloud resume cloud [db|settings]` — keep the stored version;
     the faulty copy is deleted.
   - `.a setting cloud resume host [db|settings]` — keep the host's version:
     it's restored, saved as the new newest instance, and the faulty copy is
     deleted.

Changes made on the host between the fault notice and your answer are lost if you
choose `host` (the host was already reset to the stored version).

A brand-new host with empty databases looks like a fault on its first check —
that's the recovery path: the stored backup is loaded, and you confirm with
`resume cloud`.

## Commands (owner-only)

- `.a setting cloud` — status of each group
- `.a setting cloud push` — **back up now** (verify, and save if anything changed)
- `.a setting cloud resume <cloud|host> [group]` — answer a fault (command box only)

## Setup

1. Create a **private text channel** that only you and Alani can see; copy its ID.
   Alani needs *View Channel*, *Send Messages*, *Attach Files* and *Read Message
   History* there.
2. Generate a key: `npm run backup-key`. **Save it in a password manager.** Losing
   it makes every backup permanently unreadable; generating a new one does too.
3. On the host set `DISCORD_BACKUP_CHANNEL` and `BACKUP_ENCRYPTION_KEY`
   (plus `DISCORD_STATUS_CHANNEL` for the status lines). Restart — the first check
   runs immediately and saves the first backup.

## Layout of the code

| File | Role |
|---|---|
| `changeLog.js` | triggers + log table |
| `snapshot.js` | consistent copy, digest, replay, diff, in-place restore |
| `verify.js` | the log and data checks |
| `crypto.js` | gzip + AES-256-GCM |
| `discordStore.js` | the backup channel as a store (list / put / get / remove) |
| `instances.js` | instance naming and retention |
| `service.js` | the engine (store/notifier/state injected; tested against an in-memory store) |
| `report.js` | the fault report text |
| `state.js` | last-run time + unresolved faults (JSON, deliberately outside the backed-up DBs) |
| `notifier.js`, `groups.js`, `index.js`, `command.js` | real-world wiring |

`npm test` runs the suite (`test/`).

## Known limits

- Discord caps attachments (roughly 10 MB per file on an unboosted server). The
  databases are far smaller, even after years of use.
- The bot's token can delete the backup messages (it can't read them). Keep the
  channel private and the token secret.
- The change log grows with use (a row per write). Entries are small, so it isn't
  pruned; if it ever matters, prune entries older than the oldest retained
  instance's last log id.
- A restore swaps data in place on the live connection; a command that is
  mid-flight at that instant can act on pre-restore data.
