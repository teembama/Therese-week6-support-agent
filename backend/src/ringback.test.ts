// Ringback tone (D96): start/stop on connect, error, End call, the 15 s timeout, and never during
// a connected call. The module is the browser file backend/public/ringback.js, with a fake audio
// context and fake timers; the wiring is checked in app.js's source.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const publicDir = resolve(dirname(fileURLToPath(import.meta.url)), "..", "public");
interface Ringback { readonly ringing: boolean; readonly connected: boolean; start(): boolean; stop(): void; markConnected(): void; reset(): void }
interface Mod {
  RING_FREQUENCIES: number[]; RING_ON_MS: number; RING_OFF_MS: number; CONNECT_TIMEOUT_MS: number; RING_GAIN: number; RINGING_TEXT: string;
  createRingback(o: { createContext: () => unknown; setTimer: (f: () => void, ms: number) => number; clearTimer: (id: number) => void; onTimeout?: () => void }): Ringback;
}
const m = (await import(pathToFileURL(resolve(publicDir, "ringback.js")).href)) as Mod;

function harness() {
  const levels: number[] = [];
  const oscs: Array<{ freq: number; started: boolean; stopped: boolean }> = [];
  let closed = 0, contexts = 0;
  const timers = new Map<number, { f: () => void; at: number }>();
  let now = 0, nextId = 1;
  const ctx = () => {
    contexts++;
    return {
      currentTime: 0, destination: {},
      createGain: () => ({ gain: { setValueAtTime: (v: number) => levels.push(v) }, connect() {}, disconnect() {} }),
      createOscillator: () => {
        const o = { freq: 0, started: false, stopped: false };
        oscs.push(o);
        return { type: "", frequency: { setValueAtTime: (f: number) => { o.freq = f; } }, connect() {}, start: () => { o.started = true; }, stop: () => { o.stopped = true; } };
      },
      close: async () => { closed++; },
    };
  };
  let timedOut = 0;
  const rb = m.createRingback({
    createContext: ctx,
    setTimer: (f, ms) => { const id = nextId++; timers.set(id, { f, at: now + ms }); return id; },
    clearTimer: (id) => { timers.delete(id); },
    onTimeout: () => { timedOut++; },
  });
  const advance = (ms: number) => {
    const end = now + ms;
    for (;;) {
      const due = [...timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      timers.delete(due[0]);
      now = due[1].at;
      due[1].f();
    }
    now = end;
  };
  return { rb, levels, oscs, advance, get closed() { return closed; }, get contexts() { return contexts; }, get timedOut() { return timedOut; }, get pending() { return timers.size; } };
}

describe("ringback tone (D96)", () => {
  it("the standard ringback: 440 + 480 Hz together, 2 s on / 4 s off, low volume, 15 s timeout", () => {
    assert.deepEqual(m.RING_FREQUENCIES, [440, 480]);
    assert.deepEqual([m.RING_ON_MS, m.RING_OFF_MS, m.CONNECT_TIMEOUT_MS], [2000, 4000, 15000]);
    assert.ok(m.RING_GAIN > 0 && m.RING_GAIN <= 0.1);
    assert.equal(m.RINGING_TEXT, "Ringing…");
    const h = harness();
    assert.equal(h.rb.start(), true);
    assert.deepEqual(h.oscs.map((o) => [o.freq, o.started]), [[440, true], [480, true]]);
    h.advance(0);
    assert.equal(h.levels.at(-1), m.RING_GAIN); // ringing
    h.advance(2000);
    assert.equal(h.levels.at(-1), 0); // 4 s silence
    h.advance(4000);
    assert.equal(h.levels.at(-1), m.RING_GAIN); // ringing again
  });
  it("stops immediately on connect, and never rings again during the connected call", () => {
    const h = harness();
    h.rb.start();
    h.rb.markConnected();
    assert.equal(h.rb.ringing, false);
    assert.ok(h.oscs.every((o) => o.stopped));
    assert.equal(h.closed, 1);
    assert.equal(h.pending, 0, "no cadence or timeout left");
    assert.equal(h.rb.start(), false, "never during a connected call");
    assert.equal(h.contexts, 1);
    h.rb.reset(); // the next call attempt
    assert.equal(h.rb.start(), true);
  });
  it("stops on an error or End call (stop), idempotently", () => {
    const h = harness();
    h.rb.start();
    h.rb.stop();
    h.rb.stop();
    assert.equal(h.rb.ringing, false);
    assert.equal(h.closed, 1);
    assert.equal(h.pending, 0);
    h.advance(20_000);
    assert.equal(h.timedOut, 0, "a stopped ring never times out");
  });
  it("not connected after 15 s: stops and reports the timeout once", () => {
    const h = harness();
    h.rb.start();
    h.advance(14_999);
    assert.equal(h.timedOut, 0);
    h.advance(1);
    assert.equal(h.timedOut, 1);
    assert.equal(h.rb.ringing, false);
    h.advance(30_000);
    assert.equal(h.timedOut, 1);
  });
  it("no audio available: the call goes on silently", () => {
    const rb = m.createRingback({ createContext: () => { throw new Error("no AudioContext"); }, setTimer: () => 1, clearTimer: () => {} });
    assert.equal(rb.start(), false);
    assert.equal(rb.ringing, false);
  });
  it("app.js wiring: starts when the call is placed; stops on call-start, assistant speech, error, call-end, End call, any failure and pagehide", () => {
    const js = readFileSync(resolve(publicDir, "app.js"), "utf8");
    assert.match(js, /setState\("connecting", "Connecting", ringback\.start\(\) \? RINGING_TEXT : /);
    assert.ok(js.indexOf("ringback.start()") < js.indexOf("vapi.start(assistantId"), "rings before the call is placed");
    const handler = (name: string) => js.slice(js.indexOf(`v.on("${name}"`), js.indexOf(`v.on("${name}"`) + 200);
    assert.match(handler("call-start"), /ringback\.markConnected\(\)/);
    assert.match(handler("speech-start"), /ringback\.markConnected\(\)/);
    assert.match(handler("call-end"), /ringback\.stop\(\)/);
    assert.match(handler("error"), /ringback\.stop\(\)/);
    assert.match(js, /if \(m\?\.type === "transcript" && m\.role === "assistant"\) ringback\.markConnected\(\);/);
    assert.match(js.slice(js.indexOf("function endCall("), js.indexOf("function endCall(") + 80), /ringback\.stop\(\)/);
    assert.match(js.slice(js.indexOf("function fail("), js.indexOf("function fail(") + 120), /ringback\.stop\(\)/);
    assert.match(js, /addEventListener\("pagehide", \(\) => ringback\.stop\(\)\)/);
    assert.match(js, /fail\(\{ group: "network", kind: "network", code: "connect-timeout" \}, "starting"\)/);
  });
});
