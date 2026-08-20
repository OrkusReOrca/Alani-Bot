# info

Replies with a short introduction plus the current list of commands and
features. Works two ways: the `/info` slash command, or `.a info` typed as
a plain message in any channel Alani can see.

Unlike the other features in this repo, this one isn't a scheduled script:
it's handled by the persistent bot process (`src/bot.js`), which needs to
be running (and the slash command registered — see the root README's
"Persistent bot" section) for either form to respond in Discord.

## Setup

Nothing feature-specific — just needs the persistent bot connected with
`DISCORD_BOT_TOKEN`. The slash-command form additionally needs
`npm run deploy-commands` run once (needs `DISCORD_CLIENT_ID` too); the
prefix form (`.a info`) needs no registration, just the bot running with
the Message Content privileged intent enabled — see root README.

## Keeping it up to date

`COMMANDS` and `FEATURES` in `command.js` are plain arrays, not generated
from anything — update them by hand when a new slash command or scheduled
feature is added.
