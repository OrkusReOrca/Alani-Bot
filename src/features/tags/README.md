# Tags

Tags are capabilities attached to Discord user IDs.

| Tag | Grants |
|---|---|
| `AIallowed` | using `.aii` (the AI assistant) and `.a emo` |
| `SongMaster` | the privileged voice-player commands: `.avc force play` and `.avc removeall` |

Bot owners (`DISCORD_OWNER_0` / `DISCORD_OWNER_1`) hold every tag implicitly and
can't lose it. Only they can change tags:

```
.a tag list                    every tag and what it unlocks
.a tag <TAG> list              who has it (also: .a tag list <TAG>)
.a tag add <TAG> <user>        grant
.a tag remove <TAG> <user>     revoke
```

`<user>` is a user ID, an @mention, or a username (searched in the current
server). Works in any channel or server. Anyone else running the command is told
they have no permission.

Granted tags live in the `user_tags` table of the settings database
(`../settings/store.js`), so they're change-logged and backed up with the settings.

To add a tag: add it to `TAGS` in `store.js`, then check it with
`hasTag(userId, TAGS.<name>)`.
