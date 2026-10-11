# Trackers (`.at`)

Blood-pressure, pill and activity trackers with scheduled reminders. Needs the
**Tracker** tag (bot owners hold every tag). In a DM with Alani the prefix can
be dropped: `t bp list` = `.at bp list` = `.a at bp list`.

## Model

```
Tracker
├─ Health tracker   → Bloodpressure tracker, Pill tracker
└─ Routine tracker  → Activity tracker
```

- A tracker belongs to **one user** (`me`, the default) or **one server**
  (`server`). A server's logs are visible only to whoever created its trackers,
  bot owners and users given `permission grant`.
- `Bloodpressure tracker` and `Pill tracker`: one per owner. `Activity tracker`:
  many, each with a `name:"..."`.
- Everything lives in ONE database, `data/tracker/Tracker.db`
  (`trackers`, `tracker_settings`, `tracker_permissions`, `bp_logs`, `pills`,
  `pill_logs`), change-logged and saved by the cloud backup as the `tracker`
  group.
- Reminder runtime state (what already fired, pending pill prompts) is kept in
  `data/tracker/reminder-state.json` and is not backed up.

## Commands

| Command | What it does |
| --- | --- |
| `.at create type:"Bloodpressure tracker" [me\|server]` | create (also `Pill tracker`, or `Activity tracker` + `name:"..."`) |
| `.at enable\|disable "NAME" [me\|server]` | reminders on/off (a disabled tracker also blocks logging; data is kept) |
| `.at permission grant\|revoke USER [me\|server]` | let someone use all of the owner's trackers |
| `.at setting "NAME" recuring:... at:T21:00 to:"text" tz:GMT+7 tag:a,b sent:dm\|CHANNEL_ID` | reminder schedule and delivery |
| `.at logadd bp 120 80` (`la`) | log a reading now (30–300) |
| `.at logadd pill bpl,fl y` (`la p`) | log pills taken (`y`) or not (`n`) |
| `.at bp list\|export RANGE\|delete RANGE` | blood-pressure logs |
| `.at pill addpill "Full name"/"alias" recuring:daily at:T21:00` | add a pill with its own schedule |
| `.at pill removepill\|pills\|list\|export\|delete` | pill management and logs |
| `.at list` | your trackers (and this server's) |
| `.at help` | every command with how to use it (no tag needed to read) |
| `.at type list` | the tracker types and how to use each |

Put `server` right after `.at` (`.at server bp list`) for the server's tracker,
or a user ID/@mention to use a tracker whose owner granted you permission.

**Ranges**: `all`, `latest14`, `oldest5`, `2026/10/1`, `2026/10/1-2026/11/13`.
Exports are text files, oldest → newest.

**Schedules** (`recuring:` is accepted as well as `recurring:`): `daily`;
`weekly` + weekday names; `monthly` + day numbers or `last` (days past a
month's end clamp to its last day); `yearly` with `at:MONTH,DAY,Thh:mm`. Times
are 24-hour in `tz` (default GMT+7).

## Reminders

`reminders.js` ticks every 30 s. A reminder is sent at its time (at most 10
minutes late, so downtime doesn't replay old ones) by DM or into a channel,
mentioning the `tag:` users. Blood-pressure and pill reminders are skipped when
that day's reading / dose is already logged. A pill reminder DM can be answered
with a plain `y` / `n` (`pillReply.js`, valid for 12 h).

## Files

| File | Purpose |
| --- | --- |
| `command.js` | the `.at` command (`createExecute(deps)`) |
| `help.js` | the text of `.at help`, `.at type list` and `.a info at` |
| `types.js`, `parse.js`, `schedule.js`, `format.js` | pure helpers |
| `storeFactory.js`, `store.js` | Tracker.db access |
| `reminders.js`, `reminderState.js`, `pillReply.js` | reminder engine |
| `runtime.js`, `index.js` | real wiring and registration |
