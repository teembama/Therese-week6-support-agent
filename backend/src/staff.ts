// Staff dashboard API (L2, D87): GET /staff/records?type=tickets|callbacks. Flag
// STAFF_DASHBOARD_ENABLED (404 while off). Read-only.
//
// - Authorization: Bearer <Supabase access token>. The token is verified with Supabase Auth
//   (never trusted from the browser) and app_metadata.role must be "staff" (users can't edit
//   app_metadata): 401 for no/invalid session, 403 for any other role. Rate-limited per client IP.
// - tickets ("raised tickets"): support tickets NOT linked to an escalation, newest first.
//   callbacks ("scheduled callbacks"): escalations with a callback requested (call_booked true).
// - Test conversations (channel 'test': test:tools, the eval runner) are excluded unless
//   ?include_test=1.
// - Output is built from a whitelist: never support notes, never amounts (an amount inside a
//   free-text summary or reason is masked, as in the Discord messages).
// - Logs carry a short hash of the staff user ID only.

import type { IncomingMessage, ServerResponse } from "node:http";
import type { Db } from "@relaypay/shared";
import { maskAmounts } from "./discord-notify.js";
import { bearerToken, sha256Hex } from "./login.js";
import { clientIp } from "./records.js";

export const STAFF_RATE_LIMIT_PER_MINUTE = 60;
export const STAFF_PAGE_SIZE = 100;

export type StaffRecordType = "tickets" | "callbacks";

export interface StaffTicket {
  ticket_id: string;
  category: string;
  priority: string;
  status: string;
  customer_id: string | null;
  summary: string;
  created_at: string;
  channel: string | null;
}

export interface StaffCallback {
  escalation_id: string;
  ticket_id: string;
  category: string;
  customer_id: string | null;
  user_name: string;
  user_email: string;
  preferred_time_text: string | null;
  /** D97: the booked slot (ISO). */
  callback_slot: string | null;
  status: string;
  reason: string;
  created_at: string;
  channel: string | null;
}

type Row = Record<string, unknown>;
const str = (v: unknown) => (typeof v === "string" ? v : v === null || v === undefined ? "" : String(v));
const strOrNull = (v: unknown) => (typeof v === "string" && v.trim() ? v : null);
const channelOf = (r: Row) => {
  const c = r["conversations"] as { channel?: unknown } | Array<{ channel?: unknown }> | null | undefined;
  const one = Array.isArray(c) ? c[0] : c;
  return typeof one?.channel === "string" ? one.channel : null;
};

/** Parses ?type= and ?include_test=; null type when invalid. */
export function parseStaffQuery(url: string): { type: StaffRecordType | null; includeTest: boolean } {
  let params: URLSearchParams;
  try {
    params = new URL(url, "http://x").searchParams;
  } catch {
    return { type: null, includeTest: false };
  }
  const t = params.get("type");
  return { type: t === "tickets" || t === "callbacks" ? t : null, includeTest: params.get("include_test") === "1" };
}

export function toStaffTicket(r: Row): StaffTicket {
  return {
    ticket_id: str(r["ticket_id"]),
    category: str(r["category"]),
    priority: str(r["priority"]),
    status: str(r["status"]),
    customer_id: strOrNull(r["customer_id"]),
    summary: maskAmounts(str(r["summary"])).slice(0, 1000),
    created_at: str(r["created_at"]),
    channel: channelOf(r),
  };
}

export function toStaffCallback(r: Row): StaffCallback {
  return {
    escalation_id: str(r["escalation_id"]),
    ticket_id: str(r["ticket_id"]),
    category: str(r["category"]),
    customer_id: strOrNull(r["customer_id"]),
    user_name: str(r["user_name"]),
    user_email: str(r["user_email"]),
    preferred_time_text: strOrNull(r["preferred_time_text"]),
    callback_slot: strOrNull(r["callback_slot"]),
    status: str(r["status"]),
    reason: maskAmounts(str(r["reason"])).slice(0, 1000),
    created_at: str(r["created_at"]),
    channel: channelOf(r),
  };
}

/** Reads one filter's records. Throws on a database error. */
export async function readStaffRecords(db: Db, type: StaffRecordType, includeTest: boolean): Promise<StaffTicket[] | StaffCallback[]> {
  if (type === "tickets") {
    let q = db.from("support_tickets")
      .select("ticket_id, category, priority, status, customer_id, summary, created_at, conversations!inner(channel)");
    if (!includeTest) q = q.neq("conversations.channel", "test");
    const { data, error } = await q.order("created_at", { ascending: false }).limit(STAFF_PAGE_SIZE * 2);
    if (error) throw new Error(`support_tickets read failed (${error.code})`);
    const rows = (data ?? []) as Row[];
    const ids = rows.map((r) => str(r["ticket_id"]));
    let linked = new Set<string>();
    if (ids.length) {
      const esc = await db.from("escalations").select("ticket_id").in("ticket_id", ids);
      if (esc.error) throw new Error(`escalations read failed (${esc.error.code})`);
      linked = new Set(((esc.data ?? []) as Row[]).map((e) => str(e["ticket_id"])));
    }
    return rows.filter((r) => !linked.has(str(r["ticket_id"]))).slice(0, STAFF_PAGE_SIZE).map(toStaffTicket);
  }
  let q = db.from("escalations")
    .select("escalation_id, ticket_id, category, customer_id, user_name, user_email, preferred_time_text, callback_slot, status, reason, created_at, conversations!inner(channel)")
    .not("callback_slot", "is", null); // D97: booked slots only
  if (!includeTest) q = q.neq("conversations.channel", "test");
  const { data, error } = await q.order("callback_slot", { ascending: true }).limit(STAFF_PAGE_SIZE); // by slot time
  if (error) throw new Error(`escalations read failed (${error.code})`);
  return ((data ?? []) as Row[]).map(toStaffCallback);
}

