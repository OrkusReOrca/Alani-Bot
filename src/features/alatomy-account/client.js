// Client for the Alatomy account service's internal API (/internal/v1, see the Alatomy_Website
// repo): looks an account up by Discord user id and works on that account's "Alatomy account DB".
// All the rules (duplicates, overlaps, numbering, limits) live in the service; this is a thin,
// well-behaved HTTP client.

import { config } from "./config.js";

export class AccountApiError extends Error {}

const FOUND_TTL_MS = 60_000;
const MISSING_TTL_MS = 15_000; // short, so linking Discord on the website is noticed quickly
const REQUEST_TIMEOUT_MS = 10_000;

export function createAccountClient({ apiUrl = config.apiUrl, apiSecret = config.apiSecret, fetchImpl = (...args) => fetch(...args), clock = Date.now } = {}) {
  const base = apiUrl ? apiUrl.replace(/\/+$/, "") : null;
  const cache = new Map(); // discord user id -> { until, value }

  async function request(method, path, body) {
    let response;
    try {
      response = await fetchImpl(`${base}/internal/v1${path}`, {
        method,
        headers: { Authorization: `Bearer ${apiSecret}`, ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      throw new AccountApiError("The Alatomy account service isn't answering right now. Try again in a moment.");
    }
    if (response.status === 401 || response.status === 503) {
      throw new AccountApiError("The bot isn't set up to talk to the Alatomy account service (check its API secret).");
    }
    if (response.status >= 500) throw new AccountApiError("The Alatomy account service had a problem. Try again in a moment.");
    const data = await response.json().catch(() => ({}));
    return { ok: response.ok, status: response.status, data };
  }

  const db = (accountId, path = "") => `/accounts/${encodeURIComponent(accountId)}/db${path}`;

  return {
    isConfigured: () => !!(base && apiSecret),

    /** The Alatomy account linked to a Discord user, or null. Cached briefly. */
    async lookup(discordUserId) {
      const hit = cache.get(discordUserId);
      if (hit && hit.until > clock()) return hit.value;
      const { data } = await request("POST", "/lookup", { provider: "discord", providerUserId: discordUserId });
      const value = data.found ? { account: data.account, db: data.db } : null;
      cache.set(discordUserId, { until: clock() + (value ? FOUND_TTL_MS : MISSING_TTL_MS), value });
      return value;
    },
    forget: (discordUserId) => cache.delete(discordUserId),

    // reminders
    listReminders: async (id) => (await request("GET", db(id, "/reminders"))).data.reminders ?? [],
    addReminder: (id, body) => request("POST", db(id, "/reminders"), body),
    updateReminder: (id, number, body) => request("PATCH", db(id, `/reminders/${encodeURIComponent(number)}`), body),
    deleteReminder: (id, number) => request("DELETE", db(id, `/reminders/${encodeURIComponent(number)}`)),
    deleteAllReminders: (id) => request("DELETE", db(id, "/reminders?all=1")),

    // events
    listEvents: async (id) => (await request("GET", db(id, "/events"))).data.events ?? [],
    addEvent: (id, body) => request("POST", db(id, "/events"), body),
    updateEvent: (id, number, body) => request("PATCH", db(id, `/events/${encodeURIComponent(number)}`), body),
    deleteEvent: (id, number) => request("DELETE", db(id, `/events/${encodeURIComponent(number)}`)),

    summary: async (id) => (await request("GET", db(id))).data.db ?? null,

    // delivery of due reminders
    dueReminders: async () => (await request("GET", "/reminders/due")).data.reminders ?? [],
    markDelivered: (reminderId) => request("POST", `/reminders/${encodeURIComponent(reminderId)}/done`, {}),
  };
}

export const accountClient = createAccountClient();
