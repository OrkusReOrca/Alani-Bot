# db

`.a db [<database>] <add|list|delete|edit> [args...]` — admin-level access
to Alani's structured data. Not a database itself — a generic dispatcher
(`registry.js`) that routes to whichever database is named (or
`orkus-info` by default), plus two access gates in `command.js`.

Unlike the other features in this repo, this one isn't a scheduled script
or a public command: it's handled by the persistent bot process
(`src/bot.js`), needs the bot running, and is restricted to two people.

## Access control

Checked in this order — see `command.js`:

1. **Channel** — only responds inside the `DISCORD_COMMAND_BOX` channel
   ("Orkus Info"). Silently ignored everywhere else, same as any
   unrecognized prefix command — it doesn't reply or reveal it exists
   outside that channel.
2. **Owner** — only `DISCORD_OWNER_0` / `DISCORD_OWNER_1` (see
   `src/common/auth.js`). Anyone else gets `Unauthorized user, no
   permission` — at this point they're in the right channel, so they
   should know the command exists but isn't for them.

## Database resolution

`<database>` is optional and defaults to `orkus-info`
(`registry.js`'s `DEFAULT_DATABASE`). If the first argument after `db`
matches a registered database name, it's used instead and the rest of the
args shift over by one:

```
.a db list events                → orkus-info (default), list events
.a db orkus-info list events     → same thing, explicit
.a db email list                 → would route to "email" once that
                                    database exists and registers itself
```

## Adding a new database

1. Build it as its own feature under `src/features/<name>/` (see
   `src/features/orkus-info/` for the pattern: a `db.js` for
   storage/schema, an `actions.js` exporting `{ add, list, delete, edit }`
   — each an `async (args: string[]) => string` reply).
2. In `command.js`, import its `actions.js` and call
   `register("<name>", actions)` alongside the existing
   `register(DEFAULT_DATABASE, orkusInfo)` line.
3. Anyone who's an owner can now reach it via `.a db <name> ...` — no
   changes needed to the access gates or the dispatcher itself.

## Setup

Needs `DISCORD_COMMAND_BOX`, `DISCORD_OWNER_0`, and `DISCORD_OWNER_1` in
`.env` (or the host's environment variables) — see `.env.example`.
