// Voice page: failures by type and call endings (D76, D81). The module is the browser file
// backend/public/call-end.js, loaded here by URL (it ships as plain JS, no type declarations).

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

type Group = "user" | "network" | "ourSide";
interface Failure { group: Group; kind: string; code: string }
type End = { kind: "ended"; headline: string; text: string } | { kind: "failure"; failure: Failure };
interface CallEnd {
  classifyFailure(err: unknown, opts?: { phase?: "starting" | "in-call"; cspBlocked?: string | null }): Failure;
  failureMessage(f: Pick<Failure, "group" | "kind">, phase?: "starting" | "in-call"): { headline: string; lines: string[] };
  isCallOverError(err: unknown, callStarted: boolean): boolean;
  describeEnd(s: { endedByUser?: boolean; lastEndedReason?: string | null; heardCaller?: boolean; seconds?: number; ejected?: boolean }): End;
  httpStatus(err: unknown): number | null;
  sanitizeForLog(err: unknown): unknown;
}

const here = dirname(fileURLToPath(import.meta.url));
const m = (await import(pathToFileURL(resolve(here, "..", "public", "call-end.js")).href)) as CallEnd;
const failureOf = (e: End): Failure => { assert.equal(e.kind, "failure"); return (e as { failure: Failure }).failure; };
const endedOf = (e: End) => { assert.equal(e.kind, "ended"); return e as { headline: string; text: string }; };

