# info

Replies with a short introduction plus the current list of commands and
features. Works two ways: the `/info` slash command, or `.a info` typed as
a plain message in any channel Alani can see.

**`.a info db`** (prefix only — a two-word freeform subcommand doesn't
map onto a slash option cleanly, same reasoning as `.a fjamtrack shop`
staying prefix-only) replies with a full, standalone explanation of the
`.a db` tier system and every command in it — see
`src/features/db/README.md` for the source of truth this is a condensed
version of. Public, usable by anyone, anywhere; unlike the rest of
`.a info`'s content this doesn't get filtered by private-server-awareness
at all, since the tier system is meant to be discoverable by any regular
user who might get granted a tier.

**Private-server-aware:** entries marked `private: true` in `command.js`
(currently uni-application-updater and orkus-info's own `FEATURES` entry
— `.a db` itself is public now, since Tier Personal/Server make it a
real command for regular users, not just bot owners) only show up when
run inside Alani's own private server (`PRIVATE_SERVER_ID` in
`command.js`) — everywhere else (other servers, DMs), only the public
entries show, so `/info` doesn't advertise features that aren't meant for
wherever it's being run.

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

`COMMANDS` and `FEATURES` in `command.js` are plain arrays of `{ text,
private }`, not generated from anything — update them by hand when a new
slash command or scheduled feature is added, and set `private: true` if
it shouldn't be advertised outside Alani's own private server.
