// Voice page captions (D79, D80). The module is the browser file backend/public/captions.js,
// loaded by URL (plain JS, no type declarations); the CSS rule is read from app.css.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const publicDir = resolve(here, "..", "public");
interface Captions {
  toggleState(visible: boolean): { visible: boolean; label: string; expanded: string };
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