describe("failures by group (D81)", () => {
  it("the live case: a daily-error at 0:33 mid-call is classified by its details -> NETWORK, never generic", () => {
    const f = m.classifyFailure({ type: "daily-error", error: { type: "unknown", msg: "" } }, { phase: "in-call" });
    assert.equal(f.group, "network");
    assert.equal(f.code, "daily-error");
    assert.equal(m.failureMessage(f, "in-call").headline, "Connection problem");
    assert.match(m.failureMessage(f, "in-call").lines[0]!, /Your connection to the call dropped/);
  });
  it("the earlier start-method-error 'Signaling connection interrupted by a disconnect' -> NETWORK (couldn't connect)", () => {
    const f = m.classifyFailure({ type: "start-method-error", error: { message: "Signaling connection interrupted by a disconnect" } }, { phase: "starting" });
    assert.equal(f.group, "network");
    assert.equal(f.code, "start-method-error");
    assert.match(m.failureMessage(f, "starting").lines[0]!, /We couldn't connect to the voice service/);
    assert.match(m.failureMessage(f, "starting").lines[1]!, /Check your internet connection, reload the page, or try a different network/);
  });
  it("start() failing with no response / a fetch error -> NETWORK", () => {
    assert.equal(m.classifyFailure({ type: "start-method-error", error: { message: "Failed to fetch" } }).group, "network");
    assert.equal(m.classifyFailure(new TypeError("NetworkError when attempting to fetch resource.")).group, "network");
  });
  it("start() rejected by Vapi: HTTP 4xx/5xx, credits 402, auth 401/403 -> OUR SIDE, with the status in the reference", () => {
    for (const [status, msg] of [[402, "Payment Required"], [401, "Unauthorized"], [403, "Forbidden"], [400, "Bad Request"], [500, "Internal Server Error"]] as const) {
      const f = m.classifyFailure({ type: "start-method-error", error: { statusCode: status, message: msg } });
      assert.equal(f.group, "ourSide", String(status));
      assert.equal(f.code, `start-method-error-${status}`);
    }
    assert.equal(m.httpStatus({ error: { message: '{"statusCode":402,"message":"insufficient credits"}' } }), 402);
    assert.equal(m.failureMessage({ group: "ourSide", kind: "rejected" }).headline, "Something on our side isn't working");
    assert.match(m.failureMessage({ group: "ourSide", kind: "rejected" }).lines[0]!, /Please try again later\. If it keeps happening, contact RelayPay support\./);
  });
  it("component load failure (CSP or bundle) and anything unknown -> OUR SIDE", () => {
    assert.equal(m.classifyFailure({ message: "x" }, { cspBlocked: "script-src" }).group, "ourSide");
    assert.equal(m.classifyFailure({ message: "Failed to load module script" }).kind, "component");
    assert.deepEqual(m.classifyFailure({ type: "something-new" }), { group: "ourSide", kind: "unknown", code: "something-new" });
  });
  it("USER-FIXABLE: microphone blocked and device errors -> 'Microphone problem' with steps", () => {
    const blocked = m.classifyFailure({ name: "NotAllowedError", message: "Permission denied" });
    assert.deepEqual([blocked.group, blocked.kind], ["user", "micBlocked"]);
    assert.equal(m.failureMessage(blocked).headline, "Microphone problem");
    assert.match(m.failureMessage(blocked).lines.join(" "), /set Microphone to Allow/);
    const device = m.classifyFailure({ name: "NotReadableError", message: "Could not start audio source" });
    assert.deepEqual([device.group, device.kind], ["user", "noDevice"]);
    assert.equal(m.failureMessage(device).headline, "Microphone problem");
  });
  it("no main text contains raw jargon (the reference line carries the code)", () => {
    for (const f of [{ group: "user", kind: "micBlocked" }, { group: "user", kind: "noDevice" }, { group: "user", kind: "noAudio" }, { group: "network", kind: "network" }, { group: "ourSide", kind: "unknown" }] as const) {
      const msg = m.failureMessage(f, "in-call");
      assert.doesNotMatch([msg.headline, ...msg.lines].join(" "), /daily|ejection|start-method|signal+ing|\b[45]\d\d\b|error code/i, `${f.group}/${f.kind}`);
    }
  });
});

describe("call endings (D76, D81)", () => {
  const ejection = { type: "daily-error", error: { type: "ejected", msg: "Meeting has ended" }, errorMsg: "Meeting ended due to ejection" };
  it("an ejection after start is an ending (explained by Vapi's reason), not a failure; before start it isn't", () => {
    assert.equal(m.isCallOverError(ejection, true), true);
    assert.equal(m.isCallOverError(ejection, false), false);
    assert.equal(m.isCallOverError({ type: "daily-error", error: { type: "unknown" } }, true), false); // classified by details instead
  });
  it("normal endings: caller hung up, goodbye phrase, 4-minute limit -> 'Call ended' with a neutral text", () => {
    assert.deepEqual(endedOf(m.describeEnd({ endedByUser: true })), { kind: "ended", headline: "Call ended", text: "You ended the call." });
    assert.match(endedOf(m.describeEnd({ lastEndedReason: "assistant-said-end-call-phrase", heardCaller: true, seconds: 60 })).text, /Thanks for calling RelayPay/);
    assert.match(endedOf(m.describeEnd({ lastEndedReason: "exceeded-max-duration", heardCaller: true, seconds: 240 })).text, /4-minute limit/);
    assert.equal(endedOf(m.describeEnd({ lastEndedReason: "customer-ended-call", heardCaller: true, seconds: 60 })).headline, "Call ended");
  });
  it("no audio heard (Vapi's silence reason, no-customer-audio, or no transcript for 20 s+) -> USER 'Call ended' + steps", () => {
    for (const s of [{ lastEndedReason: "silence-timed-out", seconds: 39 }, { lastEndedReason: "call.in-progress.error-assistant-did-not-receive-customer-audio", seconds: 0 }, { seconds: 33 }]) {
      const f = failureOf(m.describeEnd({ heardCaller: false, ...s }));
      assert.deepEqual([f.group, f.kind], ["user", "noAudio"]);
      assert.equal(m.failureMessage(f, "in-call").headline, "Call ended");
      assert.match(m.failureMessage(f, "in-call").lines.join(" "), /We couldn't hear you, so the call ended\. Check your microphone is selected and unmuted, then try again\./);
    }
  });
  it("ejection without a server-side end reason (the caller had spoken) -> NETWORK 'connection dropped'", () => {
    const f = failureOf(m.describeEnd({ heardCaller: true, seconds: 33, ejected: true }));
    assert.deepEqual([f.group, f.code], ["network", "ejected-without-reason"]);
  });
  it("a server-side error ending -> OUR SIDE (or NETWORK for a transport reason), the reason as the reference", () => {
    assert.deepEqual(failureOf(m.describeEnd({ lastEndedReason: "pipeline-error-custom-llm-llm-failed", heardCaller: true, seconds: 10 })),
      { group: "ourSide", kind: "unknown", code: "pipeline-error-custom-llm-llm-failed" });
    assert.equal(failureOf(m.describeEnd({ lastEndedReason: "call.in-progress.error-websocket-connection-failed", heardCaller: true, seconds: 10 })).group, "network");
  });
});

describe("console diagnosis without secrets (D81)", () => {
  it("redacts token/key/url fields and JWT-looking strings; keeps type and message", () => {
    const clean = m.sanitizeForLog({ type: "start-method-error", error: { message: "boom", token: "abc", publicKey: "k", webCallUrl: "https://x.daily.co/room?t=1", nested: { msg: "see eyJa.eyJb.sig" } } }) as Record<string, any>;
    assert.equal(clean["type"], "start-method-error");
    assert.equal(clean["error"]["message"], "boom");
    assert.equal(clean["error"]["token"], "[redacted]");
    assert.equal(clean["error"]["publicKey"], "[redacted]");
    assert.equal(clean["error"]["webCallUrl"], "[redacted]");
    assert.equal(clean["error"]["nested"]["msg"], "see [jwt]");
  });
});

describe("silence timeout after the idle check-in (D96)", () => {
  it("the caller had spoken -> 'Call ended': no response, start a new call whenever ready", () => {
    assert.deepEqual(endedOf(m.describeEnd({ lastEndedReason: "silence-timed-out", heardCaller: true, seconds: 70 })), {
      kind: "ended", headline: "Call ended", text: "The call ended because there was no response. Start a new call whenever you're ready.",
    });
  });
  it("no caller speech at all -> the existing 'We couldn't hear you…' microphone message", () => {
    const f = failureOf(m.describeEnd({ lastEndedReason: "silence-timed-out", heardCaller: false, seconds: 30 }));
    assert.deepEqual([f.group, f.kind], ["user", "noAudio"]);
    assert.match(m.failureMessage(f, "in-call").lines.join(" "), /We couldn't hear you, so the call ended\./);
  });
});
