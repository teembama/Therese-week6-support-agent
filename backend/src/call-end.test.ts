// Voice page: how a call's end and errors are explained (D76). The module is the browser file
// backend/public/call-end.js, loaded here by URL (it ships as plain JS, no type declarations).

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

type Outcome = { kind: "error"; error: string } | { kind: "ended"; text: string };
interface CallEnd {
  classify(err: unknown, cspBlocked?: string | null): string;
  errorCode(err: unknown): string;
  isCallOverError(err: unknown, callStarted: boolean): boolean;
  endOutcome(s: { endedByUser: boolean; lastEndedReason: string | null; heardCaller: boolean; seconds: number }): Outcome;
}

const here = dirname(fileURLToPath(import.meta.url));
const m = (await import(pathToFileURL(resolve(here, "..", "public", "call-end.js")).href)) as CallEnd;

describe("voice page: call end and errors (D76)", () => {
  const ejection = { type: "daily-error", error: { type: "ejected", msg: "Meeting has ended" }, errorMsg: "Meeting ended due to ejection" };
  it("live call 01a0f839: Daily's ejection after Vapi ends the call is the call ending, not 'Something went wrong'", () => {
    assert.equal(m.isCallOverError(ejection, true), true);
    assert.equal(m.isCallOverError({ type: "daily-error", error: { type: "unknown" } }, true), true);
  });
  it("before the call started, a daily-error is still an error (not an end)", () => {
    assert.equal(m.isCallOverError({ type: "daily-error", error: { type: "unknown" } }, false), false);
  });
  it("a network-looking daily-error mid-call is the network message, not an end", () => {
    assert.equal(m.isCallOverError({ type: "daily-error", error: { msg: "network connection lost" } }, true), false);
    assert.equal(m.classify({ type: "daily-error", error: { msg: "network connection lost" } }), "network");
  });
  it("silence: Vapi's reason, or no caller speech ever transcribed for 20 s or more -> 'We couldn't hear you'", () => {
    assert.deepEqual(m.endOutcome({ endedByUser: false, lastEndedReason: "silence-timed-out", heardCaller: false, seconds: 39 }), { kind: "error", error: "noAudio" });
    assert.deepEqual(m.endOutcome({ endedByUser: false, lastEndedReason: null, heardCaller: false, seconds: 39 }), { kind: "error", error: "noAudio" });
  });
  it("the 4-minute limit, a normal end and the caller hanging up each get their own plain text", () => {
    assert.match((m.endOutcome({ endedByUser: false, lastEndedReason: "exceeded-max-duration", heardCaller: true, seconds: 240 }) as { text: string }).text, /4-minute limit/);
    assert.match((m.endOutcome({ endedByUser: false, lastEndedReason: "assistant-said-end-call-phrase", heardCaller: true, seconds: 60 }) as { text: string }).text, /Thanks for calling/);
    assert.match((m.endOutcome({ endedByUser: false, lastEndedReason: "customer-ended-call", heardCaller: true, seconds: 60 }) as { text: string }).text, /The call has ended/);
    assert.deepEqual(m.endOutcome({ endedByUser: true, lastEndedReason: null, heardCaller: false, seconds: 5 }), { kind: "ended", text: "You ended the call." });
  });
  it("known failures map to their messages; only unknown ones are generic (with a code)", () => {
    assert.equal(m.classify({ name: "NotAllowedError" }), "micBlocked");
    assert.equal(m.classify({ name: "NotReadableError" }), "noDevice");
    assert.equal(m.classify({ message: "Failed to fetch" }), "network");
    assert.equal(m.classify({ message: "x" }, "script-src"), "component");
    assert.equal(m.classify({ type: "something-new" }), "generic");
    assert.equal(m.errorCode({ type: "Something New!" }), "something-new-");
  });
});
