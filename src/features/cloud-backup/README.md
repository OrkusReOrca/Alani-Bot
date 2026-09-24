# Cloud backup

Every 6 hours — 00:00, 06:00, 12:00, 18:00 ICT (GMT+7) — the bot saves all its
databases and settings to Google Drive, and first *verifies* that what it's
about to save is consistent. It also runs once shortly after startup if the
last complete pass is more than 6 hours old (the bot restarts on every deploy).

## What's backed up

| Group | Drive folder | Contents |
|---|---|---|
| `db` | `<root>/DB Backup` | `db-core.db` (tiers, `.a db` reminders/events) and `orkus-info.db` (Main) |
| `settings` | `<root>/Settings` | `settings.db` |

`<root>` is `DRIVE_BACKUP_ROOT_PATH` (default `Alani`). Each group is versioned
independently: a settings change never creates a new copy of the databases.

## Instances

An *instance* is a subfolder `instance_00007__2026-09-24T00-00-00Z` holding a
copy of every database in the group plus `meta.json` (a SHA-256 per file,
uploaded last so a half-finished upload is recognisable and gets cleaned up).

- A new instance is only made when the change log says something changed —
  never a duplicate of identical data.
- The newest **16** are kept; the 17th upload removes the oldest.
- A faulty snapshot is stored beside them as `FAULTY_<timestamp>` and doesn't
  count toward the 16.

## The change log

Every backed-up database has a `change_log` table filled by SQLite triggers
(`changeLog.js`): each insert/update/delete is recorded with the full row
image, whichever code path made it. The log lives inside the database, so each
snapshot carries its own history.

## The check

Before saving, the live database is compared with the latest Drive instance:

1. **Drive copy intact?** Its SHA-256 must match `meta.json`, otherwise the
   problem is tagged `drive`.
2. **Log continuous?** The live log must still contain the snapshot's log,
   entry for entry, otherwise `log`.
3. **Data explained?** Snapshot plus the log entries written since must equal
   the live data, row for row, otherwise `host`.

All good and nothing changed: nothing is uploaded. All good and changed: a new
instance. Anything else is a **fault**.

## A fault

1. You're tagged in the status channel (☁️‼️).
2. The host's current copy is uploaded as `FAULTY_<timestamp>` (nothing is
   overwritten) and kept locally.
3. The host is reset to the newest *intact* Drive instance.
4. A report goes to the command box: what didn't add up, and the rows that
   differ (unexplained by the log).
5. That group's backups pause (and re-tag you each pass) until you answer, in
   the command box:
   - `.a setting cloud resume drive [db|settings]` — keep Drive's version;
     the faulty copy is deleted.
   - `.a setting cloud resume host [db|settings]` — keep the host's version:
     it's restored, saved as the new newest instance, and the faulty copy is
     deleted.

Changes made on the host between the fault notice and your answer are lost if
you choose `host` (the host was already reset to Drive's version).

## Commands

`.a setting cloud` (status) · `.a setting cloud push` (run a pass now) ·
`.a setting cloud resume <drive|host> [group]`.

## Setup (once)

A Google *service account* can't create files in Drive (it has no storage
quota — Drive answers "Service Accounts do not have storage quota"), so the
backup signs in as **you** with OAuth instead:

1. Google Cloud Console, same project as the service account: *APIs &
   Services* → enable the **Google Drive API**.
2. *OAuth consent screen*: user type External, add yourself as a test user,
   then **Publish app** (otherwise the token expires after 7 days; an
   unverified personal app is fine).
3. *Credentials* → **Create credentials → OAuth client ID → Desktop app**.
   Copy the client ID and secret.
4. On your PC, in this repo:
   ```bash
   GOOGLE_OAUTH_CLIENT_ID=<id> GOOGLE_OAUTH_CLIENT_SECRET=<secret> npm run drive-token
   ```
   Open the URL, sign in as the owner of the `Alani` Drive folder, allow
   access. It prints `GOOGLE_OAUTH_REFRESH_TOKEN=...`.
5. On the host set `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`,
   `GOOGLE_OAUTH_REFRESH_TOKEN`, `DISCORD_STATUS_CHANNEL` and, if your folder
   isn't `My Drive/Alani`, `DRIVE_BACKUP_ROOT_PATH`. Restart, then run
   `.a setting cloud push` to make the first backup.

The `DB Backup` and `Settings` folders must already exist under the root.

## Layout of the code

| File | Role |
|---|---|
| `changeLog.js` | triggers + log table |
| `snapshot.js` | consistent copy, digest, replay, diff, in-place restore |
| `verify.js` | the three checks |
| `instances.js` | Drive folder layout, meta, integrity |
| `service.js` | the engine (Drive/notifier/state injected; tested against an in-memory Drive) |
| `report.js` | the fault report text |
| `state.js` | last-run time + unresolved faults (JSON, deliberately outside the backed-up DBs) |
| `notifier.js`, `groups.js`, `index.js`, `command.js` | real-world wiring |

`npm test` runs the suite (`test/`).

## Known limits

- The change log grows with use (a row per write). Entries are small, so it
  isn't pruned; if it ever matters, prune entries older than the oldest
  retained instance's last log id.
- A restore swaps data in place on the live connection; a command that is
  mid-flight at that instant can act on pre-restore data.
