# info

The `/info` slash command — replies with a short introduction plus the
current list of commands and features.

Unlike the other features in this repo, this one isn't a scheduled script:
it's handled by the persistent bot process (`src/bot.js`), which needs to
be running (and the command registered — see the root README's "Persistent
bot" section) for `/info` to respond in Discord.

## Setup

Nothing feature-specific — just needs the persistent bot connected with
`DISCORD_BOT_TOKEN`, and the command registered once via
`npm run deploy-commands` (needs `DISCORD_CLIENT_ID` too).

## Keeping it up to date

`COMMANDS` and `FEATURES` in `command.js` are plain arrays, not generated
from anything — update them by hand when a new slash command or scheduled
feature is added.
