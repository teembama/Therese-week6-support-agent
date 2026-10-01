// SSE chunks to Vapi (D75): every sentence leaves complete, with its trailing space, at once.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ServerResponse } from "node:http";
import { SseStream } from "./sse.js";

/** A fake response that records each write in order. */
function fakeRes() {
  const writes: string[] = [];
  const res = {
    headersSent: false,
    writableEnded: false,
    writeHead() { this.headersSent = true; return this; },
    setHeader() {},
    flushHeaders() {},
    write(chunk: string) { writes.push(String(chunk)); return true; },
    end(chunk?: string) { if (chunk) writes.push(String(chunk)); this.writableEnded = true; },
    on() { return this; },
  };
  return { res: res as unknown as ServerResponse, writes };
}

const contents = (writes: string[]) => writes.flatMap((w) => w.split("\n"))
  .filter((l) => l.startsWith("data: {"))
  .map((l) => (JSON.parse(l.slice(6)) as { choices: Array<{ delta: { content?: string } }> }).choices[0]?.delta.content)
  .filter((c): c is string => typeof c === "string");

describe("SseStream content (D75)", () => {
  it("the filler goes out immediately as one complete sentence ending in a full stop and a space", () => {
    const { res, writes } = fakeRes();
    const sse = new SseStream(res, "relaypay-agent", "agent");
    sse.content("One moment while I check that.");
    // Written synchronously, before any later content exists.
    assert.deepEqual(contents(writes), ["One moment while I check that. "]);
  });
  it("later sentences carry their own trailing space, never a leading one", () => {
    const { res, writes } = fakeRes();
    const sse = new SseStream(res, "relaypay-agent", "agent");
    sse.content("One moment while I check that.");
    sse.content("Your payout TXN-9001 is processing.");
    sse.finish();
    assert.deepEqual(contents(writes), ["One moment while I check that. ", "Your payout TXN-9001 is processing. "]);
    assert.equal(contents(writes).join("").trim(), "One moment while I check that. Your payout TXN-9001 is processing.");
  });
});
