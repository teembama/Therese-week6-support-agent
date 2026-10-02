// D92: the landing page, the call page at /support (old URLs redirect), the two-column layout, the
// Try asking change, and the brand colours unchanged.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, it } from "node:test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { handlePublic, isPublicRoute } from "./web.js";

const publicDir = resolve(dirname(fileURLToPath(import.meta.url)), "..", "public");
const read = (f: string) => readFileSync(resolve(publicDir, f), "utf8");

async function serve(): Promise<{ server: Server; base: string }> {
  const server = createServer((req, res) => {
    const path = new URL(req.url!, "http://x").pathname;
    if (!isPublicRoute(req.method, path)) { res.writeHead(404); res.end(); return; }
    handlePublic(req, res, path, { VAPI_PUBLIC_KEY: "pk", VAPI_ASSISTANT_ID: "aid" } as NodeJS.ProcessEnv);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { server, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

describe("routes (D92)", () => {
  it("/ is the landing page; /support is the call page; old URLs redirect to /support", async () => {
    const { server, base } = await serve();
    try {
      const landing = await (await fetch(`${base}/`)).text();
      assert.match(landing, /href="\/support"[\s\S]*Customer support/);
      assert.match(landing, /href="\/staff"[\s\S]*Staff/);
      const support = await fetch(`${base}/support`);
      assert.equal(support.status, 200);
      assert.match(await support.text(), /Start call/);
      for (const old of ["/index.html", "/support/", "/call"]) {
        const r = await fetch(`${base}${old}`, { redirect: "manual" });
        assert.deepEqual([r.status, r.headers.get("location")], [301, "/support"], old);
      }
      assert.ok((await fetch(`${base}/support`)).headers.get("content-security-policy")?.includes("script-src 'self'"));
    } finally {
      server.close();
    }
  });
});

describe("call page layout (D92)", () => {
  const html = read("index.html");
  const left = html.slice(html.indexOf('class="col col-left"'), html.indexOf('class="col col-right"'));
  const right = html.slice(html.indexOf('class="col col-right"'));
  it("LEFT: path chooser, form, call status, Start/End, Try asking; RIGHT: captions and references", () => {
    for (const id of ['id="path"', 'id="customer-form"', 'id="status"', 'id="start"', 'id="end"', 'id="tips-title"']) assert.ok(left.includes(id), id);
    for (const id of ['id="captions"', 'id="captions-lines"', 'id="captions-jump"', 'id="records"', 'id="records-live"']) assert.ok(right.includes(id), id);
    assert.match(html, /<aside class="col col-right" aria-label="Captions and references">/);
  });
  it("accessibility kept: aria-live regions, the toggle's aria-controls, a skip link, a focusable caption list", () => {
    assert.match(html, /id="status"[^>]*role="status"[^>]*aria-live="polite"/);
    assert.match(html, /id="captions-toggle"[^>]*aria-expanded="true"[^>]*aria-controls="captions-lines"/);
    assert.match(html, /id="captions-lines"[^>]*tabindex="0"[^>]*aria-live="polite"/);
    assert.match(html, /class="skip-link" href="#start"/);
  });
  it("Try asking: the account status question replaces the spelled-out transaction", () => {
    assert.ok(html.includes("“Can you check my account status?”"));
    assert.ok(!html.includes("T X N nine zero zero one"));
  });
  it("stacks on mobile; brand colours unchanged", () => {
    const css = read("app.css");
    assert.match(css, /@media \(max-width: 860px\)[\s\S]*\.support-grid \{ grid-template-columns: 1fr;/);
    for (const token of ["--primary: #0b2a5b;", "--teal: #0f766e;", "--bg: #f7f7f4;", "--surface: #ffffff;"]) assert.ok(css.includes(token), token);
    assert.ok(!/gradient/i.test(css), "no gradients (brand direction)");
  });
});
