# AI assistant (`.aii`)

`.aii <request in plain language>` — an LLM turns the request into Alani
commands, runs them **as you**, and shows what it ran. Works in any channel,
any server, and DMs. Needs the **AIallowed** tag (bot owners always have it;
only they can grant it — see `../tags/README.md`). Without it the bot says you
don't have permission.

```
.aii add a reminder in kk server db for when the new version of fortnite drops, tag me and @KK
→ Ran `.a db KKserver add reminder 2026-10-03T10:55 "NEW fortnite version is here: Fortnitemares 🎃" higgorca,kk 950734654128926753`
→ Added reminder #1: "NEW fortnite version is here: ..." at 10:55 2026/10/03 (will post in #text-chat, will also tag @Higgorca @kk)

.aii run the one latest video on emotion prediction, more info, use AU T and VO, but cache all of them
→ Ran `.a emo run1 mAU.T.VO d mif`
```

## How a request is handled

1. Permission: no AIallowed tag → refused before any model call.
2. A system prompt is built (`prompt.js`) from: the rules, **every registered
   command's `aiGuide`**, and this request's context — the current time (UTC+7,
   24h), who's asking, where, the users/channels mentioned in the message, and the
   databases the caller can use.
3. The model (`llm.js`, OpenRouter, default `anthropic/claude-haiku-4.5`) may call
   `run_command` and/or OpenRouter's `web_search` (only when it decides it needs
   current information; ~$0.007 per search, at most 2 per request).
4. Each `run_command` is parsed like a typed command and executed with the
   **caller's own identity, channel and server** (`assistant.js`). The bot prints
   ``Ran `<command>` `` and then the command's own reply. Permissions and channel
   restrictions are enforced by the command itself, exactly as if the user typed
   it, and a refusal comes back to the model, which explains it in plain words.
5. Up to 6 model rounds per request. Plain text from the model (an answer, a
   question, an explanation of a failure) is posted; if it just ran commands
   successfully it stays quiet.

Safety:
- **Destructive commands** (a command's `isDestructive(args)`: delete/drop/revoke/
  transfer, tag removal, answering a backup fault) wait for you to reply `yes`
  within 60 s; otherwise they're not run.
- The model can only run commands in the registry (`.a ...` and `.avc ...`, never
  `.aii` itself) and one line at a time.
- Only user mentions can ping; the model's free text can never `@everyone` or tag a role.
- Search results and command output are treated as data, not instructions.
- One request per user at a time.

## Memory

Each user's last 10 requests from the past hour are included as context, so
"make it 11:00 instead" works. Nothing older is used.

## History — `AIcommandHistory`

Every request is saved in its own database, `data/ai-history/AIcommandHistory.db`
(`history.js`): `ai_calls` (who, where, what they said, the final answer, model,
token counts) and `ai_events` (each command run, its reply, declined
confirmations). Long replies are clipped to 4,000 characters. It's change-logged
and backed up as its own group (`ai-history`) — see `../cloud-backup/README.md`.

## Adding a command (this applies to every future command)

A command module must export `aiGuide` — plain text describing its syntax and
behavior — and may export `isDestructive(args)`. Register it in `src/commands.js`.
That's all: `.aii` learns it from its `aiGuide` the next time it starts, and
`npm test` fails if a registered command has no `aiGuide`.

## Setup

- `OPENROUTER_API_KEY` on the Alani Discord slot (same key as the emotion service
  is fine).
- Optional `AI_MODEL` (default `anthropic/claude-haiku-4.5`).
- Grant people access with `.a tag add AIallowed <user>`.

## Files

| File | Role |
|---|---|
| `handler.js` | Discord side: permission, context, confirmations, per-user lock |
| `assistant.js` | the loop (all dependencies injected; tested with fakes) |
| `prompt.js` | system prompt + request context |
| `llm.js` | OpenRouter client and the tools offered |
| `history.js` | AIcommandHistory database + memory |
| `config.js` | env vars and limits |
