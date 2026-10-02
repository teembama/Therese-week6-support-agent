// GET /calls/:callId/records (D84): the references created on THIS call, for the page's
// "Your references" panel. Read-only.
//
// - Scoped to one conversation: conversation_id is Vapi's call.id, which only the caller's page
//   knows (an unguessable UUID from the Vapi SDK). Only UUID-shaped IDs reach the database, so
//   test/eval conversation IDs can't be read through this route.
// - Returns ONLY references: tickets {reference, category label, follow-up line} and escalations
//   {reference, linked ticket, callback preference as noted}. No customer data, emails, amounts,
//   summaries, reasons or statuses: the output is built from a whitelist, whatever the row holds.
// - An unknown or malformed call ID gets the same 200 and the same empty shape: no existence leak.
// - Rate-limited per client IP (fixed one-minute window); logged with a short hash of the call
//   ID, never the ID itself.

import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Db } from "@relaypay/shared";

export const FOLLOW_UP_LINE = "A RelayPay support representative will follow up.";
export const RECORDS_RATE_LIMIT_PER_MINUTE = 60; // polling every 3s is 20/minute
const ROUTE = /^\/calls\/([^/]{1,200})\/records$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const CATEGORY_LABELS: Record<string, string> = {
  payment: "Payment", payout: "Payout", invoice: "Invoice", account: "Account",
  compliance: "Compliance", dispute: "Dispute", other: "Other",
};

export interface TicketRecord { reference: string; category: string; follow_up: string }
export interface EscalationRecord { reference: string; linked_ticket: string; callback_preference: string | null }
export interface CallRecords {
  tickets: TicketRecord[];
  escalations: EscalationRecord[];
  /** L1b (D88): lookup_customer ran on this call (the page's guest nudge). No result details. */
  identity_checked: boolean;
}

export const EMPTY_RECORDS: CallRecords = { tickets: [], escalations: [], identity_checked: false };

/** The call ID in GET /calls/:callId/records, or null when the path isn't this route. */
export function matchRecordsRoute(method: string | undefined, pathname: string): string | null {
  if (method !== "GET") return null;
  const m = ROUTE.exec(pathname);
  if (!m) return null;
  try {
    return decodeURIComponent(m[1]!);
  } catch {
    return "";
  }
}

export const callHash = (callId: string) => createHash("sha256").update(callId).digest("hex").slice(0, 10);

/** The call's references. Unknown or malformed call ID: the empty shape (no database read for a malformed one). */
export async function readCallRecords(db: Db, callId: string): Promise<CallRecords> {
  if (!UUID.test(callId)) return { tickets: [], escalations: [], identity_checked: false };
  const [tickets, escalations, lookups] = await Promise.all([
    db.from("support_tickets").select("ticket_id, category, created_at").eq("conversation_id", callId).order("created_at"),
    db.from("escalations").select("escalation_id, ticket_id, preferred_time_text, created_at").eq("conversation_id", callId).order("created_at"),
    db.from("tool_calls").select("id", { count: "exact", head: true }).eq("conversation_id", callId).eq("tool_name", "lookup_customer"),
  ]);
  if (tickets.error) throw new Error(`support_tickets read failed (${tickets.error.code})`);
  if (escalations.error) throw new Error(`escalations read failed (${escalations.error.code})`);
  const escRows = (escalations.data ?? []) as Array<Record<string, unknown>>;
  // An escalation's own ticket is shown as its linked ticket, not as a separate entry.
  const linked = new Set(escRows.map((e) => String(e["ticket_id"])));
  return {
    tickets: ((tickets.data ?? []) as Array<Record<string, unknown>>)
      .filter((t) => !linked.has(String(t["ticket_id"])))
      .map((t) => ({
        reference: String(t["ticket_id"]),
        category: CATEGORY_LABELS[String(t["category"])] ?? "Other",
        follow_up: FOLLOW_UP_LINE,
      })),
    escalations: escRows.map((e) => ({
      reference: String(e["escalation_id"]),
      linked_ticket: String(e["ticket_id"]),
      callback_preference: typeof e["preferred_time_text"] === "string" && e["preferred_time_text"].trim() ? e["preferred_time_text"].trim().slice(0, 200) : null,
    })),
    identity_checked: !lookups.error && (lookups.count ?? 0) > 0,
  };
}

