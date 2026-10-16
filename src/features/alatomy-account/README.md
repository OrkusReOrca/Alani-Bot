# alatomy-account

The bot's side of the **Alatomy account DB**: every Alatomy account (log in with Google or Discord on
alatomy.com) has exactly one database holding its reminders, events, trackers, calories and settings. The data and the rules live
on the Alatomy website deployment (repo `Alatomy_Website`, `account/`); the bot is a thin client.

## What it adds

- `.a db alatomy add|list|delete|edit reminder|event ...` — same grammar as the other databases
  (`src/common/recordParsing.js`), so there is no second set of parsers. Also chosen implicitly when it is
  the caller's only database.
- `.a account` — who your Discord is linked to, counts, and how to link when it is not.
- `.a list db` — shows the account DB for linked people.
- A scheduler (every 30 s) that asks the service for due reminders, DMs them (or posts in the chosen
  channel, tagging people), and tells the service they were delivered (they stay listed as delivered on the
  web for a while; `.a db alatomy list reminders` shows only the ones still to come). Tracker reminders
  ("Have you ...?", set in the web app) are sent as one DM per tracker and period, never once the tracker is
  done for that period. Only accounts with a linked Discord login can be delivered to.
- `.a stats` — bot owners only, in the command-box channel (`DISCORD_COMMAND_BOX`) only: registered and
  active accounts and page views of alatomy.com and of Alani on the web. Prefix only (no slash command).

## Files

| File | Role |
|---|---|
| `config.js` | env: `ALATOMY_ACCOUNT_API_URL`, `ALATOMY_ACCOUNT_API_SECRET`, `ALATOMY_SITE_URL` |
| `client.js` | HTTP client for the service's `/internal/v1` API (Bearer secret), short lookup cache, clear errors |
| `link.js` | Discord user to linked account, plus the help messages |
| `actions.js` | the add/list/delete/edit verbs (registry kind `alatomy-account-db`) |
| `command.js` | `.a account` |
| `scheduler.js` | reminder and tracker-reminder delivery |
| `statsCommand.js` | `.a stats` |

## Setup

Set `ALATOMY_ACCOUNT_API_URL` (the website address) and `ALATOMY_ACCOUNT_API_SECRET` (the website's
`BOT_API_SECRET`). Unset = feature off, nothing else changes. If the service is down, only this database
reports an error; the other databases keep working.

## Not done yet

`.at` (Discord's own trackers) does not use the account DB's trackers; those are used in the web app, and
their reminders arrive here by DM.
The music player is per server and is not stored in account DBs.
