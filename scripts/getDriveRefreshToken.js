// One-time helper: lets the bot's Google Drive backup act as YOU.
//
//   GOOGLE_OAUTH_CLIENT_ID=... GOOGLE_OAUTH_CLIENT_SECRET=... npm run drive-token
//
// Opens Google's consent page (sign in as the account that owns the "Alani"
// Drive folder), catches the redirect on a local port, and prints the
// refresh token to paste into GOOGLE_OAUTH_REFRESH_TOKEN. Run it on your own
// PC, not on the host. Full setup steps: src/features/cloud-backup/README.md.

import http from "http";
import { readEnv } from "../src/common/env.js";

const PORT = 53682;
const REDIRECT_URI = `http://127.0.0.1:${PORT}`;
const SCOPE = "https://www.googleapis.com/auth/drive";

const clientId = readEnv("GOOGLE_OAUTH_CLIENT_ID");
const clientSecret = readEnv("GOOGLE_OAUTH_CLIENT_SECRET");
if (!clientId || !clientSecret) {
  console.error("Set GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET first (see the cloud-backup README).");
  process.exit(1);
}

const authUrl =
  "https://accounts.google.com/o/oauth2/v2/auth?" +
  new URLSearchParams({
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
    response_type: "code",
    scope: SCOPE,
    access_type: "offline",
    prompt: "consent", // forces a refresh token to be issued even on a repeat authorization
  });

async function exchangeCode(code) {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: REDIRECT_URI,
      grant_type: "authorization_code",
    }),
  });
  if (!res.ok) throw new Error(`Token exchange failed: ${res.status} ${await res.text()}`);
  return res.json();
}

const server = http.createServer(async (req, res) => {
  const code = new URL(req.url, REDIRECT_URI).searchParams.get("code");
  if (!code) {
    res.writeHead(400).end("No authorization code in the request.");
    return;
  }
  try {
    const { refresh_token: refreshToken } = await exchangeCode(code);
    if (!refreshToken) throw new Error("Google didn't return a refresh token — revoke the app's access in your Google account and run this again.");
    res.writeHead(200, { "Content-Type": "text/plain" }).end("Done — you can close this tab and return to the terminal.");
    console.log("\nGOOGLE_OAUTH_REFRESH_TOKEN=" + refreshToken + "\n");
  } catch (err) {
    res.writeHead(500, { "Content-Type": "text/plain" }).end(err.message);
    console.error(err.message);
  } finally {
    server.close();
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log("Open this URL, sign in as the Drive folder's owner, and allow access:\n\n" + authUrl + "\n");
});
