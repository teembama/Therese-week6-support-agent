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
export interface CallRecords { tickets: TicketRecord[]; escalations: EscalationRecord[] }

export const EMPTY_RECORDS: CallRecords = { tickets: [], escalations: [] };

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
  if (!UUID.test(callId)) return { tickets: [], escalations: [] };
  const [tickets, escalations] = await Promise.all([
    db.from("support_tickets").select("ticket_id, category, created_at").eq("conversation_id", callId).order("created_at"),
    db.from("escalations").select("escalation_id, ticket_id, preferred_time_text, created_at").eq("conversation_id", callId).order("created_at"),
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
  const xff = req.headers["x-forwarded-for"];
  const first = (Array.isArray(xff) ? xff[0] : xff)?.split(",")[0]?.trim();
  return first || req.socket.remoteAddress || "unknown";
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
