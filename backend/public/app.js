// RelayPay voice page (Batch 2D step 3, D52). Starts a Vapi web call with our assistant.
//
// @vapi-ai/web publishes no browser (UMD) build, so the SDK is imported as an ES module from
// esm.sh, pinned: the SDK version AND the Daily transport it depends on. The public key and
// assistant ID come from /config (env on the server), never from the repo.

import { classifyFailure, describeEnd, failureMessage, isCallOverError, sanitizeForLog } from "/call-end.js";
import { appendFinal, isNearBottom, speakerLabel, toggleState } from "/captions.js";
import { announcement, copyText, describeEntry, mergeRecords, POLL_MS, recordsUrl } from "/records.js";
import { callOverrides, GUEST_NUDGE, passRequest, passResult, shouldNudge } from "/call-path.js";

const SDK_URL = "https://esm.sh/@vapi-ai/web@2.7.1?deps=@daily-co/daily-js@0.87.0";
const MAX_CALL_MS = 4 * 60_000; // matches the note on the page; the assistant's own limit should be 240 s too

const el = (id) => document.getElementById(id);
const ui = {
  icon: el("state-icon"), label: el("state-label"), status: el("status"), timer: el("timer"),
  error: el("error"), errorTitle: el("error-title"), errorSteps: el("error-steps"), errorRef: el("error-ref"),
  start: el("start"), end: el("end"),
  rightEmpty: el("right-empty"), captions: el("captions"), captionsLines: el("captions-lines"), captionsToggle: el("captions-toggle"), captionsJump: el("captions-jump"),
  records: el("records"), recordsList: el("records-list"), recordsLive: el("records-live"),
  path: el("path"), pathCustomer: el("path-customer"), pathGuest: el("path-guest"), customerForm: el("customer-form"),
  customerName: el("customer-name"), customerEmail: el("customer-email"), customerError: el("customer-error"),
  guestNote: el("guest-note"), guestNudge: el("guest-nudge"), callUi: el("call-ui"),
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
// D76/D81: Daily reports the call ending as an error ("ejection"); the end is explained at call-end.
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

function showError(headline, lines, code) {
  ui.errorTitle.textContent = headline;
  ui.errorSteps.replaceChildren(...lines.map((line) => Object.assign(document.createElement("li"), { textContent: line })));
  // The reference is for support only, never the main message (D81).
  ui.errorRef.textContent = code ? `Reference: ${code}` : "";
  ui.errorRef.hidden = !code;
  ui.error.hidden = false;
}

function clearError() {
  ui.error.hidden = true;
  ui.errorSteps.replaceChildren();
  ui.errorRef.hidden = true;
}

function setButtons({ start, end, startText }) {
  ui.start.disabled = !start;
  ui.end.disabled = !end;
  if (startText) ui.start.textContent = startText;
}

/** How the call ended: a normal ending ("Call ended") or a failure in one of the three groups (D81). */
function explainEnd() {
  if (explainTimer) clearTimeout(explainTimer);
  explainTimer = null;
  stopTimer();
  const seconds = callStartedAt ? (Date.now() - callStartedAt) / 1000 : 0;
  inCall = false;
  const end = describeEnd({ endedByUser, lastEndedReason, heardCaller, seconds, ejected: callOverByVapi });
  return end.kind === "failure" ? fail(end.failure, "in-call") : showEnded(end.text);
}

function showEnded(text) {
  setState("ended", "Call ended", text);
  setButtons({ start: true, end: false, startText: "Start a new call" });
  if (passRequired) return backToPaths(`${text} Choose how you'd like to continue for your next call.`);
  ui.start.focus();
}

/**
 * D90 (smoke test): after a call, back to the path chooser without a reload. The last captions and
 * the references panel stay visible until the next call starts (startCall clears the captions).
 */
function backToPaths(message) {
  path = null;
  ui.pathCustomer.setAttribute("aria-pressed", "false");
  ui.pathGuest.setAttribute("aria-pressed", "false");
  ui.customerForm.hidden = true;
  ui.guestNote.hidden = true;
  lockPath(false);
  setButtons({ start: false, end: false, startText: "Start call" });
  if (message) ui.status.textContent = message;
  ui.pathCustomer.focus();
}

// ---- Live captions (D77, D80): every FINAL line of the current call (caller speech as recognised,
// the assistant's text as spoken), consecutive fragments from one speaker merged. Kept in page memory
// only: cleared when a new call starts, gone on reload; nothing is stored.
let captionLines = [];
function clearCaptions() {
  captionLines = [];
  ui.captionsLines.replaceChildren();
  ui.captionsJump.hidden = true;
}
function captionItem(line) {
  const li = document.createElement("li");
  const who = document.createElement("span");
  who.className = `who ${line.role === "user" ? "caller" : "agent"}`;
  who.textContent = speakerLabel(line.role);
  li.append(who, document.createTextNode(line.text));
  return li;
}
function addCaption(role, text) {
  const atBottom = isNearBottom(ui.captionsLines);
  const next = appendFinal(captionLines, role, text);
  if (next === captionLines) return;
  if (next.length === captionLines.length) {
    // Merged into the last line: replace that line's text.
    ui.captionsLines.lastElementChild?.replaceWith(captionItem(next[next.length - 1]));
  } else {
    ui.captionsLines.append(captionItem(next[next.length - 1]));
  }
  captionLines = next;
  if (atBottom) scrollCaptionsToLatest();
  else ui.captionsJump.hidden = false; // the caller scrolled up to reread: don't move the panel
}
function scrollCaptionsToLatest() {
  ui.captionsLines.scrollTop = ui.captionsLines.scrollHeight;
  ui.captionsJump.hidden = true;
}
function toggleCaptions() {
  const next = toggleState(!ui.captionsLines.hidden);
  ui.captionsLines.hidden = !next.visible;
  ui.captionsToggle.textContent = next.label;
  ui.captionsToggle.setAttribute("aria-expanded", next.expanded);
}

// ---- "Your references" (D84): tickets and escalations created on this call. Polled every 3s
// during the call and once after it ends; the panel appears with the first record and stays until
// reload (references from earlier calls on this page are kept). Nothing is stored.
let callId = null;
let recordEntries = [];
let recordsTimer = null;
async function fetchRecords(id) {
  try {
    const res = await fetch(recordsUrl(id), { cache: "no-store" });
    if (!res.ok) return;
    const json = await res.json();
    if (json?.identity_checked === true) identityChecked = true;
    const { entries, added } = mergeRecords(recordEntries, json);
    if (!added.length) return;
    recordEntries = entries;
    for (const entry of added) ui.recordsList.append(recordItem(entry));
    ui.records.hidden = false;
    ui.recordsLive.textContent = announcement(added);
  } catch {
    /* the panel is a convenience: a failed poll is retried by the next one */
  }
}
function recordItem(entry) {
  const { title, detail } = describeEntry(entry);
  const li = document.createElement("li");
  const text = document.createElement("div");
  text.append(
    Object.assign(document.createElement("p"), { className: "record-title", textContent: title }),
    Object.assign(document.createElement("p"), { className: "record-detail", textContent: detail }),
  );
  const button = document.createElement("button");
  button.type = "button";
  button.className = "copy-button";
  const label = document.createElement("span");
  label.textContent = "Copy";
  button.append(label, Object.assign(document.createElement("span"), { className: "visually-hidden", textContent: ` ${title}` }));
  let reset = null;
  button.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(copyText(entry));
      label.textContent = "Copied";
      ui.recordsLive.textContent = `Copied ${title}.`;
    } catch {
      label.textContent = "Copy failed";
      ui.recordsLive.textContent = `Couldn't copy. The reference is ${entry.reference}.`;
    }
    if (reset) clearTimeout(reset);
    reset = setTimeout(() => { label.textContent = "Copy"; }, 2000);
  });
  li.append(text, button);
  return li;
}
function startRecordsPolling() {
  if (!callId || recordsTimer) return;
  const id = callId;
  recordsTimer = setInterval(() => void fetchRecords(id), POLL_MS);
}
/** Stop polling; one last read shortly after the call ends (the final turn's writes land then). */
function stopRecordsPolling() {
  if (recordsTimer) clearInterval(recordsTimer);
  recordsTimer = null;
  const id = callId;
  callId = null;
  if (id) setTimeout(() => void fetchRecords(id).then(maybeNudge), 2000);
}

