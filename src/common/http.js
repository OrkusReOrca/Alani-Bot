// Small helpers shared by every bridge route handler (see bridgeServer.js).

export class BadRequestError extends Error {}

export function sendJson(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

// Parses the request body as JSON. A malformed body throws BadRequestError,
// which bridgeServer turns into a 400 — handlers never need their own
// try/catch around parsing.
export async function readJsonBody(req) {
  let body = "";
  for await (const chunk of req) body += chunk;
  try {
    return JSON.parse(body);
  } catch {
    throw new BadRequestError("Invalid JSON body");
  }
}
