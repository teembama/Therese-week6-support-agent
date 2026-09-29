// TEMPORARY (live Vapi test, D26): request STRUCTURE only. Enabled with
// RELAYPAY_DEBUG_REQUEST_SHAPE=1. Prints header NAMES and the body's key tree with every value
// replaced by its type. Never header values, the token, or message content.

import { createHash } from "node:crypto";

/**
 * Extra fields for the TEMPORARY debug log (D28), still no content: message ROLE sequence,
 * Vapi's metadata.numModelRequestInTurn, the two OpenAI-SDK header values that explain
 * retries, and a short hash of the last caller message (to tell partial vs full transcripts
 * apart without logging them).
 */
export function debugDetails(body: unknown, headers: Record<string, string | string[] | undefined>): Record<string, unknown> {
  const b = (body ?? {}) as { messages?: Array<{ role?: unknown; content?: unknown }>; metadata?: { numModelRequestInTurn?: unknown } };
  const messages = Array.isArray(b.messages) ? b.messages : [];
  const lastUser = [...messages].reverse().find((m) => m?.role === "user");
  const text = typeof lastUser?.content === "string" ? lastUser.content : "";
  const header = (name: string) => {
    const v = headers[name];
    return Array.isArray(v) ? v.join(",") : (v ?? null);
  };
  return {
    role_sequence: messages.map((m) => (typeof m?.role === "string" ? m.role : typeof m?.role)),
    num_model_request_in_turn: b.metadata?.numModelRequestInTurn ?? null,
    x_stainless_retry_count: header("x-stainless-retry-count"),
    x_stainless_timeout: header("x-stainless-timeout"),
    last_user_message_hash: text ? createHash("sha256").update(text.trim().replace(/\s+/g, " "), "utf8").digest("hex").slice(0, 10) : null,
    last_user_message_chars: text.length,
  };
}

export function shapeOf(value: unknown, depth = 0): unknown {
  if (depth > 8) return "…";
  if (value === null) return "null";
  if (Array.isArray(value)) {
    const merged: Record<string, unknown> = {};
    const scalarTypes = new Set<string>();
    for (const item of value.slice(0, 100)) {
      const s = shapeOf(item, depth + 1);
      if (s && typeof s === "object" && !Array.isArray(s)) Object.assign(merged, s);
      else scalarTypes.add(String(s));
    }
    const items = Object.keys(merged).length ? merged : [...scalarTypes].join("|") || "empty";
    return { [`array(${value.length})`]: items };
  }
  if (typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, shapeOf(v, depth + 1)]));
  }
  return typeof value;
}
