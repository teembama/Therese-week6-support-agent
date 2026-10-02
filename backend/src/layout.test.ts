// D92: the landing page, the call page at /support (old URLs redirect), the two-column layout, the
// Try asking change, and the brand colours unchanged.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, it } from "node:test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { handlePublic, isPublicRoute, renderPage, siteFooter, siteHeader } from "./web.js";

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
    // D95: the skip link is in the shared header and targets the page's main.
    assert.match(renderPage(html), /class="skip-link" href="#main"/);
    assert.match(html, /<main id="main"/);
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

describe("kept from D93 after the revert", () => {
  it("staff Log out is a button that signs out and goes to the landing page", () => {
    // D95: Log out lives in the shared header (staff page).
    assert.match(renderPage(read("staff.html")), /<button id="logout" type="button" class="button secondary small">Log out<\/button>/);
    const js = read("staff.js");
    const logout = js.slice(js.indexOf('ui.logout.addEventListener("click"'), js.indexOf("ui.refresh.addEventListener"));
    assert.match(logout, /signOut\(\)/);
    assert.match(logout, /location\.assign\("\/"\)/);
  });
});

describe("site redesign: shared header and footer, one container (D95)", () => {
  const pages = { landing: read("landing.html"), support: read("index.html"), staff: read("staff.html") };
  it("every page uses the shared header and footer partials, and its main sits in the same container", () => {
    assert.match(pages.landing, /<!-- @header home -->/);
    assert.match(pages.support, /<!-- @header support -->/);
    assert.match(pages.staff, /<!-- @header staff -->/);
    for (const html of Object.values(pages)) {
      assert.match(html, /<!-- @footer -->/);
      assert.match(html, /<main id="main" class="container /);
      assert.match(html, /<body class="site">/);
      const rendered = renderPage(html);
      assert.ok(!rendered.includes("<!-- @"), "placeholders filled");
      assert.match(rendered, /<header class="site-header">\s*<div class="container header-inner">/);
      assert.match(rendered, /<footer class="site-footer">/);
    }
  });
  it("header: wordmark to /, nav with aria-current on the current page, Start a call on customer pages, account on staff", () => {
    const home = siteHeader("home"), support = siteHeader("support"), staff = siteHeader("staff");
    assert.match(home, /<a class="wordmark" href="\/"[^>]*><span class="logo" aria-hidden="true">R<\/span><span class="wordmark-text">RelayPay<\/span><\/a>/);
    assert.match(home, /<a href="\/" aria-current="page">Home<\/a>/);
    // D96: the nav is only Home; it is the current page only on /.
    for (const h of [home, support, staff]) {
      assert.equal((h.match(/<li><a /g) ?? []).length, 1);
      assert.ok(!h.includes(">Customer support</a>") && !h.includes(">Staff</a>"));
    }
    assert.ok(!support.includes("aria-current") && !staff.includes("aria-current"));
    for (const h of [home, support]) assert.match(h, /<a class="button primary small header-cta" href="\/support">Start a call<\/a>/);
    assert.ok(!staff.includes("Start a call"));
    assert.match(staff, /<div id="account" class="header-account" hidden><span>Signed in as <strong id="account-email"><\/strong><\/span>/);
    assert.equal((home.match(/aria-current/g) ?? []).length, 1);
  });
  it("footer: only the demo line (D96)", () => {
    const f = siteFooter();
    assert.match(f, /© 2026 RelayPay · Demo project/);
    assert.ok(!f.includes("<a ") && !f.includes("<nav"));
  });
  it("served pages are rendered (the header is in the response, not a placeholder)", async () => {
    const { server, base } = await serve();
    try {
      for (const path of ["/", "/support"]) {
        const html = await (await fetch(`${base}${path}`)).text();
        assert.match(html, /<header class="site-header">/, path);
        assert.ok(!html.includes("<!-- @header"), path);
      }
    } finally {
      server.close();
    }
  });
  it("CSS: a full-width sticky header with a 1px grey rule and a 2px teal bottom line; 1200px container; body no longer centres", () => {
    const css = read("app.css");
    assert.match(css, /\.site-header \{\s*position: sticky; top: 0; z-index: 20; width: 100%;\s*background: var\(--surface\); border-bottom: 2px solid var\(--teal\); box-shadow: inset 0 -1px 0 var\(--border\);/);
    assert.match(css, /\.container \{ width: 100%; max-width: 75rem; margin: 0 auto; padding-left: 24px; padding-right: 24px; \}/);
    assert.match(css, /body\.site \{ display: flex; flex-direction: column; place-items: normal;/);
    assert.match(css, /\.site-nav a\[aria-current="page"\] \{ box-shadow: inset 0 -2px 0 var\(--teal\);/);
  });
});

describe("landing hero (D95)", () => {
  const landing = read("landing.html");
  it("hero: teal label, headline, one line, Customer support (primary) and Staff sign in (secondary)", () => {
    assert.match(landing, /<p class="eyebrow">RelayPay support<\/p>\s*<h1 id="title">Help with payments, payouts and your account<\/h1>/);
    assert.match(landing, /<a class="button primary" href="\/support">Customer support<\/a>\s*<a class="button secondary" href="\/staff">Staff sign in<\/a>/);
  });
  it("a static, decorative line illustration: aria-hidden, no fills or animation", () => {
    const art = landing.slice(landing.indexOf('<div class="hero-art"'), landing.indexOf("</section>"));
    assert.match(art, /<div class="hero-art" aria-hidden="true">/);
    assert.ok(!/<(?:animate|animateTransform|linearGradient|radialGradient|text)\b/.test(art));
    assert.ok(!/fill="(?!none)/.test(art));
  });
  it("three reassurances below the hero, each with a small icon", () => {
    const after = landing.slice(landing.indexOf("</section>"));
    for (const t of ["Answers from approved RelayPay information", "Your references shown on screen", "A specialist when you need one"]) assert.ok(after.includes(t), t);
    assert.equal((after.match(/class="reassure-icon"[^>]*aria-hidden="true"/g) ?? []).length, 3);
  });
});

describe("support and staff page structure (D95)", () => {
  it("/support: title area (teal label, heading, one line) above the two columns", () => {
    const html = read("index.html");
    assert.match(html, /<div class="page-head">\s*<p class="eyebrow">Customer support<\/p>\s*<h1 id="title">RelayPay voice support<\/h1>/);
    assert.ok(html.indexOf('class="page-head"') < html.indexOf('class="support-grid"'));
  });
  it("/staff: a centred login card (no back link: Home is in the header, D96); the dashboard title area; the 3/2/1 grid", () => {
    const html = read("staff.html");
    assert.match(html, /<section id="login" class="login-wrap"[\s\S]*<div class="login-card">\s*<h1 id="login-title">Staff sign in<\/h1>/);
    assert.ok(!html.includes("Back to home"));
    assert.match(html, /<p class="eyebrow">Staff<\/p>\s*<h1 id="title">Raised tickets and scheduled callbacks<\/h1>\s*<p class="lede">Read-only.<\/p>/);
    const css = read("app.css");
    assert.match(css, /\.login-card \{ width: 100%; max-width: 420px;/);
    assert.match(css, /\.staff \.staff-list \{ grid-template-columns: repeat\(3, minmax\(0, 1fr\)\);/);
    assert.match(css, /@media \(max-width: 1024px\) \{\s*\.staff \.staff-list \{ grid-template-columns: repeat\(2, minmax\(0, 1fr\)\); \}/);
    assert.match(css, /\.staff \.staff-list \{ grid-template-columns: 1fr; \}/);
  });
});
