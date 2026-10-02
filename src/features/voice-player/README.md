# Voice player (`.avc`)

Alani joins your voice call and plays audio files from a Google Drive folder
(`Alani/Files to play discord VC`; change it with `VC_DRIVE_FOLDER_PATH`). Audio
only — a bot can't share video, so a video file plays just its sound.

```
.avc join                          join your voice channel (resumes the saved queue)
.avc play FILE NAME                add a file to the END of the queue
.avc force play FILE NAME          SongMaster: play it NEXT and skip the current track
.avc pause                         pause (run again to resume)
.avc skip
.avc queue                         the queue, with each track's length
.avc queue loop on|off
.avc queue shuffle on|off          shuffle on also means looping
.avc remove FILE NAME              take a track out of the queue
.avc removeall                     SongMaster: clear the queue
.avc status                        in a call? what's playing? loop/shuffle
.avc leave                         leave the call (the queue is kept)
```

Also works in plain language through `.aii` ("play the rain sounds in my call").

## Who can do what

- **Viewing** (`queue`, `status`): anyone in the server.
- **Everything else**: you must be in the voice channel the bot is in.
  `play` and `join` also work when the bot isn't in a call yet — it joins yours.
  If it's busy with people in another channel it tells you to join that one.
- **`force play`, `removeall`**: need the **SongMaster** tag (`.a tag add SongMaster <user>`,
  owners only; bot owners hold it automatically).
- Server-only: it does nothing in DMs.

## File names

`FILE NAME` is matched forgivingly: case and the extension are ignored, and part of
a name works if it identifies exactly one file. If several match, the bot lists them
and asks you to be more specific. Sub-folders aren't searched. Anything Drive calls
audio/video (or with a known audio/video extension) is playable.

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
- "Now playing" messages go to the text channel of the latest command. The **PlayCall**
  setting (`.a setting playcall on|off`, default on) turns them off; failures and
  "left the call" notices still post.

Queue, loop and shuffle are saved **per server** in one database, `VoiceState.db`
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
