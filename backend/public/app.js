// RelayPay voice page (Batch 2D step 3, D52). Starts a Vapi web call with our assistant.
//
// @vapi-ai/web publishes no browser (UMD) build, so the SDK is imported as an ES module from
// esm.sh, pinned: the SDK version AND the Daily transport it depends on. The public key and
// assistant ID come from /config (env on the server), never from the repo.

import { classify, endOutcome, errorCode, isCallOverError } from "/call-end.js";
import { toggleState } from "/captions.js";

const SDK_URL = "https://esm.sh/@vapi-ai/web@2.7.1?deps=@daily-co/daily-js@0.87.0";
const MAX_CALL_MS = 4 * 60_000; // matches the note on the page; the assistant's own limit should be 240 s too

const el = (id) => document.getElementById(id);
const ui = {
  icon: el("state-icon"), label: el("state-label"), status: el("status"), timer: el("timer"),
  error: el("error"), errorTitle: el("error-title"), errorSteps: el("error-steps"),
  start: el("start"), end: el("end"),
  captions: el("captions"), captionsLines: el("captions-lines"), captionsToggle: el("captions-toggle"),
};

let vapi = null;
let assistantId = null;
let inCall = false;
let endedByUser = false;
let lastEndedReason = null;
let callStartedAt = 0;
let tick = null;
let warned = false;
// D76: no caller speech was ever transcribed in this call (so a silent end means "we couldn't hear you").
let heardCaller = false;
// D76: Daily reports Vapi ending the call as an error ("ejection"); the end is explained at call-end.
let callOverByVapi = false;
let explainTimer = null;
// Set when the browser blocks something by Content Security Policy (e.g. the Daily bundle).
let cspBlocked = null;
document.addEventListener("securitypolicyviolation", (e) => {
  cspBlocked = `${e.effectiveDirective || e.violatedDirective || "csp"}`;
});

function setState(state, label, detail) {
  ui.icon.dataset.state = state;
  ui.label.textContent = label;
  ui.status.textContent = detail;
}

function showError(title, steps, code) {
  ui.errorTitle.textContent = title;
  const items = code ? [...steps, `Error code for support: ${code}`] : steps;
  ui.errorSteps.replaceChildren(...items.map((s) => Object.assign(document.createElement("li"), { textContent: s })));
  ui.error.hidden = false;
}

function clearError() {
  ui.error.hidden = true;
  ui.errorSteps.replaceChildren();
}

function setButtons({ start, end, startText }) {
  ui.start.disabled = !start;
  ui.end.disabled = !end;
  if (startText) ui.start.textContent = startText;
}

// ---- Errors, in plain English with something the caller can do.
const ERRORS = {
  micBlocked: ["Microphone access is blocked.", [
    "Click the lock or site-settings icon next to the address bar and set Microphone to Allow.",
    "Then reload this page and press Start call again.",
  ]],
  noDevice: ["We couldn't use your microphone or speakers.", [
    "Use your computer's built-in microphone and speakers (disconnect or turn off Bluetooth headsets).",
    "Close other apps that may be using the microphone, such as Zoom, Teams, WhatsApp or other browser tabs.",
    "Reload the page and try again.",
  ]],
  insecure: ["Microphone access needs a secure page.", [
    "Open this page over https (the address should start with https://).",
  ]],
  network: ["We couldn't connect the call.", [
    "Check that you're online.",
    "Some office, school or public Wi-Fi networks block voice calls. Try another network or your phone's hotspot.",
  ]],
  notAllowed: ["This page isn't allowed to start calls from this address.", [
    "Open the page from its official address. If it keeps happening, tell the RelayPay team.",
  ]],
  notConfigured: ["Voice calls aren't set up on this server yet.", [
    "Please try again later.",
  ]],
  component: ["The call couldn't start because the voice component failed to load.", [
    "This is a problem on our side, not your microphone or network.",
    "Please try again later.",
  ]],
  // D76 (live call 01a0f839…, silence-timed-out: the page said "Something went wrong… daily-error").
  noAudio: ["We couldn't hear you, so the call ended.", [
    "Check your microphone is selected and unmuted, then try again.",
    "If you use a headset or Bluetooth device, try your computer's built-in microphone instead.",
  ]],
  generic: ["Something went wrong with the call.", [
    "Reload the page and try again.",
  ]],
};




/** How the call ended, in plain words, with a next step where the caller can do something. */
function explainEnd() {
  if (explainTimer) clearTimeout(explainTimer);
  explainTimer = null;
  stopTimer();
  const seconds = callStartedAt ? (Date.now() - callStartedAt) / 1000 : 0;
  inCall = false;
  const outcome = endOutcome({ endedByUser, lastEndedReason, heardCaller, seconds });
  return outcome.kind === "error" ? fail(outcome.error) : showEnded(outcome.text);
}

function showEnded(text) {
  setState("ended", "Call ended", text);
  setButtons({ start: true, end: false, startText: "Start a new call" });
  ui.start.focus();
}

// ---- Live captions (D77): the last 3 FINAL lines; caller finals and the assistant's spoken text only.
// Nothing is stored: lines live in the page and are cleared when a new call starts.
const MAX_CAPTION_LINES = 3;
function clearCaptions() {
  ui.captionsLines.replaceChildren();
}
function addCaption(role, text) {
  const line = String(text ?? "").trim();
  if (!line) return;
  const li = document.createElement("li");
  const who = document.createElement("span");
  who.className = `who ${role === "user" ? "caller" : "agent"}`;
  who.textContent = role === "user" ? "You:" : "RelayPay:";
  li.append(who, document.createTextNode(line));
  ui.captionsLines.append(li);
  while (ui.captionsLines.children.length > MAX_CAPTION_LINES) ui.captionsLines.firstElementChild.remove();
}
function toggleCaptions() {
  const next = toggleState(!ui.captionsLines.hidden);
  ui.captionsLines.hidden = !next.visible;
  ui.captionsToggle.textContent = next.label;
  ui.captionsToggle.setAttribute("aria-expanded", next.expanded);
}