// ---- Call paths (L1b, D88): when the server requires a call pass, the caller chooses
// "I'm an existing customer" (name + email, matched by the backend to one customer; the call is
// verified from its first turn and greeted by first name) or "Continue as a guest" (the call is
// exactly as before). Each call gets a ONE-TIME pass from POST /calls/pass, carried to the backend
// in the call's variableValues. Nothing is stored; the browser never reads tables.
let passRequired = false;
let path = null;
let callPath = null;
let identityChecked = false;
function choosePath(next) {
  if (inCall) return;
  path = next;
  ui.pathCustomer.setAttribute("aria-pressed", String(next === "customer"));
  ui.pathGuest.setAttribute("aria-pressed", String(next === "guest"));
  ui.customerForm.hidden = next !== "customer";
  ui.guestNote.hidden = next !== "guest";
  ui.customerError.hidden = true;
  if (vapi && assistantId) setButtons({ start: true, end: false });
  if (next === "customer") ui.customerName.focus();
}
function lockPath(locked) {
  ui.pathCustomer.disabled = locked;
  ui.pathGuest.disabled = locked;
  ui.customerName.disabled = locked;
  ui.customerEmail.disabled = locked;
}
function showCustomerError(message) {
  ui.customerError.textContent = message;
  ui.customerError.hidden = false;
  setState("ready", "Ready", message);
  setButtons({ start: true, end: false, startText: "Start call" });
  lockPath(false);
  (ui.customerName.value.trim() ? ui.customerEmail : ui.customerName).focus();
}
function maybeNudge() {
  if (shouldNudge(callPath, identityChecked)) {
    ui.guestNudge.textContent = GUEST_NUDGE;
    ui.guestNudge.hidden = false;
  }
}
/** A one-time pass (and the matched first name) for this call, or null (the page shows why). */
async function getCallPass() {
  const req = passRequest(path, ui.customerName.value, ui.customerEmail.value);
  if (!req.ok) {
    if (path === "customer") showCustomerError(req.message);
    else failWithMessage(req.message);
    return null;
  }
  let status = 0;
  let body = null;
  try {
    const res = await fetch("/calls/pass", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(req.body), cache: "no-store" });
    status = res.status;
    body = await res.json().catch(() => null);
  } catch {
    status = 0;
  }
  const result = passResult(status, body);
  if (result.kind === "ok") return result;
  if (result.kind === "no_match") showCustomerError(result.message);
  else failWithMessage(result.message);
  return null;
}
function failWithMessage(message) {
  setState("error", "Couldn't start the call", message);
  showError("Couldn't start the call", [message]);
  setButtons({ start: true, end: false, startText: "Try again" });
  lockPath(false);
}

