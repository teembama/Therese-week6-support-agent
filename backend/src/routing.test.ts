// Route matching and redaction (D26).

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { debugDetails, shapeOf } from "./debug-shape.js";
import { matchRoute, redactPath, sha256 } from "./routing.js";

const SECRET = "a".repeat(20) + "b".repeat(20) + "0123456789abcdef";
const DIGEST = sha256(SECRET);

describe("matchRoute", () => {
  it("accepts POST /v/<token>/chat/completions with the right token", () => {
    assert.deepEqual(matchRoute("POST", `/v/${SECRET}/chat/completions`, DIGEST), { kind: "chat" });
  });
  it("404s a wrong token, an empty token, and the old unprefixed route", () => {
    assert.equal(matchRoute("POST", `/v/${SECRET}x/chat/completions`, DIGEST).kind, "not_found");
    assert.equal(matchRoute("POST", "/v//chat/completions", DIGEST).kind, "not_found");
    assert.equal(matchRoute("POST", "/chat/completions", DIGEST).kind, "not_found");
  });
  it("404s other methods and other paths, even with the right token", () => {
    assert.equal(matchRoute("GET", `/v/${SECRET}/chat/completions`, DIGEST).kind, "not_found");
    assert.equal(matchRoute("POST", `/v/${SECRET}/chat/completions/chat/completions`, DIGEST).kind, "not_found");
    assert.equal(matchRoute("POST", `/v/${SECRET}`, DIGEST).kind, "not_found");
  });
});

describe("redactPath", () => {
  it("redacts the token segment on the chat path and on wrong-token paths", () => {
    assert.equal(redactPath(`/v/${SECRET}/chat/completions`, SECRET), "/v/[redacted]/chat/completions");
    assert.equal(redactPath("/v/guess/chat/completions", SECRET), "/v/[redacted]/chat/completions");
  });
  it("redacts the secret anywhere in an unknown path, including percent-encoded", () => {
    assert.ok(!redactPath(`/x/${SECRET}/y`, SECRET).includes(SECRET));
    const encoded = `/x/${SECRET.split("").map((c) => `%${c.charCodeAt(0).toString(16)}`).join("")}`;
    assert.ok(!decodeURIComponent(redactPath(encoded, SECRET)).includes(SECRET));
  });
  it("leaves ordinary paths readable", () => {
    assert.equal(redactPath("/health", SECRET), "/health");
  });
});

describe("shapeOf (debug, structure only)", () => {
  it("replaces every value with its type and never includes content", () => {
    const shape = shapeOf({ call: { id: "abc" }, messages: [{ role: "user", content: "my account number is 42" }], stream: true });
    assert.deepEqual(shape, { call: { id: "string" }, messages: { "array(1)": { role: "string", content: "string" } }, stream: "boolean" });
    assert.ok(!JSON.stringify(shape).includes("account number"));
  });
});

describe("debugDetails (debug, no content)", () => {
  it("reports roles, the model-request counter, SDK retry headers and a hash, never the text", () => {
    const d = debugDetails(
      { messages: [{ role: "system", content: "prompt" }, { role: "user", content: "What fees does RelayPay charge?" }], metadata: { numModelRequestInTurn: 2 } },
      { "x-stainless-retry-count": "1", "x-stainless-timeout": "20", authorization: "Bearer secret-value" },
    );
    assert.deepEqual(d.role_sequence, ["system", "user"]);
    assert.equal(d.num_model_request_in_turn, 2);
    assert.equal(d.x_stainless_retry_count, "1");
    assert.equal(d.x_stainless_timeout, "20");
    assert.match(String(d.last_user_message_hash), /^[0-9a-f]{10}$/);
    const json = JSON.stringify(d);
    assert.ok(!json.includes("RelayPay") && !json.includes("secret-value") && !json.includes("prompt"));
  });
});
