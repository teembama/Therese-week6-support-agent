// How the voice page explains failures and call endings (D76, D81). Pure functions, no DOM, so
// they are unit-tested (backend/src/call-end.test.ts) and imported by app.js.
//
// Every failure falls in one of three groups, each with one headline and one next step; a short
// "Reference: <code>" line is shown for support but never as the main message:
//   user     - the caller can fix it (microphone blocked, device error, no audio heard)
//   network  - the connection (Daily transport, signalling disconnect, start() with no response)
//   ourSide  - Vapi rejected the call (HTTP 4xx/5xx, credits 402, auth 401/403), a component
//              failed to load, or anything unknown
// Normal endings (caller hung up, goodbye phrase, 4-minute limit) are not failures: "Call ended".

/** A short, non-sensitive reference for support: the SDK's error type or name, or "unknown". */
export function errorCode(err) {
  const raw = err?.type || err?.error?.type || err?.error?.name || err?.name || "unknown";
  return String(raw).toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "unknown";
}

function errorText(err) {
  try {
    return [err?.name, err?.message, err?.type, err?.errorMsg, err?.msg, err?.error?.name, err?.error?.message, err?.error?.msg,
      err?.error?.errorMsg, err?.error?.type, JSON.stringify(err)].filter(Boolean).join(" ");
  } catch {
    return String(err);
  }
}

/** An HTTP status carried by the error (start() rejected by Vapi), or null. */
export function httpStatus(err) {
  for (const v of [err?.status, err?.statusCode, err?.error?.status, err?.error?.statusCode, err?.response?.status, err?.error?.response?.status]) {
    const n = Number(v);
    if (Number.isInteger(n) && n >= 400 && n <= 599) return n;
  }
  const m = /"?(?:status(?:Code)?|HTTP)"?\s*[:= ]\s*"?([45]\d\d)\b/i.exec(errorText(err));
  return m ? Number(m[1]) : null;
}

const COMPONENT = /Content Security Policy|unsafe-eval|EvalError|call-machine|bundle|dynamically imported module|Failed to load module|ChunkLoadError|Loading chunk/i;
const MIC_BLOCKED = /NotAllowedError|SecurityError|permission (denied|dismissed)|not.*allowed.*microphone|microphone.*permission/i;
const DEVICE = /setSinkId|sinkId|output device|audiooutput|NotFoundError|NotReadableError|OverconstrainedError|AbortError|\bdevice\b/i;
const AUTH_OR_CREDITS = /Key doesn't allow|allowed origin|Unauthorized|Forbidden|Payment Required|insufficient (credits|funds|balance)|out of credits|billing/i;
const NETWORK = /network|\bICE\b|WebSocket|Failed to fetch|fetch failed|NetworkError|timed? ?out|timeout|connection|offline|signal+ing|disconnect|no response|ERR_INTERNET|ERR_NETWORK|ERR_CONNECTION/i;

/**
 * Classify an SDK or browser error into a group. phase: "starting" (before the call connected) or
 * "in-call". A daily-error (the transport) during an active call is classified by its details and,
 * when they say nothing more specific, is a network failure: never a generic catch-all.
 */
export function classifyFailure(err, { phase = "starting", cspBlocked = null } = {}) {
  const text = errorText(err);
  const status = httpStatus(err);
  const base = errorCode(err);
  const code = status ? `${base}-${status}` : base;
  if (cspBlocked || COMPONENT.test(text)) return { group: "ourSide", kind: "component", code: cspBlocked ? `csp-${cspBlocked}` : code };
  if (MIC_BLOCKED.test(text)) return { group: "user", kind: "micBlocked", code };
  if (DEVICE.test(text)) return { group: "user", kind: "noDevice", code };
  if (status === 402 || status === 401 || status === 403 || AUTH_OR_CREDITS.test(text)) return { group: "ourSide", kind: "rejected", code };
  if (status) return { group: "ourSide", kind: "rejected", code };
  if (NETWORK.test(text)) return { group: "network", kind: "network", code };
  if (phase === "in-call" && /daily/i.test(base)) return { group: "network", kind: "network", code };
  return { group: "ourSide", kind: "unknown", code };
}

