import { test } from "node:test";
import assert from "node:assert/strict";
import { arrivedOverHttps } from "../src/common/http.js";

test("a request counts as https only when the host's proxy says so", () => {
  const req = (headers) => ({ headers });
  assert.equal(arrivedOverHttps(req({ "x-forwarded-proto": "https" })), true);
  assert.equal(arrivedOverHttps(req({ "x-forwarded-proto": "HTTPS, http" })), true);
  assert.equal(arrivedOverHttps(req({ "x-forwarded-proto": "http" })), false);
  assert.equal(arrivedOverHttps(req({})), false); // straight to http://<host>:<port>
});
