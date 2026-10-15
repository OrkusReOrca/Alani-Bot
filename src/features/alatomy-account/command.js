// ".a account" — shows whether this Discord user is linked to an Alatomy account, and which one.
// The account itself (logging in, linking Discord, the password) is managed on the website; this
// only reports the link and points to the right page. Read-only.

import { AccountApiError } from "./client.js";
import { accountUrl, accountsEnabled, getLinkedAccount, NOT_CONNECTED_HELP, NOT_LINKED_HELP, ACCOUNT_DB_NAME } from "./link.js";

export const data = { name: "account" };

export const aiGuide = `
.a account  — shows whether the caller's Discord is linked to an Alatomy account (and which). Read-only. Once linked, the caller's reminders and events live in their "Alatomy account DB": use .a db alatomy add|list|delete|edit ... exactly like any other database (also visible on alatomy.com).`;

export async function execute(ctx) {
  if (!accountsEnabled()) {
    await ctx.reply(NOT_CONNECTED_HELP);
    return;
  }
  let link;
  try {
    link = await getLinkedAccount(ctx.userId);
  } catch (error) {
    if (error instanceof AccountApiError) {
      await ctx.reply(error.message);
      return;
    }
    throw error;
  }
  if (!link) {
    await ctx.reply(NOT_LINKED_HELP());
    return;
  }
  const { account, db } = link;
  await ctx.reply(
    [
      `**Alatomy account:** ${account.displayName} (@${account.username})`,
      `**Account DB** \`${ACCOUNT_DB_NAME}\`: ${db.reminders} reminder(s), ${db.events} event(s), ${db.trackers} tracker(s)`,
      `Use it here with \`.a db ${ACCOUNT_DB_NAME} add|list|delete|edit ...\`, or manage everything at ${accountUrl()}`,
    ].join("\n")
  );
}