/** Fixed-window limiter per key (client IP). Old windows are dropped as they roll over. */
export function createRateLimiter(limit: number, windowMs = 60_000, now: () => number = Date.now) {
  const hits = new Map<string, { start: number; count: number }>();
  return (key: string): boolean => {
    const t = now();
    if (hits.size > 10_000) for (const [k, v] of hits) if (t - v.start >= windowMs) hits.delete(k);
    const h = hits.get(key);
    if (!h || t - h.start >= windowMs) {
      hits.set(key, { start: t, count: 1 });
      return true;
    }
    h.count++;
    return h.count <= limit;
  };
}

/** The client IP: the first X-Forwarded-For hop (Railway's proxy sets it), else the socket address. */
export function clientIp(req: IncomingMessage): string {
  const header = (name: string) => {
    const v = req.headers[name];
    return (Array.isArray(v) ? v[0] : v)?.split(",")[0]?.trim() || "";
  };
  const source = header("x-real-ip") ? "x-real-ip" : header("x-forwarded-for") ? "x-forwarded-for" : "socket";
  const raw = source === "socket" ? req.socket.remoteAddress ?? "" : header(source);
  if (!ipShapeLogged) {
    // D89: once per process, WHICH source keyed the limiter and its masked shape (no address).
    ipShapeLogged = true;
    console.log(JSON.stringify({ event: "client_ip_source", source, shape: raw.replace(/[0-9]/g, "9").replace(/[a-f]/gi, "x").slice(0, 60) }));
  }
  return normaliseIp(raw) || "unknown";
}
let ipShapeLogged = false;

/**
 * D89: the rate-limit key for an address. A port is dropped ("1.2.3.4:5678", "[::1]:5678"), an
 * IPv4-mapped IPv6 becomes IPv4, and IPv6 is grouped by its /64 (one household or phone network),
 * so a rotating port or IPv6 suffix can't bypass the limit (live test-callpass: 17 requests, no 429).
 */
export function normaliseIp(raw: string): string {
  let ip = raw.trim();
  const bracket = /^\[([^\]]+)\](?::\d+)?$/.exec(ip);
  if (bracket) ip = bracket[1]!;
  else if (/^\d{1,3}(?:\.\d{1,3}){3}:\d+$/.test(ip)) ip = ip.slice(0, ip.lastIndexOf(":"));
  ip = ip.replace(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i, "$1");
  if (ip.includes(":")) {
    const parts = ip.toLowerCase().split("::");
    const head = parts[0] ? parts[0].split(":") : [];
    const tail = parts.length > 1 && parts[1] ? parts[1].split(":") : [];
    const full = parts.length > 1 ? [...head, ...Array(Math.max(0, 8 - head.length - tail.length)).fill("0"), ...tail] : head;
    return `${full.slice(0, 4).map((h) => h || "0").join(":")}::/64`;
  }
  return ip;
}

export async function handleRecords(
  req: IncomingMessage,
  res: ServerResponse,
  db: Db,
  callId: string,
  opts: { allow: (key: string) => boolean; log: (e: Record<string, unknown>) => void; headers: Record<string, string> },
): Promise<void> {
  req.resume();
  const t0 = performance.now();
  const send = (status: number, body: unknown) => {
    res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store", ...opts.headers });
    res.end(JSON.stringify(body));
  };
  if (!opts.allow(clientIp(req))) {
    opts.log({ event: "records_rate_limited", call: callHash(callId) });
    return send(429, { error: "too many requests" });
  }
  try {
    const records = await readCallRecords(db, callId);
    opts.log({ event: "records_read", call: callHash(callId), tickets: records.tickets.length, escalations: records.escalations.length, ms: Math.round(performance.now() - t0) });
    send(200, records);
  } catch (err) {
    opts.log({ event: "records_read_failed", call: callHash(callId), message: err instanceof Error ? err.message.slice(0, 200) : "error" });
    send(503, { error: "records unavailable" });
  }
}
