// Reading the blog commands from the whole message (not the whitespace-split words: a post keeps its line
// breaks and blank lines).
//
//   .ad blog create <product.section> title:"TITLE" by:"WRITER" "TEXT ..."
//   .ad blog approve latest yes|no
//   .ad blog approve name:"TITLE" yes|no
//   .ad blog delete name:"TITLE"
//   .ad blog pending

export const CREATE_USAGE = 'Usage: `.ad blog create <section> title:"TITLE" by:"WRITER" "TEXT"` (e.g. section `alani.webapp`). Attach images to the same message to add them at the end of the post.';
export const APPROVE_USAGE = 'Usage: `.ad blog approve latest yes|no` or `.ad blog approve name:"TITLE" yes|no`';
export const DELETE_USAGE = 'Usage: `.ad blog delete name:"TITLE"`';

/** The message after ".ad blog <verb>" (the verb's own words removed), or null if it is not that verb. */
export function afterVerb(content, verb) {
  const match = new RegExp(`^\\s*\\.ad\\s+blog\\s+${verb}\\b`, "i").exec(content ?? "");
  return match ? content.slice(match[0].length) : null;
}

const takeField = (text, name) => {
  const match = new RegExp(`^\\s*${name}:"([^"]*)"`, "i").exec(text);
  return match ? { value: match[1].trim(), rest: text.slice(match[0].length) } : null;
};

/** { section, title, author, body } or { usage }. title: and by: may come in either order. */
export function parseCreate(content) {
  let text = afterVerb(content, "create");
  if (text === null) return { usage: CREATE_USAGE };
  const section = /^\s*([a-z0-9]+\.[a-z0-9]+)\b/i.exec(text);
  if (!section) return { usage: CREATE_USAGE };
  text = text.slice(section[0].length);
  const fields = {};
  for (let i = 0; i < 2; i++) {
    const title = takeField(text, "title");
    const by = takeField(text, "by");
    if (title && !fields.title) (fields.title = title.value), (text = title.rest);
    else if (by && !fields.author) (fields.author = by.value), (text = by.rest);
  }
  let body = text.trim();
  if (body.length >= 2 && body.startsWith('"') && body.endsWith('"')) body = body.slice(1, -1).trim();
  if (!fields.title || !fields.author || !body) return { usage: CREATE_USAGE };
  return { section: section[1].toLowerCase(), title: fields.title, author: fields.author, body };
}

/** { which: "latest" } or { title }, with approve: true|false — or { usage }. */
export function parseApprove(content) {
  const text = afterVerb(content, "approve");
  if (text === null) return { usage: APPROVE_USAGE };
  const latest = /^\s*latest\s+(yes|no)\s*$/i.exec(text);
  if (latest) return { which: "latest", approve: latest[1].toLowerCase() === "yes" };
  const named = /^\s*name:"([^"]+)"\s+(yes|no)\s*$/i.exec(text);
  if (named) return { title: named[1].trim(), approve: named[2].toLowerCase() === "yes" };
  return { usage: APPROVE_USAGE };
}

/** { title } or { usage }. */
export function parseDelete(content) {
  const text = afterVerb(content, "delete");
  const named = text === null ? null : /^\s*name:"([^"]+)"\s*$/i.exec(text);
  return named ? { title: named[1].trim() } : { usage: DELETE_USAGE };
}