/** GET /staff/records. */
export async function handleStaffRecords(
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
    opts.log({ event: "staff_rate_limited" });
    return send(429, { error: "too many requests" });
  }
  const token = bearerToken(req);
  if (!token) return send(401, { error: "login required" });
  const { data, error } = await db.auth.getUser(token);
  const user = data?.user;
  if (error || !user) {
    opts.log({ event: "staff_denied", reason: "invalid or expired session" });
    return send(401, { error: "login required" });
  }
  if (user.app_metadata?.["role"] !== "staff") {
    opts.log({ event: "staff_denied", reason: "not staff", user: sha256Hex(user.id).slice(0, 10) });
    return send(403, { error: "not staff" });
  }
  const { type, includeTest } = parseStaffQuery(req.url ?? "");
  if (!type) return send(400, { error: "type must be tickets or callbacks" });
  const t0 = performance.now();
  try {
    const records = await readStaffRecords(db, type, includeTest);
    opts.log({ event: "staff_records", user: sha256Hex(user.id).slice(0, 10), type, include_test: includeTest, count: records.length, ms: Math.round(performance.now() - t0) });
    send(200, { type, includeTest, records });
  } catch (err) {
    opts.log({ event: "staff_records_failed", type, message: err instanceof Error ? err.message.slice(0, 200) : "error" });
    send(503, { error: "records unavailable" });
  }
}

/**
 * D98: POST /staff/records/close {type: "ticket" | "escalation", id}. Signed-in staff only (the
 * token is verified with Supabase; app_metadata.role must be "staff"): 401 / 403 otherwise.
 * Sets status 'closed' (closing an escalation frees its callback slot, migration 009's partial
 * unique index) and records WHO closed it and WHEN as a conversation_events row ("other",
 * metadata.action = "closed"). Idempotent: an already closed item returns closed: false.
 */
export async function handleStaffClose(
  req: IncomingMessage,
  res: ServerResponse,
  db: Db,
  opts: { allow: (key: string) => boolean; log: (e: Record<string, unknown>) => void; headers: Record<string, string> },
): Promise<void> {
  const send = (status: number, body: unknown) => {
    res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store", ...opts.headers });
    res.end(JSON.stringify(body));
  };
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > 2048) break;
    chunks.push(c as Buffer);
  }
  if (!opts.allow(clientIp(req))) return send(429, { error: "too many requests" });
  const token = bearerToken(req);
  if (!token) return send(401, { error: "login required" });
  const { data, error } = await db.auth.getUser(token);
  const user = data?.user;
  if (error || !user) return send(401, { error: "login required" });
  if (user.app_metadata?.["role"] !== "staff") {
    opts.log({ event: "staff_close_denied", reason: "not staff", user: sha256Hex(user.id).slice(0, 10) });
    return send(403, { error: "not staff" });
  }
  let body: { type?: unknown; id?: unknown } | null = null;
  try {
    body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { type?: unknown; id?: unknown };
  } catch {
    body = null;
  }
  const type = body?.type === "ticket" || body?.type === "escalation" ? body.type : null;
  const id = typeof body?.id === "string" && /^(TKT|ESC)-[0-9A-F]{8}$/.test(body.id) ? body.id : null;
  if (!type || !id || (type === "ticket") !== id.startsWith("TKT-")) return send(400, { error: "type must be ticket or escalation, with its id" });
  const table = type === "ticket" ? "support_tickets" : "escalations";
  const key = type === "ticket" ? "ticket_id" : "escalation_id";
  const { data: row, error: readError } = await db.from(table).select(`${key}, conversation_id, status`).eq(key, id).maybeSingle();
  if (readError) return send(503, { error: "unavailable" });
  if (!row) return send(404, { error: "not found" });
  const r = row as Record<string, string>;
  if (r["status"] === "closed") return send(200, { id, status: "closed", closed: false });
  const closedAt = new Date().toISOString();
  const { error: updateError } = await db.from(table).update({ status: "closed" }).eq(key, id).neq("status", "closed");
  if (updateError) return send(503, { error: "unavailable" });
  const { error: eventError } = await db.from("conversation_events").insert({
    conversation_id: r["conversation_id"], turn_index: 0, event_type: "other",
    summary: `${id} closed by staff ${user.email ?? user.id} at ${closedAt}`.slice(0, 500),
    metadata: { action: "closed", ref: id, closed_by: user.email ?? null, closed_by_user: user.id, closed_at: closedAt },
  });
  opts.log({ event: "staff_closed", ref: id, user: sha256Hex(user.id).slice(0, 10), audit_written: !eventError });
  send(200, { id, status: "closed", closed: true, closed_at: closedAt, closed_by: user.email ?? null });
}
