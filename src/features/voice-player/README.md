# Voice player (`.avc`)

Alani joins your voice call and plays audio files from a Google Drive folder
(`Alani/Files to play discord VC`; change it with `VC_DRIVE_FOLDER_PATH`). Audio
only — a bot can't share video, so a video file plays just its sound.

```
.avc join                          join your voice channel (resumes the saved queue)
.avc play FILE NAME                add a file to the END of the queue
.avc play "NAME A" "NAME B"        add several at once (each full name in quotes)
.avc force play FILE NAME          SongMaster: play it NEXT and skip the current track
.avc pause                         pause (run again to resume)
.avc skip
.avc list [a|d|m]                  every playable file, in pages (a = A–Z, d = newest first, m = by media)
.avc queue                         the queue, with each track's length
.avc queue loop on|off
.avc queue shuffle on|off          shuffle on also means looping
.avc queue playcall on|off         "Now playing" messages on/off
.avc queue persistent on|off       never leave the call by itself
.avc remove FILE NAME              take a track out of the queue
.avc removeall                     SongMaster: clear the queue
.avc status                        in a call? what's playing? loop/shuffle
.avc leave                         leave the call (the queue is kept)
```

## Short forms

Every subcommand has a short form (the long names always work):

| Long | Short | | Long | Short |
|---|---|---|---|---|
| `join` | `j` | | `removeall` | `rma` |
| `play` | `p` | | `status` | `st` |
| `force play` | `fp` or `f p` | | `leave` | `lv` |
| `pause` | `pa` | | `queue loop` | `q lp` |
| `skip` | `sk` | | `queue shuffle` | `q sh` |
| `queue` | `q` | | `queue playcall` | `q pc` |
| `list` | `l` or `ls` | | `queue persistent` | `q ps` |
| `remove` | `rm` | | | |

e.g. `.avc p the brave`, `.avc q lp on`, `.avc sk`, `.avc l d`.

Also works in plain language through `.aii` ("play the rain sounds in my call"). `.aii`
reads the whole file list (full names) when it runs `.avc list`, so "add all songs by robin
to the queue" lists the files, then queues every match.

## Who can do what

- **Viewing** (`queue`, `status`): anyone in the server.
- **Everything else**: you must be in the voice channel the bot is in.
  `play` and `join` also work when the bot isn't in a call yet — it joins yours.
  If it's busy with people in another channel it tells you to join that one.
- **`force play`, `removeall`**: need the **SongMaster** tag (`.a tag add SongMaster <user>`,
  owners only; bot owners hold it automatically).
- Server-only: it does nothing in DMs.

## Browsing the files

`.avc list` (or `.avc list a`) shows every playable file alphabetically; `.avc list d`
shows the newest uploads first (with their date, GMT+7). It's a box list of 15 files
per page, numbered across pages, with **⬅️ ➡️** buttons and a "Page 1 / N" footer, like
a Mudae list. Long names are cut at 40 characters. Only the person who asked can turn
the pages, and the buttons go away after 2 idle minutes. Open to anyone in the server.

### Grouped by media — `.avc list m`

Name your files `ARTIST-Song name` or `ARTIST-GAME/MEDIA-Song name`, for example
`Hoyomix-Genshin-Ronova Boss Fight Theme.mp4` or `Miku-Monitoring (Best Friend Remix).m4a`.
`.avc list m` groups the files by the media part: each media is a **column** (3 per row, up to 3
rows per page), media sorted alphabetically, songs inside each one sorted by artist then title,
shown as `Artist - Song`. **Others** comes last and holds names with no media part plus any media
that has only one song (those are shown by their full name). Only the first two dashes split the
name, so a song title may contain dashes. Media names match case-insensitively. A big group
continues in a second column ("Genshin (2)"). Same ⬅️ ➡️ buttons and page footer as the other views.

## File names

`FILE NAME` is matched forgivingly: case and the extension are ignored, and part of
a name works if it identifies exactly one file. If several match, the bot lists them
and asks you to be more specific. Sub-folders aren't searched. Anything Drive calls
audio/video (or with a known audio/video extension) is playable.

## Adding several songs at once