function fail(kind, err) {
  const [title, steps] = ERRORS[kind] ?? ERRORS.generic;
  // Only the truly unknown case shows a code, so support can tell errors apart.
  const code = kind === "generic" ? errorCode(err) : null;
  stopTimer();
  if (inCall && vapi) {
    try { vapi.stop(); } catch { /* already stopped */ }
  }
  inCall = false;
  setState("error", "Error", title);
  showError(title, steps, code);
  setButtons({ start: Boolean(vapi && assistantId), end: false, startText: "Try again" });
}

// ---- Call timer and the 4-minute guard.
function startTimer() {
  callStartedAt = Date.now();
  warned = false;
  ui.timer.hidden = false;
  tick = setInterval(() => {
    const ms = Date.now() - callStartedAt;
    const s = Math.floor(ms / 1000);
    ui.timer.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
    if (!warned && ms >= MAX_CALL_MS - 30_000) {
      warned = true;
      ui.status.textContent = "About 30 seconds left in this call.";
    }
    if (ms >= MAX_CALL_MS && inCall) {
      lastEndedReason = "exceeded-max-duration";
      vapi.stop();
    }
  }, 1000);
}

function stopTimer() {
  if (tick) clearInterval(tick);
  tick = null;
}



// ---- Wiring.
function attach(v) {
  v.on("call-start", () => {
    inCall = true;
    ui.captions.hidden = false;
    setState("listening", "Live: listening", "Go ahead and speak.");
    startTimer();
    ui.end.focus();
  });
  v.on("speech-start", () => setState("speaking", "Live: RelayPay is speaking", "You can interrupt at any time."));
  v.on("speech-end", () => { if (inCall) setState("listening", "Live: listening", "Go ahead and speak."); });
  v.on("message", (m) => {
    if (m?.type === "status-update" && m.status === "ended" && typeof m.endedReason === "string") lastEndedReason = m.endedReason;
    // Vapi transcript messages: only FINAL lines are shown (caller speech as recognised; the
    // assistant's text as spoken), never partials.
    if (m?.type === "transcript" && m.transcriptType === "final" && (m.role === "user" || m.role === "assistant")) {
      if (m.role === "user" && String(m.transcript ?? "").trim()) heardCaller = true;
      addCaption(m.role, m.transcript);
    }
  });
  v.on("call-end", () => {
    const wasInCall = inCall || callOverByVapi;
    if (!ui.error.hidden) { inCall = false; stopTimer(); return; } // an error already explained what happened
    if (!wasInCall) {
      inCall = false;
      stopTimer();
      return showEnded("The call didn't start. Please try again.");
    }
    explainEnd();
  });
  v.on("error", (e) => {
    if (isCallOverError(e, Boolean(callStartedAt))) {
      // The call is ending on Vapi's side; call-end (or this fallback) explains how.
      callOverByVapi = true;
      if (!explainTimer) explainTimer = setTimeout(() => { if (ui.error.hidden) explainEnd(); }, 1500);
      return;
    }
    fail(classify(e, cspBlocked), e);
  });
}

async function startCall() {
  clearError();
  cspBlocked = null; // only violations during THIS attempt count
  endedByUser = false;
  lastEndedReason = null;
  heardCaller = false;
  callOverByVapi = false;
  callStartedAt = 0;
  if (explainTimer) clearTimeout(explainTimer);
  explainTimer = null;
  clearCaptions();
  setButtons({ start: false, end: false });
  if (!navigator.mediaDevices?.getUserMedia) return fail("insecure");
  setState("mic", "Requesting microphone", "Allow microphone access when your browser asks.");
  try {
    // Ask first ourselves, so a blocked or missing microphone gets a precise message.
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach((t) => t.stop());
  } catch (err) {
    return fail(classify(err, cspBlocked), err);
  }
  setState("connecting", "Connecting", "Connecting you to RelayPay support…");
  setButtons({ start: false, end: true });
  try {
    await vapi.start(assistantId);
  } catch (err) {
    fail(classify(err, cspBlocked), err);
  }
}

function endCall() {
  endedByUser = true;
  setButtons({ start: false, end: false });
  setState("ended", "Ending call", "Hanging up…");
  try { vapi.stop(); } catch { /* not started */ }
  if (!inCall) {
    setState("ended", "Call ended", "The call was cancelled.");
    setButtons({ start: true, end: false, startText: "Start call" });
  }
}

async function init() {
  ui.start.addEventListener("click", startCall);
  ui.end.addEventListener("click", endCall);
  ui.captionsToggle.addEventListener("click", toggleCaptions);
  let config;
  try {
    const res = await fetch("/config", { cache: "no-store" });
    if (!res.ok) return fail("notConfigured");
    config = await res.json();
  } catch {
    return fail("network");
  }
  if (!config?.vapiPublicKey || !config?.vapiAssistantId) return fail("notConfigured");
  let Vapi;
  try {
    Vapi = (await import(SDK_URL)).default;
  } catch {
    return fail("component");
  }
  assistantId = config.vapiAssistantId;
  vapi = new Vapi(config.vapiPublicKey);
  attach(vapi);
  setState("ready", "Ready", "Press Start call to talk to RelayPay support.");
  setButtons({ start: true, end: false, startText: "Start call" });
}

init();
