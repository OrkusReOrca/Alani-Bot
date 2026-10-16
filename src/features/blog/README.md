# blog (`.ad blog ...`)

Posting to the **Alatomy blog** (alatomy.com/blog) from Discord. `.ad` is short for "Alani dev". The posts
and their images are stored by the website (repo `Alatomy_Website`, `blog/`), through the Alatomy account
service's internal API, so this needs `ALATOMY_ACCOUNT_API_URL` and `ALATOMY_ACCOUNT_API_SECRET`.

Only in the blog channel (`DISCORD_BLOG_CHANNEL`, default 1560629482182803456).

```
.ad blog create alani.webapp title:"TITLE" by:"WRITER" "TEXT ..."     (attach images to the same message)
.ad blog approve latest yes|no
.ad blog approve name:"TITLE" yes|no
.ad blog delete name:"TITLE"
.ad blog pending
```

- **Who:** bot owners and the `tier1dev` tag publish at once. The `tierPRdev` tag sends the post for approval:
  it is stored as pending and the first owner (`DISCORD_OWNER_0`) is tagged. Approving, rejecting and deleting
  are for owners. Grant the tags with `.a tag add tier1dev <user>` / `.a tag add tierPRdev <user>`.
- **Confirming:** every post (and every delete) is shown and must be confirmed with "yes" first.
- **The text** keeps its line breaks: a blank line starts a new paragraph; https addresses become links.
  title: and by: may come in either order; the text may be in quotes or not.
- **Images:** PNG, JPEG, GIF or WebP attached to the message, up to 10, 8 MB each. They appear at the end of
  the post. Other attachments are left out (the confirmation says so).
- **Sections:** `alani.webapp` for now (the website's `blog/sections.js` lists them; a new one is added there).

| File | Role |
|---|---|
| `command.js` | the `.ad` command: permissions, confirmation, images, the calls to the website |
| `parse.js` | reading the commands from the whole message |
