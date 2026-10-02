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

/** The generic answer for any failed customer match: never which detail was wrong (D88). */
export const NO_MATCH_MESSAGE = "We couldn't find an account matching those details.";

/** Case- and spacing-insensitive form of a typed name: "  amara   OKAFOR " -> "amara okafor". */
export const normaliseFormName = (s: string) => s.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();
/** A typed email, trimmed and lowercased. */
export const normaliseFormEmail = (s: string) => s.normalize("NFKC").trim().toLowerCase();

/**
 * L1b (D88): the customer a name + email identifies, or null. BOTH must match the SAME customer:
 * the email exactly (after normalising), and the name as the full contact name or its first name.
 */
export function matchFormCustomer<T extends { customer_id: string; contact_name: string; contact_email: string }>(
  customers: T[], name: string, email: string,
): T | null {
  const n = normaliseFormName(name);
  const e = normaliseFormEmail(email);
  if (!n || !e || e.length > 254 || n.length > 100) return null;
  const hits = customers.filter((c) => {
    if (normaliseFormEmail(c.contact_email) !== e) return false;
    const full = normaliseFormName(c.contact_name);
    return n === full || n === full.split(" ")[0];
  });
  return hits.length === 1 ? hits[0]! : null;
}

/** The first name used in the greeting: the first word of the contact name, letters only. */
export const firstNameOf = (contactName: string) => (contactName.trim().split(/\s+/)[0] ?? "").replace(/[^\p{L}'-]/gu, "").slice(0, 40);

async function readJson(req: IncomingMessage, max = 2048): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > max) return null;
    chunks.push(c as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return null;
  }
}

/**
 * POST /calls/pass. Three ways to get a one-time pass:
 *   - body {mode: "customer", name, email} (L1b, D88): name AND email must match one customer;
 *     the pass carries that customer (source form_customer). No match -> 422 with the generic
 *     message and no pass. Identification, not authentication: name and email aren't secrets.
 *   - body {mode: "guest"} (L1b): a pass with no customer (source guest); the call is as before.
 *   - Authorization: Bearer <Supabase token> (L1, D86; source login): kept for staff and tests.
 */
export async function handleCallPass(
  req: IncomingMessage,
  res: ServerResponse,
  db: Db,
  opts: { allow: (key: string) => boolean; log: (e: Record<string, unknown>) => void; headers: Record<string, string> },
): Promise<void> {
  const send = (status: number, body: unknown) => {
    res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store", ...opts.headers });
    res.end(JSON.stringify(body));
  };
  // TEMPORARY (D89 diagnosis): which proxy headers vary between requests. Hashes only, no addresses.
  {
    const h = (v: unknown) => (typeof v === "string" ? sha256Hex(v).slice(0, 8) : "-");
    const xff = typeof req.headers["x-forwarded-for"] === "string" ? (req.headers["x-forwarded-for"] as string).split(",").map((x) => x.trim()) : [];
    opts.log({ event: "ip_diag", key: h(clientIp(req)), real: h(req.headers["x-real-ip"]), xff_hops: xff.length, xff_first: h(xff[0]), xff_last: h(xff[xff.length - 1]), envoy: h(req.headers["x-envoy-external-address"]) });
  }
  if (!opts.allow(clientIp(req))) {
    req.resume();
    opts.log({ event: "call_pass_rate_limited" });
    return send(429, { error: "too many requests" });
  }
  const token = bearerToken(req);
  if (!token) {
    const body = (await readJson(req)) as { mode?: unknown; name?: unknown; email?: unknown } | null;
    const issue = async (row: Record<string, unknown>) => {
      const pass = randomBytes(32).toString("base64url");
      const { error } = await db.from("call_passes").insert({ pass_hash: sha256Hex(pass), ...row });
      if (error) {
        opts.log({ event: "call_pass_failed", code: error.code ?? null });
        return null;
      }
      return pass;
    };
    if (body?.mode === "guest") {
      const pass = await issue({ source: "guest" });
      if (!pass) return send(503, { error: "voice support unavailable" });
      opts.log({ event: "call_pass_issued", source: "guest" });
      return send(200, { pass, expiresInSeconds: 300 });
    }
    if (body?.mode === "customer" && typeof body.name === "string" && typeof body.email === "string") {
      const { data, error } = await db.from("customers").select("customer_id, contact_name, contact_email").limit(10_000);
      if (error) {
        opts.log({ event: "call_pass_failed", code: error.code ?? null });
        return send(503, { error: "voice support unavailable" });
      }
      const c = matchFormCustomer((data ?? []) as Array<{ customer_id: string; contact_name: string; contact_email: string }>, body.name, body.email);
      if (!c) {
        opts.log({ event: "call_pass_denied", source: "form_customer", reason: "no match" });
        return send(422, { error: "no_match", message: NO_MATCH_MESSAGE });
      }
      const pass = await issue({ source: "form_customer", customer_id: c.customer_id });
      if (!pass) return send(503, { error: "voice support unavailable" });
      opts.log({ event: "call_pass_issued", source: "form_customer" });
      return send(200, { pass, expiresInSeconds: 300, firstName: firstNameOf(c.contact_name) });
    }
    if (body && typeof body === "object" && "mode" in body) return send(400, { error: "mode must be customer (with name and email) or guest" });
    return send(401, { error: "login required" });
  }
  req.resume();
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
  const { error: insertError } = await db.from("call_passes").insert({ pass_hash: sha256Hex(pass), source: "login", user_id: caller.userId, role: caller.role, customer_id: caller.customerId });
  if (insertError) {
    opts.log({ event: "call_pass_failed", code: insertError.code ?? null });
    return send(503, { error: "voice support unavailable" });
  }
  opts.log({ event: "call_pass_issued", user: shortHash(caller.userId), role: caller.role, mapped: caller.customerId !== null });
  send(200, { pass, expiresInSeconds: 300 });
}
