// "Which Alatomy account is this Discord user?" - shared by `.a db`, `.a list db` and `.a account`.

import { AccountApiError, accountClient } from "./client.js";
import { config } from "./config.js";

export const ACCOUNT_DB_NAME = "alatomy";

/** True when the bot has been given the account service's address and secret. */
export const accountsEnabled = (client = accountClient) => client.isConfigured();

/**
 * The linked account as { account, db }, or null (not configured, or this Discord user has no linked
 * account). Throws AccountApiError if the account service cannot be reached.
 */
export async function getLinkedAccount(discordUserId, client = accountClient) {
  if (!client.isConfigured()) return null;
  return client.lookup(discordUserId);
}

/** The same, but a service outage becomes null (for places where other databases still work without it). */
export async function getLinkedAccountQuietly(discordUserId, client = accountClient) {
  try {
    return await getLinkedAccount(discordUserId, client);
  } catch (error) {
    if (!(error instanceof AccountApiError)) throw error;
    return null;
  }
}

/** The pseudo database instance the `.a db` machinery passes to the account kind's handlers. */
export const accountInstance = (link) => ({ kind: "account", name: ACCOUNT_DB_NAME, account: link.account, summary: link.db });

export const loginUrl = () => `${config.siteUrl}/account/login`;
export const accountUrl = () => `${config.siteUrl}/account`;

export const NOT_LINKED_HELP = () =>
  `Your Discord isn't linked to an Alatomy account yet. Log in at ${loginUrl()} (continue with Discord, or link Discord in Settings) and your account DB will be available here as \`.a db alatomy ...\`.`;
export const NOT_CONNECTED_HELP = "Alatomy accounts aren't connected on this bot yet.";