`.avc play "Song A.mp3" "Song B.mp3" "Song C.mp3"` queues them in that order (quotes
required; spaces between the quoted names are optional; up to 40 per command). Each
name is matched like a single name (ignoring case/extension); files that aren't found,
or match several files, are reported and skipped while the rest are added. It's meant
for `.aii` ("add all songs by robin") but works for anyone. `force play` takes one file.

## The queue

`queue[0]` is always the current track — the one playing, or the next to play.

- `play` adds to the end. `force play` puts the file next and cuts the current track short.
- A track that finishes is **removed**, unless looping: then it goes to the back.
- **Shuffle** picks the next track at random and implies looping, but the two
  settings are stored separately (`status` shows "Loop: on (because shuffle is on)").
- `remove` on the playing track stops it and moves on; it isn't looped back.
- A track that can't be played is announced and dropped, and the next one starts.
- **Leaving and rejoining resumes the queue as it was** (from the start of the first
  track). The same after a bot restart.
- The bot leaves by itself after 5 minutes with nothing playing, or 1 minute after
  everyone else has left the call. The queue is kept either way.
- **Persistent** (`.avc queue persistent on|off`, default off, per server, **bot owners
  only** — not even SongMaster): when on, the
  bot stays in the call whatever happens — empty queue, everyone else gone — instead of
  leaving after 5 min idle / 1 min alone. It stays until you `.avc leave` it. It does NOT
  survive a bot restart or redeploy (the connection drops and is not re-opened
  automatically; `.avc join` brings it back). Turning it off re-applies the normal
  auto-leave rules immediately.
- "Now playing" messages go to the text channel of the latest command. **PlayCall**
  (`.avc queue playcall on|off`, default on, per server like loop and shuffle) turns
  them off; failures and "left the call" notices still post.

Queue, loop, shuffle, PlayCall and Persistent are saved **per server** in one database, `VoiceState.db`
(a server gets its row the first time a voice command is used there). It is
change-logged and backed up as its own group, `voice` — see `../cloud-backup/README.md`.

## How audio is handled (a 1-hour file included)

Each file is converted **once** to compact Opus audio (96 kbps ≈ 43 MB per hour of
sound; video keeps only its audio) and cached on disk (`audioCache.js`). Discord
plays that natively, so playback costs almost no CPU.

- A track **starts playing while it is still being converted**: the player reads the
  growing file, so a long file starts within seconds, not after a full download.
- Everything in a queue is converted in order in the background, which is also how
  the queue learns each track's length (shown once it's converted).
- Replays come straight from the cache — no Drive traffic.
- The cache is capped at **2 GB**. Tracks in a queue are never evicted; beyond the
  cap the least-recently-played other tracks go first. A file changed in Drive is
  reconverted (the cache key includes its modified time).
- Formats that can be streamed (mp3, wav, flac, ogg, opus, webm…) are piped from
  Drive straight into ffmpeg. Containers that need seeking (m4a, mp4, mov) are
  downloaded to a temp file first; a piped conversion that fails is retried that way.

## Setup

- The Drive folder must be shared with the bot's service account (it is, if it's
  inside the `Alani` folder). Only read access is used.
- Voice needs `@discordjs/voice`, `opusscript`, `libsodium-wrappers`, `@snazzah/davey`
  and `@ffmpeg-installer/ffmpeg`. They're optional dependencies: if one fails to
  install, only voice playback is lost. The bot's `GuildVoiceStates` intent is on.

## Files

| File | Role |
|---|---|
| `command.js` | the `.avc` subcommands and who may use them |
| `session.js` | one server's player: join/leave, queue changes, track end, timers (all dependencies injected; tested with fakes) |
| `queue.js` | the queue rules as pure functions |
| `match.js` | forgiving name matching |
| `format.js` | queue / status text |
| `audioCache.js` | convert-once Opus cache, play-while-converting, eviction |
| `library.js` | listing the Drive folder |
| `stateStore.js` | `VoiceState.db` |
| `discordOutput.js`, `manager.js` | the real Discord voice connection and wiring |
| `config.js` | folder path, cache size, timeouts |