/** The headline and lines for a classified failure (no jargon in the main text). */
export function failureMessage(failure, phase = "starting") {
  if (failure.group === "user") {
    switch (failure.kind) {
      case "micBlocked":
        return { headline: "Microphone problem", lines: ["Microphone access is blocked for this page.", "Click the lock or site-settings icon next to the address bar, set Microphone to Allow, then reload the page and press Start call."] };
      case "noDevice":
        return { headline: "Microphone problem", lines: ["We couldn't use your microphone or speakers.", "Use your computer's built-in microphone and speakers (disconnect Bluetooth headsets), close other apps using the microphone (Zoom, Teams, WhatsApp, other tabs), then reload and try again."] };
      case "insecure":
        return { headline: "Microphone problem", lines: ["Your browser only allows the microphone on a secure page.", "Open this page from its https:// address and try again."] };
      case "noAudio":
      default:
        return { headline: "Call ended", lines: ["We couldn't hear you, so the call ended.", "Check your microphone is selected and unmuted, then try again.", "If you use a headset or Bluetooth device, try your computer's built-in microphone instead."] };
    }
  }
  if (failure.group === "network") {
    return { headline: "Connection problem", lines: [phase === "in-call" ? "Your connection to the call dropped." : "We couldn't connect to the voice service.", "Check your internet connection, reload the page, or try a different network."] };
  }
  return { headline: "Something on our side isn't working", lines: ["Please try again later. If it keeps happening, contact RelayPay support."] };
}

/**
 * Daily reports the call being ended (by Vapi: silence, time limit, goodbye; or a drop) as an
 * "error" with "ejection" / "Meeting has ended". That is an ENDING, explained by describeEnd with
 * Vapi's ended reason; without a reason it counts as a dropped connection.
 */
export function isCallOverError(err, callStarted) {
  if (!callStarted) return false;
  return /ejection|ejected|meeting (has )?ended|ended due to/i.test(errorText(err));
}

/**
 * How a started call ended: { kind: "ended", headline, text } for normal endings, or
 * { kind: "failure", group, kind, code } for the rest.
 *   endedByUser - the caller pressed End call;   lastEndedReason - Vapi's endedReason, if received
 *   heardCaller - a final caller transcript was received;   seconds - call length so far
 *   ejected     - Daily reported the call ending (see isCallOverError)
 */
export function describeEnd({ endedByUser = false, lastEndedReason = null, heardCaller = false, seconds = 0, ejected = false }) {
  const ended = (text) => ({ kind: "ended", headline: "Call ended", text });
  const failure = (group, kind, code) => ({ kind: "failure", failure: { group, kind, code } });
  if (endedByUser) return ended("You ended the call.");
  const r = lastEndedReason;
  if (r === "silence-timed-out" || (r && r.includes("did-not-receive-customer-audio"))) return failure("user", "noAudio", r.slice(0, 60));
  if (r === "customer-did-not-give-microphone-permission") return failure("user", "micBlocked", r);
  if (r === "exceeded-max-duration") return ended("The call reached its 4-minute limit. Start a new call to keep going.");
  if (r === "assistant-said-end-call-phrase" || (r && r.startsWith("assistant-ended-call"))) return ended("The call ended. Thanks for calling RelayPay.");
  if (r === "customer-ended-call") return ended("The call has ended. Thanks for calling RelayPay.");
  if (r && /error|failed|fault/i.test(r)) {
    return /network|connection|transport|websocket|ice\b/i.test(r) ? failure("network", "network", r.slice(0, 60)) : failure("ourSide", "unknown", r.slice(0, 60));
  }
  if (r) return ended("The call has ended. Thanks for calling RelayPay.");
  if (!heardCaller && seconds >= 20) return failure("user", "noAudio", "no-speech-heard");
  if (ejected) return failure("network", "network", "ejected-without-reason");
  return ended("The call has ended. Thanks for calling RelayPay.");
}

const SECRET_KEY = /token|key|secret|password|authorization|cookie|url|uri|room/i;
/** The error object for the console, without secrets (keys like token/key/url are redacted). */
export function sanitizeForLog(err) {
  const seen = new WeakSet();
  const clean = (value, depth) => {
    if (value === null || typeof value !== "object") {
      return typeof value === "string" ? value.replace(/eyJ[\w-]+\.[\w-]+\.[\w-]+/g, "[jwt]").replace(/https?:\/\/\S+/g, "[url]") : value;
    }
    if (seen.has(value) || depth > 6) return "[…]";
    seen.add(value);
    const out = Array.isArray(value) ? [] : {};
    const keys = value instanceof Error ? ["name", "message", ...Object.keys(value)] : Object.keys(value);
    for (const k of keys) out[k] = SECRET_KEY.test(k) ? "[redacted]" : clean(value[k], depth + 1);
    return out;
  };
  return clean(err, 0);
}
