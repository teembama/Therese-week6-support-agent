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
