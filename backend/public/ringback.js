// Ringback tone while a call connects (D96). Pure logic with the audio context and the timers
// injected, so it is unit-tested in Node (backend/src/ringback.test.ts) and used by app.js.
//
// - The standard two-tone ringback (440 Hz + 480 Hz together), 2 s on / 4 s off, at low volume,
//   generated with the Web Audio API: no audio file, no CSP change, output only (the microphone is
//   never touched).
// - start() while connecting; stop() on connect (call-start or the first assistant speech, whichever
//   comes first), on an error, on End call, and when leaving the page.
// - After 15 s without connecting it stops and calls onTimeout (the page shows its network
//   "Connection problem" message).
// - Never plays during a connected call: after markConnected(), start() does nothing until reset().

export const RING_FREQUENCIES = [440, 480];
export const RING_ON_MS = 2000;
export const RING_OFF_MS = 4000;
export const CONNECT_TIMEOUT_MS = 15000;
export const RING_GAIN = 0.05;
export const RINGING_TEXT = "Ringing…";

export function createRingback({ createContext, setTimer = setTimeout, clearTimer = clearTimeout, onTimeout = () => {} } = {}) {
  let ctx = null;
  let gain = null;
  let oscillators = [];
  let cadence = null;
  let timeout = null;
  let connected = false;

  const setLevel = (on) => {
    if (!gain || !ctx) return;
    gain.gain.setValueAtTime(on ? RING_GAIN : 0, ctx.currentTime);
  };
  const cycle = (on) => {
    setLevel(on);
    cadence = setTimer(() => cycle(!on), on ? RING_ON_MS : RING_OFF_MS);
  };

  const api = {
    /** True while the tone is playing (on or between rings). */
    get ringing() { return ctx !== null; },
    get connected() { return connected; },
    /** Start ringing (no-op if already ringing, or if the call is connected). Returns whether it started. */
    start() {
      if (ctx || connected) return false;
      try {
        ctx = createContext();
        gain = ctx.createGain();
        gain.gain.setValueAtTime(0, ctx.currentTime);
        gain.connect(ctx.destination);
        oscillators = RING_FREQUENCIES.map((f) => {
          const o = ctx.createOscillator();
          o.type = "sine";
          o.frequency.setValueAtTime(f, ctx.currentTime);
          o.connect(gain);
          o.start();
          return o;
        });
      } catch {
        api.stop(); // no audio available: the call still connects, just silently
        return false;
      }
      cycle(true);
      timeout = setTimer(() => {
        if (!ctx) return;
        api.stop();
        onTimeout();
      }, CONNECT_TIMEOUT_MS);
      return true;
    },
    /** Stop the tone now (idempotent). */
    stop() {
      if (cadence !== null) clearTimer(cadence);
      if (timeout !== null) clearTimer(timeout);
      cadence = null;
      timeout = null;
      for (const o of oscillators) { try { o.stop(); } catch { /* already stopped */ } }
      oscillators = [];
      if (gain) { try { gain.disconnect(); } catch { /* ignore */ } }
      gain = null;
      if (ctx) { try { void ctx.close(); } catch { /* ignore */ } }
      ctx = null;
    },
    /** The call connected: stop, and never ring again until reset(). */
    markConnected() {
      connected = true;
      api.stop();
    },
    /** A new call attempt may ring again. */
    reset() {
      api.stop();
      connected = false;
    },
  };
  return api;
}
