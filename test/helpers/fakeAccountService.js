// A small in-memory stand-in for the Alatomy account service's /internal/v1 API (the real one lives in the
// Alatomy_Website repo and has its own tests). It keeps the same request/response shapes, so the bot's client
// and `.a db alatomy ...` can be tested end to end here.

import http from "node:http";

export const SECRET = "test-secret";
export const LINKED_DISCORD_ID = "111111111111111111";
export const ACCOUNT_ID = "a".repeat(32);

const norm = (text) => text.trim().toLowerCase().replace(/\s+/g, " ");
const HOUR = 3600_000;

export async function startFakeAccountService() {
  const state = {
    reminders: [],
    events: [],
    due: [],
    delivered: [],
    calls: [],
    failWith: null, // a status code to answer everything with
    linked: new Set([LINKED_DISCORD_ID]),
  };

  const view = (r) => ({ displayNumber: r.n, text: r.text, remindAt: r.remindAt, channelId: r.channelId, mentions: r.mentions, delivery: "discord", createdVia: "discord" });
  const eventView = (e) => ({ displayNumber: e.n, title: e.title, start: e.start, end: e.end, allDay: e.allDay, location: e.location, createdVia: "discord" });
  const next = (list) => list.reduce((m, x) => Math.max(m, x.n), 0) + 1;

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const send = (status, body) => {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(body));
      };
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
      const url = new URL(req.url, "http://x");
      state.calls.push(`${req.method} ${url.pathname}${url.search}`);
      if (req.headers.authorization !== `Bearer ${SECRET}`) return send(401, { error: "Unauthorized" });
      if (state.failWith) return send(state.failWith, { error: "boom" });
      const parts = url.pathname.replace("/internal/v1/", "").split("/");

      if (parts[0] === "lookup") {
        return send(200, state.linked.has(body.providerUserId)
          ? { found: true, account: { id: ACCOUNT_ID, username: "ada", displayName: "Ada L", timezone: "Asia/Bangkok" }, db: { name: "alatomy", reminders: state.reminders.length, events: state.events.length, trackers: 0 } }
          : { found: false });
      }
      if (parts[0] === "reminders" && parts[1] === "due") return send(200, { reminders: state.due });
      if (parts[0] === "reminders" && parts[2] === "done") {
        state.delivered.push(parts[1]);
        return send(200, { ok: true });
      }
      if (parts[0] !== "accounts" || parts[2] !== "db") return send(404, { error: "no route" });
      const [, , , collection, id] = parts;

      if (collection === "reminders") {
        if (!id && req.method === "GET") return send(200, { reminders: [...state.reminders].sort((a, b) => a.remindAt.localeCompare(b.remindAt)).map(view) });
        if (!id && req.method === "POST") {
          const dupe = state.reminders.find((r) => norm(r.text) === norm(body.text) && Math.abs(Date.parse(r.remindAt) - Date.parse(body.remindAt)) <= HOUR);
          if (dupe && !body.force) return send(409, { error: "A similar reminder already exists.", code: "duplicate", duplicate: view(dupe) });
          const r = { n: next(state.reminders), text: body.text, remindAt: new Date(body.remindAt).toISOString(), channelId: body.channelId ?? null, mentions: body.mentions ?? [] };
          state.reminders.push(r);
          return send(201, { reminder: view(r) });
        }
        if (!id && req.method === "DELETE") {
          const deleted = state.reminders.length;
          state.reminders = [];
          return send(200, { deleted });
        }
        const r = state.reminders.find((x) => String(x.n) === id);
        if (!r) return send(404, { error: `No reminder #${id}.`, code: "not_found" });
        if (req.method === "PATCH") {
          Object.assign(r, { text: body.text, remindAt: new Date(body.remindAt).toISOString() });
          return send(200, { reminder: view(r) });
        }
        if (req.method === "DELETE") {
          state.reminders = state.reminders.filter((x) => x !== r);
          return send(200, { reminder: view(r) });
        }
      }

      if (collection === "events") {
        if (!id && req.method === "GET") return send(200, { events: [...state.events].sort((a, b) => a.start.localeCompare(b.start)).map(eventView) });
        if (!id && req.method === "POST") {
          const start = new Date(body.start).toISOString();
          const dupe = state.events.find((e) => norm(e.title) === norm(body.title) && Math.abs(Date.parse(e.start) - Date.parse(start)) <= HOUR);
          if (dupe && !body.force) return send(409, { error: "A similar event already exists.", code: "duplicate", duplicate: eventView(dupe) });
          const end = new Date(body.end).toISOString();
          const overlaps = state.events.filter((e) => e.start < end && e.end > start).map(eventView);
          const e = { n: next(state.events), title: body.title, start, end, allDay: !!body.allDay, location: body.location ?? null };
          state.events.push(e);
          return send(201, { event: eventView(e), overlaps });
        }
        const e = state.events.find((x) => String(x.n) === id);
        if (!e) return send(404, { error: `No event #${id}.`, code: "not_found" });
        if (req.method === "PATCH") {
          Object.assign(e, { title: body.title, start: new Date(body.start).toISOString(), end: new Date(body.end).toISOString(), allDay: false, ...(body.location ? { location: body.location } : {}) });
          return send(200, { event: eventView(e) });
        }
        if (req.method === "DELETE") {
          state.events = state.events.filter((x) => x !== e);
          return send(200, { event: eventView(e) });
        }
      }
      return send(404, { error: "no route" });
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { state, url: `http://127.0.0.1:${server.address().port}`, close: () => server.close() };
}
