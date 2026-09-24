# Settings

`.a setting` — owner-only (`DISCORD_OWNER_0`/`DISCORD_OWNER_1`) control panel
for the bot's settings. Works in any channel.

```
.a setting                                   overview of every setting
.a setting routine                           routines and whether they're on
.a setting routine <name> <setON|setOFF>     switch one
.a setting cloud [status|push|resume ...]    cloud backup — see ../cloud-backup/README.md
```

## Routines

| Name | What it controls | How "off" is enforced |
|---|---|---|
| `unitracker` | the daily uni-admissions post | `common/dailyJobs.js` skips the job while the routine is off |
| `fortnite` | the Fortnite shop check + post | the two *scheduled* GitHub workflows (`-check.yml`, `-post.yml`) are disabled through the GitHub API; the manual `-refresh.yml`/`-grid.yml` keep working |

Switching `fortnite` needs `GITHUB_ACTIONS_TOKEN` + `GITHUB_REPO` (already
used by `.a fjamtrack refresh`) with Actions read/write. The GitHub call
runs first and the stored setting only changes if it succeeds, so the
setting never claims a state GitHub isn't in.

## Adding a setting

1. Add it to `definitions.js` (default, allowed values, description).
2. Read it with `getSetting(key)` from `store.js`.
3. If it's an on/off routine, add it to `routines.js` and gate its job.

Settings live in their own SQLite file (`data/settings/settings.db`), which is
change-logged and backed up with everything else — see the cloud-backup
README.
