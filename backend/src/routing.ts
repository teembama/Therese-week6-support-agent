// Route matching and log redaction for the Vapi endpoint (docs/decisions.md D26).
//
// Token routes: POST /v/:token/chat/completions (Custom LLM) and POST /v/:token/vapi/events
// (server messages, D50). Vapi's Custom LLM credential is org-wide
// in the shared account and the dashboard offers no per-assistant headers, so the secret
// travels in the path. A wrong or missing token gets the same 404 as any unknown path, so the
// route's existence is not confirmed. The token is NEVER logged: every logged path goes
// through redactPath().

import { createHash, timingSafeEqual } from "node:crypto";

export const MIN_TOKEN_LENGTH = 32;

export function sha256(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

const TOKEN_PATH_RE = /^\/v\/([^/]*)\/(chat\/completions|vapi\/events)$/;

export type RouteMatch = { kind: "chat" } | { kind: "events" } | { kind: "not_found"; tokenChecked: boolean };

/** Matches the token routes and checks the token in constant time. */
export function matchRoute(method: string | undefined, pathname: string, secretDigest: Buffer): RouteMatch {
  const m = TOKEN_PATH_RE.exec(pathname);
  if (!m) return { kind: "not_found", tokenChecked: false };
  let token = "";
  try {
    token = decodeURIComponent(m[1]!);
  } catch {
    token = "";
  }
  // Hashing gives equal-length buffers, so timingSafeEqual never throws on a length mismatch.
  const tokenOk = timingSafeEqual(sha256(token), secretDigest) && token.length > 0;
  if (!tokenOk || method !== "POST") return { kind: "not_found", tokenChecked: true };
  return m[2] === "vapi/events" ? { kind: "events" } : { kind: "chat" };
}

/**
 * The only form in which a request path may be logged: the first segment after /v/ is
 * replaced, any literal occurrence of the secret is replaced, and the result is length-capped.
 */
export function redactPath(pathname: string, secret: string): string {
  let out = pathname.replace(/^\/v\/[^/]*/, "/v/[redacted]");
  if (secret.length >= 8) out = out.split(secret).join("[redacted]");
  try {
    const decoded = decodeURIComponent(out);
    if (secret.length >= 8 && decoded.includes(secret)) out = "[redacted path]";
  } catch {
    /* undecodable path: keep the already-redacted raw form */
  }
  return out.length > 200 ? `${out.slice(0, 200)}…` : out;
}
