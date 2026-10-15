import { readEnv } from "../../common/env.js";

export const config = {
  // The Alatomy account service (the website deployment): its address and the shared secret the bot
  // sends to its /internal/v1 API. Both unset = the Alatomy account DB feature is off and every other
  // part of the bot is unaffected.
  apiUrl: readEnv("ALATOMY_ACCOUNT_API_URL"),
  apiSecret: readEnv("ALATOMY_ACCOUNT_API_SECRET"),
  // Where people are sent to log in or manage their account.
  siteUrl: (readEnv("ALATOMY_SITE_URL") ?? "https://alatomy.com").replace(/\/+$/, ""),
};
