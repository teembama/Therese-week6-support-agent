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
  "/": { file: "index.html", type: "text/html; charset=utf-8" },
  "/app.js": { file: "app.js", type: "text/javascript; charset=utf-8" },
  "/app.css": { file: "app.css", type: "text/css; charset=utf-8" },
};

export const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self' https://esm.sh https://*.daily.co",
  "style-src 'self'",
  "img-src 'self' data:",
  "connect-src 'self' https: wss:",
  "media-src 'self' blob: mediastream:",
  "worker-src 'self' blob:",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join("; ");

const SECURITY_HEADERS = {
  "Content-Security-Policy": CONTENT_SECURITY_POLICY,
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Permissions-Policy": "microphone=(self), camera=(), geolocation=()",
};

const cache = new Map<string, Buffer>();
function load(file: string): Buffer {
  let body = cache.get(file);
  if (!body) {
    body = readFileSync(resolve(PUBLIC_DIR, file));
    cache.set(file, body);
  }
  return body;
}

export function isPublicRoute(method: string | undefined, pathname: string): boolean {
  return (method === "GET" || method === "HEAD") && (pathname in FILES || pathname === "/config" || pathname === "/health");
}

export function handlePublic(req: IncomingMessage, res: ServerResponse, pathname: string, env: NodeJS.ProcessEnv = process.env): void {
  const head = req.method === "HEAD";
  const send = (status: number, type: string, body: Buffer | string, extra: Record<string, string> = {}) => {
    res.writeHead(status, { "Content-Type": type, "Cache-Control": "no-cache", ...SECURITY_HEADERS, ...extra });
    res.end(head ? undefined : body);
  };
  if (pathname === "/health") return send(200, "application/json", JSON.stringify({ status: "ok" }), { "Cache-Control": "no-store" });
  if (pathname === "/config") {
    const vapiPublicKey = env["VAPI_PUBLIC_KEY"]?.trim();
    const vapiAssistantId = env["VAPI_ASSISTANT_ID"]?.trim();
    if (!vapiPublicKey || !vapiAssistantId) return send(503, "application/json", JSON.stringify({ error: "voice not configured" }), { "Cache-Control": "no-store" });
    return send(200, "application/json", JSON.stringify({ vapiPublicKey, vapiAssistantId }), { "Cache-Control": "no-store" });
  }
  const entry = FILES[pathname]!;
  send(200, entry.type, load(entry.file));
}
