// Voice page captions (D79, D80). The module is the browser file backend/public/captions.js,
// loaded by URL (plain JS, no type declarations); the CSS rule is read from app.css.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const publicDir = resolve(here, "..", "public");
type Line = { role: "user" | "assistant"; text: string };
interface Captions {
  toggleState(visible: boolean): { visible: boolean; label: string; expanded: string };
  appendFinal(lines: Line[], role: string, text: unknown): Line[];
  isNearBottom(box: { scrollTop: number; clientHeight: number; scrollHeight: number }, threshold?: number): boolean;
  speakerLabel(role: string): string;
}
const c = (await import(pathToFileURL(resolve(publicDir, "captions.js")).href)) as Captions;

describe("captions toggle (D79)", () => {
  it("visible -> hidden: label 'Show captions', aria-expanded false; and back", () => {
    assert.deepEqual(c.toggleState(true), { visible: false, label: "Show captions", expanded: "false" });
    assert.deepEqual(c.toggleState(false), { visible: true, label: "Hide captions", expanded: "true" });
  });
  it("the stylesheet makes [hidden] win over component display rules (the actual bug)", () => {
    const css = readFileSync(resolve(publicDir, "app.css"), "utf8");
    assert.match(css, /\[hidden\]\s*\{\s*display:\s*none\s*!important;\s*\}/);
  });
  it("the page's toggle starts in the shown state, pointing at the caption lines", () => {
    const html = readFileSync(resolve(publicDir, "index.html"), "utf8");
    assert.match(html, /id="captions-toggle"[^>]*aria-expanded="true"[^>]*aria-controls="captions-lines"[^>]*>Hide captions</);
  });
});

describe("full-call scrollable captions (D80)", () => {
  it("keeps every final line of the call (no 3-line cap)", () => {
    let lines: Line[] = [];
    for (let i = 0; i < 10; i++) lines = c.appendFinal(lines, i % 2 ? "assistant" : "user", `line ${i}`);
    assert.equal(lines.length, 10);
  });
  it("merges consecutive fragments from the same speaker (live split at 'corridor—')", () => {
    let lines: Line[] = [];
    lines = c.appendFinal(lines, "user", "What fees do you charge?");
    lines = c.appendFinal(lines, "assistant", "Fees vary based on the transaction type, corridor—");
    lines = c.appendFinal(lines, "assistant", "and payment method.");
    assert.deepEqual(lines, [
      { role: "user", text: "What fees do you charge?" },
      { role: "assistant", text: "Fees vary based on the transaction type, corridor— and payment method." },
    ]);
  });
  it("a new speaker starts a new line; empty text and unknown roles change nothing", () => {
    const one = c.appendFinal([], "assistant", "Hello.");
    const two = c.appendFinal(one, "user", "Hi");
    assert.equal(two.length, 2);
    assert.equal(c.appendFinal(two, "user", "   "), two);
    assert.equal(c.appendFinal(two, "system", "x"), two);
  });
  it("auto-scroll only when the reader is at the newest line; otherwise 'Jump to latest'", () => {
    assert.equal(c.isNearBottom({ scrollTop: 300, clientHeight: 150, scrollHeight: 460 }), true);
    assert.equal(c.isNearBottom({ scrollTop: 100, clientHeight: 150, scrollHeight: 460 }), false);
  });
  it("speaker labels", () => {
    assert.equal(c.speakerLabel("user"), "You:");
    assert.equal(c.speakerLabel("assistant"), "RelayPay:");
  });
  it("the panel is a fixed-height scroll area with a 'Jump to latest' button, hidden at first", () => {
    const css = readFileSync(resolve(publicDir, "app.css"), "utf8");
    assert.match(css, /\.captions-lines\s*\{[^}]*height:\s*9\.5rem;[^}]*overflow-y:\s*auto;/);
    const html = readFileSync(resolve(publicDir, "index.html"), "utf8");
    assert.match(html, /id="captions-jump"[^>]*hidden>Jump to latest</);
  });
});