/** Show a classified failure: its group's headline and next step, plus a small reference line. */
function fail(failure, phase = callStartedAt ? "in-call" : "starting") {
  const { headline, lines } = failureMessage(failure, phase);
  stopTimer();
  if (inCall && vapi) {
    try { vapi.stop(); } catch { /* already stopped */ }
  }
  inCall = false;
  stopRecordsPolling();
  setState("error", headline, lines[0]);
  showError(headline, lines, failure.code);
  setButtons({ start: Boolean(vapi && assistantId), end: false, startText: "Try again" });
  if (passRequired) lockPath(false); // the chosen path stays selected for "Try again"
}

/** Log an SDK or browser error for diagnosis (secrets redacted), then classify it. */
function failFromError(err) {
  console.error("[relaypay] call error", sanitizeForLog(err));
  const phase = callStartedAt ? "in-call" : "starting";
  fail(classifyFailure(err, { phase, cspBlocked }), phase);
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
    ui.rightEmpty.hidden = true;
    setState("listening", "Live: listening", "Go ahead and speak.");
    startTimer();
    startRecordsPolling();
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
    stopRecordsPolling();
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
      // The call is ending (Vapi's reason, or a drop); call-end (or this fallback) explains how.
      console.info("[relaypay] call ended by the transport", sanitizeForLog(e));
      callOverByVapi = true;
      if (!explainTimer) explainTimer = setTimeout(() => { if (ui.error.hidden) explainEnd(); }, 1500);
      return;
    }
    failFromError(e);
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
  if (!navigator.mediaDevices?.getUserMedia) return fail({ group: "user", kind: "insecure", code: "insecure-page" }, "starting");
  setState("mic", "Requesting microphone", "Allow microphone access when your browser asks.");
  try {
    // Ask first ourselves, so a blocked or missing microphone gets a precise message.
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach((t) => t.stop());
  } catch (err) {
    return failFromError(err);
  }
  let overrides;
  if (passRequired) {
    lockPath(true);
    ui.customerError.hidden = true;
    ui.guestNudge.hidden = true;
    identityChecked = false;
    setState("connecting", "Connecting", path === "customer" ? "Checking your details…" : "Getting your call ready…");
    const result = await getCallPass();
    if (!result) return;
    callPath = path;
    overrides = callOverrides(result.pass, result.firstName);
  }
  setState("connecting", "Connecting", "Connecting you to RelayPay support…");
  setButtons({ start: false, end: true });
  try {
    // The call's ID (an unguessable UUID; also our conversation ID) scopes the references panel.
    let call;
    try {
      call = await (overrides ? vapi.start(assistantId, overrides) : vapi.start(assistantId));
    } catch (err) {
      // If the per-call greeting override is refused, start once more with the assistant's own
      // greeting: the pass is redeemed only on the first turn, so it is still valid.
      if (!overrides?.firstMessage) throw err;
      console.info("[relaypay] greeting override refused; starting with the default greeting", sanitizeForLog(err));
      const { firstMessage: _unused, ...rest } = overrides;
      call = await vapi.start(assistantId, rest);
    }
    callId = typeof call?.id === "string" ? call.id : null;
    if (inCall) startRecordsPolling();
  } catch (err) {
    failFromError(err);
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
  ui.captionsJump.addEventListener("click", scrollCaptionsToLatest);
  ui.captionsLines.addEventListener("scroll", () => { if (isNearBottom(ui.captionsLines)) ui.captionsJump.hidden = true; });
  let config;
  try {
    const res = await fetch("/config", { cache: "no-store" });
    if (!res.ok) return fail({ group: "ourSide", kind: "unknown", code: `config-${res.status}` }, "starting");
    config = await res.json();
  } catch {
    return fail({ group: "network", kind: "network", code: "config-unreachable" }, "starting");
  }
  if (!config?.vapiPublicKey || !config?.vapiAssistantId) return fail({ group: "ourSide", kind: "unknown", code: "not-configured" }, "starting");
  let Vapi;
  try {
    Vapi = (await import(SDK_URL)).default;
  } catch (err) {
    console.error("[relaypay] voice component failed to load", sanitizeForLog(err));
    return fail({ group: "ourSide", kind: "component", code: "sdk-load-failed" }, "starting");
  }
  if (config.loginRequired) {
    passRequired = true;
    ui.path.hidden = false;
    ui.pathCustomer.addEventListener("click", () => choosePath("customer"));
    ui.pathGuest.addEventListener("click", () => choosePath("guest"));
    ui.customerForm.addEventListener("submit", (e) => { e.preventDefault(); if (!ui.start.disabled) void startCall(); });
  }
  assistantId = config.vapiAssistantId;
  vapi = new Vapi(config.vapiPublicKey);
  attach(vapi);
  setState("ready", "Ready", passRequired ? "Choose how you'd like to continue, then press Start call." : "Press Start call to talk to RelayPay support.");
  setButtons({ start: !passRequired || path !== null, end: false, startText: "Start call" });
}

init();
