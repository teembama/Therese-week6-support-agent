// The Supabase fetch wrapper's single pre-connect retry (D28), with a stubbed global fetch.

import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { __test } from "@relaypay/shared";

const realFetch = globalThis.fetch;
const realError = console.error;

function preConnectError(code: string): Error {
  return Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error(`getaddrinfo ${code}`), { code }) });
}

function stubFetch(outcomes: Array<Error | Response>): { calls: () => number } {
  let n = 0;
  globalThis.fetch = (async () => {
    const o = outcomes[n++];
    if (o instanceof Error) throw o;
    return o!;
  }) as typeof fetch;
  return { calls: () => n };
}

afterEach(() => {
  globalThis.fetch = realFetch;
  console.error = realError;
});

describe("diagnosticFetch", () => {
  it("retries a POST once after a pre-connect failure (EAI_AGAIN) and returns the retry's response", async () => {
    console.error = () => {};
    const s = stubFetch([preConnectError("EAI_AGAIN"), new Response("ok")]);
    const res = await __test.diagnosticFetch("https://x.supabase.co/rest/v1/rpc/f", { method: "POST" });
    assert.equal(await res.text(), "ok");
    assert.equal(s.calls(), 2);
  });

  it("gives up after one retry", async () => {
    console.error = () => {};
    const s = stubFetch([preConnectError("ECONNREFUSED"), preConnectError("ECONNREFUSED")]);
    await assert.rejects(__test.diagnosticFetch("https://x.supabase.co/rest/v1/t", { method: "PATCH" }));
    assert.equal(s.calls(), 2);
  });

  it("does not retry GET (supabase-js already retries those)", async () => {
    console.error = () => {};
    const s = stubFetch([preConnectError("EAI_AGAIN"), new Response("ok")]);
    await assert.rejects(__test.diagnosticFetch("https://x.supabase.co/rest/v1/t", { method: "GET" }));
    assert.equal(s.calls(), 1);
  });

  it("does not retry failures that may have reached the server (e.g. ECONNRESET)", async () => {
    console.error = () => {};
    const s = stubFetch([preConnectError("ECONNRESET"), new Response("ok")]);
    await assert.rejects(__test.diagnosticFetch("https://x.supabase.co/rest/v1/t", { method: "POST" }));
    assert.equal(s.calls(), 1);
  });

  it("logs the cause without headers or keys", async () => {
    const lines: string[] = [];
    console.error = (m: string) => lines.push(m);
    stubFetch([preConnectError("EAI_AGAIN"), new Response("ok")]);
    await __test.diagnosticFetch("https://x.supabase.co/rest/v1/t?select=*", { method: "POST", headers: { apikey: "sb_secret_abc123" } });
    assert.match(lines[0]!, /POST \/rest\/v1\/t \| fetch failed \| cause: .*EAI_AGAIN/);
    assert.ok(!lines.join(" ").includes("sb_secret_abc123") && !lines.join(" ").includes("select=*"));
  });
});
