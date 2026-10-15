# alatomy-account

The bot's side of the **Alatomy account DB**: every Alatomy account (log in with Google or Discord on
alatomy.com) has exactly one database holding its reminders, events and trackers. The data and the rules live
on the Alatomy website deployment (repo `Alatomy_Website`, `account/`); the bot is a thin client.

## What it adds

- `.a db alatomy add|list|delete|edit reminder|event ...` — same grammar as the other databases
  (`src/common/recordParsing.js`), so there is no second set of parsers. Also chosen implicitly when it is
  the caller's only database.
- `.a account` — who your Discord is linked to, counts, and how to link when it is not.
- `.a list db` — shows the account DB for linked people.
- A scheduler (every 30 s) that asks the service for due reminders, DMs them (or posts in the chosen
  channel, tagging people), and tells the service they are done. Only accounts with a linked Discord login
  can be delivered to.

## Files

| File | Role |
|---|---|
| `config.js` | env: `ALATOMY_ACCOUNT_API_URL`, `ALATOMY_ACCOUNT_API_SECRET`, `ALATOMY_SITE_URL` |
| `client.js` | HTTP client for the service's `/internal/v1` API (Bearer secret), short lookup cache, clear errors |
| `link.js` | Discord user to linked account, plus the help messages |
| `actions.js` | the add/list/delete/edit verbs (registry kind `alatomy-account-db`) |
| `command.js` | `.a account` |
| `scheduler.js` | reminder delivery |

## Setup

Set `ALATOMY_ACCOUNT_API_URL` (the website address) and `ALATOMY_ACCOUNT_API_SECRET` (the website's
`BOT_API_SECRET`). Unset = feature off, nothing else changes. If the service is down, only this database
reports an error; the other databases keep working.

## Not done yet

`.at` (trackers) does not read the account DB's trackers yet; they are available through the service API only.
The music player is per server and is not stored in account DBs.
