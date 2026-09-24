// The one place environment variables are read — every config.js goes
// through readEnv() so "unset" and "set to blank" are treated identically
// (both come back null) and values are always trimmed.

import dotenv from "dotenv";

dotenv.config();

export function readEnv(name) {
  const value = process.env[name]?.trim();
  return value ? value : null;
}
