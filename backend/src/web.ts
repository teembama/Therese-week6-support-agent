// Public web routes (Batch 2D step 3, D52): GET / (voice page), /app.js, /app.css, /config, /health.
//
// /config returns ONLY the Vapi public key and assistant ID (public by design; they come from env
// so they stay out of the repo). /health exposes no configuration at all. Files are read once at
// startup. Security headers: a CSP that allows scripts only from this origin, esm.sh (the pinned
// Vapi SDK) and Daily (Vapi's WebRTC transport); microphone allowed for this origin only.

import { readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PUBLIC_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "public");

const FILES: Record<string, { file: string; type: string }> = {
  // D92: a landing page at / (customer support or staff); the call page moved to /support.
  "/": { file: "landing.html", type: "text/html; charset=utf-8" },
  "/support": { file: "index.html", type: "text/html; charset=utf-8" },
  "/app.js": { file: "app.js", type: "text/javascript; charset=utf-8" },
  "/call-end.js": { file: "call-end.js", type: "text/javascript; charset=utf-8" },
  "/captions.js": { file: "captions.js", type: "text/javascript; charset=utf-8" },
  "/records.js": { file: "records.js", type: "text/javascript; charset=utf-8" },
  "/auth.js": { file: "auth.js", type: "text/javascript; charset=utf-8" },
  "/call-path.js": { file: "call-path.js", type: "text/javascript; charset=utf-8" },
  "/app.css": { file: "app.css", type: "text/css; charset=utf-8" },
  "/favicon.svg": { file: "favicon.svg", type: "image/svg+xml" },
};

/** The staff dashboard page and its scripts (L2, D87): served only while STAFF_DASHBOARD_ENABLED is on. */
const STAFF_FILES: Record<string, { file: string; type: string }> = {
  "/staff": { file: "staff.html", type: "text/html; charset=utf-8" },
  "/staff.js": { file: "staff.js", type: "text/javascript; charset=utf-8" },
  "/staff-view.js": { file: "staff-view.js", type: "text/javascript; charset=utf-8" },
};

/** The staff dashboard flag, read at call time (L2, D87). */
export function staffDashboardEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return /^(1|true)$/i.test(env["STAFF_DASHBOARD_ENABLED"]?.trim() ?? "");
}

/** The Supabase project origin for connect-src, or "" when unset or not https. */
export function supabaseOrigin(url: string | undefined): string {
  try {
    const u = new URL(url ?? "");
    return u.protocol === "https:" ? u.origin : "";
  } catch {
    return "";
  }
}

export const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  // 'unsafe-eval' because Daily's bundle calls eval (first live call: script-src blocked eval), and
  // blob: because Daily's Krisp noise filter loads its AudioWorklet module from a blob: URL, and
  // worklet modules fall back to script-src (second live call). No 'unsafe-inline' (D55).
  "script-src 'self' 'unsafe-eval' blob: https://esm.sh https://*.daily.co",
  "style-src 'self'",
  "img-src 'self' data:",
  // Supabase Auth (login, L1/D86) is listed explicitly; https: already covered it (Vapi, Daily).
  `connect-src 'self' ${supabaseOrigin(process.env["SUPABASE_URL"])} https: wss:`.replace("  ", " "),
  "media-src 'self' blob: mediastream:",
  "worker-src 'self' blob:",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  // Violations are POSTed back here and logged (directive + blocked host only), so a blocked
  // Daily bundle on a live call shows up in the server logs, not just in the caller's console.
  "report-uri /csp-report",
].join("; ");

export const SECURITY_HEADERS: Record<string, string> = {
  "Content-Security-Policy": CONTENT_SECURITY_POLICY,
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Permissions-Policy": "microphone=(self), camera=(), geolocation=()",
};

/**
 * D95: the shared site header and footer, one source for every page. A page marks where they go
 * with <!-- @header home|support|staff --> and <!-- @footer -->; they are filled in when the file is
 * first served (then cached). Full-width bar; contents in the same centred container as the page.
 */
export type SitePage = "home" | "support" | "staff";
// D96: the header nav is just Home (Customer support and Staff are reached from the landing page).
const NAV: Array<{ page: SitePage; href: string; label: string }> = [
  { page: "home", href: "/", label: "Home" },
];
const navLinks = (current: SitePage | null) =>
  NAV.map((n) => `<li><a href="${n.href}"${n.page === current ? ' aria-current="page"' : ""}>${n.label}</a></li>`).join("");

export function siteHeader(page: SitePage): string {
  // Staff: "Signed in as" + Log out live here (shown by staff.js only when signed in). Customer
  // pages: the "Start a call" button.
  const right = page === "staff"
    ? '<div id="account" class="header-account" hidden><span>Signed in as <strong id="account-email"></strong></span><button id="logout" type="button" class="button secondary small">Log out</button></div>'
    : '<a class="button primary small header-cta" href="/support">Start a call</a>';
  return `<a class="skip-link" href="#main">Skip to content</a>
<header class="site-header">
  <div class="container header-inner">
    <a class="wordmark" href="/" aria-label="RelayPay home"><span class="logo" aria-hidden="true">R</span><span class="wordmark-text">RelayPay</span></a>
    <nav class="site-nav" aria-label="Main"><ul>${navLinks(page)}</ul></nav>
    ${right}
  </div>
</header>`;
}

