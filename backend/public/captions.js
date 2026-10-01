// Live captions for the voice page (D77, D79). Pure functions, no DOM, so they are unit-tested
// (backend/src/captions.test.ts) and imported by app.js. Nothing here stores anything: the lines
// live in page memory for the current call only.

/**
 * The captions toggle (D79): the new visibility, the button label and aria-expanded.
 * The bug it fixes was CSS, not this logic: `.captions-lines { display: grid }` overrode the
 * `hidden` attribute, so "Hide captions" changed the label and hid nothing. app.css now has a
 * global `[hidden] { display: none !important; }`.
 */
export function toggleState(visible) {
  const next = !visible;
  return { visible: next, label: next ? "Hide captions" : "Show captions", expanded: String(next) };
}

/**
 * Add a FINAL transcript line to the current call's captions (D80). Every line is kept for the
 * whole call (the panel scrolls). Consecutive fragments from the same speaker are merged into one
 * line: Vapi sends an assistant reply as several finals (a live call split one sentence at
 * "corridor—"). Returns a new array; empty text or an unknown role changes nothing.
 */
export function appendFinal(lines, role, text) {
  const t = String(text ?? "").replace(/\s+/g, " ").trim();
  if (!t || (role !== "user" && role !== "assistant")) return lines;
  const last = lines[lines.length - 1];
  if (last && last.role === role) return [...lines.slice(0, -1), { role, text: `${last.text} ${t}` }];
  return [...lines, { role, text: t }];
}

/** Whether the reader is at (or within a few pixels of) the newest line: if so, auto-scroll. */
export function isNearBottom({ scrollTop, clientHeight, scrollHeight }, threshold = 24) {
  return scrollHeight - (scrollTop + clientHeight) <= threshold;
}

/** The label shown before a caption line. */
export function speakerLabel(role) {
  return role === "user" ? "You:" : "RelayPay:";
}
