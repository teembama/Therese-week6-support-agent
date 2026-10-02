// Enforced customer login for calls (L1, D86). Flag: CUSTOMER_LOGIN_REQUIRED.
//
// - POST /calls/pass (Authorization: Bearer <Supabase access token>): the backend verifies the
//   token with Supabase Auth (never trusting the browser), requires app_metadata.role customer or
//   staff (app_metadata can't be edited by users), and returns a ONE-TIME call pass: 32 random
//   bytes, stored only as its SHA-256 in call_passes (migration 007), valid for 5 minutes.
//   Rate-limited per client IP. Logs carry a short hash of the user ID, never the token or pass.
// - The page starts the Vapi call with the pass in assistantOverrides.variableValues.callPass; it
//   reaches us as call.assistantOverrides.variableValues.callPass (seen in a live request body,
//   2026-09-29: call.assistantOverrides.variableValues was present).
// - Every turn: redeem_call_pass(conversation, sha256(pass)) - unused and unexpired -> used and
//   linked; already linked -> ok (later turns need no pass). Anything else -> the fixed login
//   line, no agent run. An ok conversation is cached in memory, so later turns skip the database.

import { createHash, randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Db } from "@relaypay/shared";
import { clientIp } from "./records.js";

export const LOGIN_LINE = "Please log in on the RelayPay page to use voice support.";
export const CALL_PASS_RATE_LIMIT_PER_MINUTE = 10;
const ROLES = new Set(["customer", "staff"]);

export type AccessStatus = "ok" | "missing" | "invalid" | "reused" | "expired" | "error";
export interface Access {
  status: AccessStatus;
  userId: string | null;
  role: string | null;
  /** app_metadata.customer_id snapshot (L3), or null. */
  customerId: string | null;
}

export const sha256Hex = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
const shortHash = (s: string) => sha256Hex(s).slice(0, 10);

/** The pass from a Vapi Custom LLM body, and where it was found (for the confirmation log). */
export function extractCallPass(body: unknown): { pass: string | null; source: string } {
  const call = (body as { call?: Record<string, unknown> } | null)?.call;
  const overrides = call?.["assistantOverrides"] as Record<string, unknown> | undefined;
  const vv = overrides?.["variableValues"] as Record<string, unknown> | undefined;
  const pass = vv?.["callPass"];
  if (typeof pass === "string" && /^[A-Za-z0-9_-]{20,100}$/.test(pass)) return { pass, source: "call.assistantOverrides.variableValues.callPass" };
  if (pass !== undefined) return { pass: "", source: "call.assistantOverrides.variableValues.callPass (malformed)" };
  return { pass: null, source: overrides ? (vv ? "none (variableValues present, no callPass)" : "none (assistantOverrides present, no variableValues)") : "none (no assistantOverrides)" };
}

/** Per-conversation access, cached once ok. */
export function createAccessChecker(db: Db, maxCached = 5000) {
  const okCache = new Map<string, Access>();
  return async (conversationId: string, pass: string | null): Promise<Access & { cached: boolean }> => {
    const hit = okCache.get(conversationId);
    if (hit) return { ...hit, cached: true };
    const hash = pass === null ? null : sha256Hex(pass);
    const { data, error } = await db.rpc("redeem_call_pass", { p_conversation_id: conversationId, p_pass_hash: hash });
    if (error) return { status: "error", userId: null, role: null, customerId: null, cached: false };
    const row = (Array.isArray(data) ? data[0] : data) as { status?: string; user_id?: string | null; role?: string | null; customer_id?: string | null } | undefined;
    const status = (["ok", "missing", "invalid", "reused", "expired"].includes(String(row?.status)) ? row!.status : "error") as AccessStatus;
    const access: Access = { status, userId: row?.user_id ?? null, role: row?.role ?? null, customerId: row?.customer_id ?? null };
    if (status === "ok") {
      if (okCache.size >= maxCached) okCache.delete(okCache.keys().next().value!);
      okCache.set(conversationId, access);
    }
    return { ...access, cached: false };
  };
}

/** The role and mapped customer from verified app_metadata, or null when the user can't call. */
export function callerFromUser(user: { id?: string; app_metadata?: Record<string, unknown> } | null): { userId: string; role: "customer" | "staff"; customerId: string | null } | null {
  const role = user?.app_metadata?.["role"];
  if (!user?.id || typeof role !== "string" || !ROLES.has(role)) return null;
  const cid = user.app_metadata?.["customer_id"];
  return { userId: user.id, role: role as "customer" | "staff", customerId: typeof cid === "string" && /^CUS-\d{4}$/.test(cid) ? cid : null };
}

export function bearerToken(req: IncomingMessage): string | null {
  const h = req.headers["authorization"];
  const m = typeof h === "string" ? /^Bearer\s+([A-Za-z0-9._-]{20,4096})$/.exec(h.trim()) : null;
  return m ? m[1]! : null;
}

/** POST /calls/pass. */
export async function handleCallPass(
  req: IncomingMessage,
  res: ServerResponse,
  db: Db,
  opts: { allow: (key: string) => boolean; log: (e: Record<string, unknown>) => void; headers: Record<string, string> },
): Promise<void> {
  req.resume();
  const send = (status: number, body: unknown) => {
    res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store", ...opts.headers });
    res.end(JSON.stringify(body));
  };
  if (!opts.allow(clientIp(req))) {
    opts.log({ event: "call_pass_rate_limited" });
    return send(429, { error: "too many requests" });
  }
  const token = bearerToken(req);
  if (!token) return send(401, { error: "login required" });
  const { data, error } = await db.auth.getUser(token);
  if (error || !data?.user) {
    opts.log({ event: "call_pass_denied", reason: "invalid or expired session" });
    return send(401, { error: "login required" });
  }
  const caller = callerFromUser(data.user);
  if (!caller) {
    opts.log({ event: "call_pass_denied", reason: "role not allowed", user: shortHash(data.user.id) });
    return send(403, { error: "this account can't use voice support" });
  }
  const pass = randomBytes(32).toString("base64url");
  const { error: insertError } = await db.from("call_passes").insert({ pass_hash: sha256Hex(pass), user_id: caller.userId, role: caller.role, customer_id: caller.customerId });
  if (insertError) {
    opts.log({ event: "call_pass_failed", code: insertError.code ?? null });
    return send(503, { error: "voice support unavailable" });
  }
  opts.log({ event: "call_pass_issued", user: shortHash(caller.userId), role: caller.role, mapped: caller.customerId !== null });
  send(200, { pass, expiresInSeconds: 300 });
}