/** D96: the footer is only the demo line. */
export function siteFooter(): string {
  return `<footer class="site-footer">
  <div class="container footer-inner">
    <p>© 2026 RelayPay · Demo project</p>
  </div>
</footer>`;
}

/** Fills the header and footer placeholders of a page's HTML. */
export function renderPage(html: string): string {
  return html
    .replace(/<!-- @header (home|support|staff) -->/, (_m, page: SitePage) => siteHeader(page))
    .replace("<!-- @footer -->", siteFooter());
}

const cache = new Map<string, Buffer>();
function load(file: string): Buffer {
  let body = cache.get(file);
  if (!body) {
    const raw = readFileSync(resolve(PUBLIC_DIR, file));
    body = file.endsWith(".html") ? Buffer.from(renderPage(raw.toString("utf8")), "utf8") : raw;
    cache.set(file, body);
  }
  return body;
}

/** D92: old call-page addresses keep working (permanent redirect to /support). */
export const REDIRECTS: Record<string, string> = { "/index.html": "/support", "/support/": "/support", "/call": "/support" };

export function isPublicRoute(method: string | undefined, pathname: string): boolean {
  if (method === "POST" && pathname === "/csp-report") return true;
  return (method === "GET" || method === "HEAD") && (pathname in FILES || pathname in REDIRECTS || pathname === "/config" || pathname === "/health" || (pathname in STAFF_FILES && staffDashboardEnabled()));
}

/** Just the host of a URL-ish CSP field ("https://c.daily.co/x.js" -> "c.daily.co"; keywords pass through). */
function hostOnly(value: unknown): string {
  const v = typeof value === "string" ? value.slice(0, 300) : "";
  try {
    return new URL(v).host || v.slice(0, 40);
  } catch {
    return v.slice(0, 40); // "inline", "eval", "blob", ...
  }
}

/** POST /csp-report: logs directive and blocked host only (never full URLs, which could carry data); always 204. */
export async function handleCspReport(req: IncomingMessage, res: ServerResponse, log: (e: Record<string, unknown>) => void): Promise<void> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > 20_000) break;
    chunks.push(c as Buffer);
  }
  try {
    const json = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
    const r = (json["csp-report"] ?? json) as Record<string, unknown>;
    log({ event: "csp_violation", directive: String(r["effective-directive"] ?? r["violated-directive"] ?? "").slice(0, 60), blocked: hostOnly(r["blocked-uri"]), source: hostOnly(r["source-file"]) });
  } catch {
    log({ event: "csp_violation", directive: "(unparsable report)" });
  }
  res.writeHead(204);
  res.end();
}

export function handlePublic(req: IncomingMessage, res: ServerResponse, pathname: string, env: NodeJS.ProcessEnv = process.env): void {
  const head = req.method === "HEAD";
  const send = (status: number, type: string, body: Buffer | string, extra: Record<string, string> = {}) => {
    res.writeHead(status, { "Content-Type": type, "Cache-Control": "no-cache", ...SECURITY_HEADERS, ...extra });
    res.end(head ? undefined : body);
  };
  const target = REDIRECTS[pathname];
  if (target) {
    res.writeHead(301, { Location: target, "Cache-Control": "no-cache", ...SECURITY_HEADERS });
    res.end();
    return;
  }
  if (pathname === "/health") return send(200, "application/json", JSON.stringify({ status: "ok" }), { "Cache-Control": "no-store" });
  if (pathname === "/config") {
    const vapiPublicKey = env["VAPI_PUBLIC_KEY"]?.trim();
    const vapiAssistantId = env["VAPI_ASSISTANT_ID"]?.trim();
    if (!vapiPublicKey || !vapiAssistantId) return send(503, "application/json", JSON.stringify({ error: "voice not configured" }), { "Cache-Control": "no-store" });
    // Login (L1, D86): the Supabase URL and PUBLISHABLE key only (public by design; the browser
    // uses them for Auth, never for tables: RLS has no policies).
    const loginRequired = /^(1|true)$/i.test(env["CUSTOMER_LOGIN_REQUIRED"]?.trim() ?? "");
    const supabaseUrl = supabaseOrigin(env["SUPABASE_URL"]);
    const supabasePublishableKey = env["SUPABASE_PUBLISHABLE_KEY"]?.trim();
    if (loginRequired && (!supabaseUrl || !supabasePublishableKey)) return send(503, "application/json", JSON.stringify({ error: "login not configured" }), { "Cache-Control": "no-store" });
    // The staff dashboard (L2, D87) needs the same public Auth settings, even with customer login off.
    const staffDashboard = staffDashboardEnabled(env);
    const login = loginRequired || staffDashboard ? { loginRequired, staffDashboard, supabaseUrl, supabasePublishableKey } : { loginRequired, staffDashboard };
    return send(200, "application/json", JSON.stringify({ vapiPublicKey, vapiAssistantId, ...login }), { "Cache-Control": "no-store" });
  }
  const entry = (FILES[pathname] ?? STAFF_FILES[pathname])!;
  send(200, entry.type, load(entry.file));
}
