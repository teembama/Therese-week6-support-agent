// Call-ending and error decisions for the voice page (D76). Pure functions, no DOM, so they are
// unit-tested (backend/src/call-end.test.ts) and imported by app.js.

/** A short, non-sensitive code for support: the SDK's error type or name, or "unknown". */
export function errorCode(err) {
  const raw = err?.type || err?.error?.type || err?.error?.name || err?.name || "unknown";
  return String(raw).toLowerCase().replace(/[^a-z0-9-]+/g, "-").slice(0, 40) || "unknown";
}

function errorText(err) {
  try {
    return [err?.name, err?.message, err?.type, err?.errorMsg, err?.error?.name, err?.error?.message, err?.error?.msg, err?.error?.errorMsg, err?.error?.type, JSON.stringify(err)].filter(Boolean).join(" ");
  } catch {
    return String(err);
  }
}

/** Which plain-English message an error gets; "generic" (with a code) only when nothing matches. */
export function classify(err, cspBlocked = null) {
  const text = errorText(err);
  // The component itself failed (blocked by CSP, bundle or module failed to load): our side.
  if (cspBlocked || /Content Security Policy|unsafe-eval|EvalError|call-machine|bundle|dynamically imported module|Failed to load module|ChunkLoadError|Loading chunk/i.test(text)) return "component";
  if (/NotAllowedError|SecurityError|permission (denied|dismissed)|not.*allowed.*microphone|microphone.*permission/i.test(text)) return "micBlocked";
  if (/setSinkId|sinkId|output device|audiooutput|NotFoundError|NotReadableError|OverconstrainedError|AbortError|device/i.test(text)) return "noDevice";
  if (/Key doesn't allow|allowed origin|origin|\b40[13]\b|Unauthorized|Forbidden/i.test(text)) return "notAllowed";
  if (/network|ICE|WebSocket|Failed to fetch|timed? ?out|daily-call-join|connection|offline/i.test(text)) return "network";
  return "generic";
}

/**
 * Daily surfaces Vapi ending the call (silence timeout, time limit, our hang-up) as an "error"
 * ("Meeting has ended", "ejection"; the SDK's type is daily-error). Once the call has started,
 * that is the call ending, not a failure. Live call 01a0f839… (silence-timed-out) showed
 * "Something went wrong… daily-error".
 */
export function isCallOverError(err, callStarted) {
  if (!callStarted) return false;
  if (/ejection|meeting (has )?ended|ended due to/i.test(errorText(err))) return true;
  return errorCode(err) === "daily-error" && classify(err) === "generic";
}

export const ENDED = {
  "customer-ended-call": "The call has ended. Thanks for calling RelayPay.",
  "assistant-ended-call": "The assistant ended the call.",
  "assistant-said-end-call-phrase": "The assistant ended the call. Thanks for calling.",
  "exceeded-max-duration": "The call reached the 4-minute limit. Start a new call to keep going.",
  "customer-did-not-give-microphone-permission": "The call ended because the microphone wasn't available.",
};

/** The ended-state text for a Vapi endedReason. */
export function endedText(reason) {
  if (!reason) return "The call has ended. Thanks for calling RelayPay.";
  if (ENDED[reason]) return ENDED[reason];
  if (reason.startsWith("assistant-ended-call")) return ENDED["assistant-ended-call"];
  return "The call ended because of a problem on our side. Please try again.";
}

/**
 * How a started call ended: an actionable error ("we couldn't hear you") or an ended-state text.
 * "No caller speech was ever transcribed" for 20 s or more counts as silence even when Vapi's
 * reason hasn't arrived (it can come after Daily's ejection).
 */
export function endOutcome({ endedByUser, lastEndedReason, heardCaller, seconds }) {
  if (endedByUser) return { kind: "ended", text: "You ended the call." };
  if (lastEndedReason === "silence-timed-out" || (!heardCaller && seconds >= 20)) return { kind: "error", error: "noAudio" };
  return { kind: "ended", text: endedText(lastEndedReason) };
}
