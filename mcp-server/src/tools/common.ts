// Helpers shared by the Batch 2B tools. conversation_id / turn_index / attempt_id always come
// from ctx (the spawn environment, D9), never from tool input.

import { guardedRpc, type Db, type LogContext } from "@relaypay/shared";
import type * as z from "zod";
import type { ToolOutcome } from "../tool-logging.js";

/** Parses tool input; unknown keys are stripped (so a model-supplied customer_id is ignored). */
export function parseArgs<S extends z.ZodType>(
  schema: S,
  args: unknown,
  message: string,
): { ok: true; data: z.infer<S> } | { ok: false; outcome: ToolOutcome } {
  const parsed = schema.safeParse(args ?? {});
  if (parsed.success) return { ok: true, data: parsed.data };
  const issues = parsed.error.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`);
  return { ok: false, outcome: invalid(message, issues) };
}

export function invalid(message: string, issues: string[] = []): ToolOutcome {
  return {
    status: "invalid_input",
    result: { error: { code: "invalid_input", message, ...(issues.length ? { issues } : {}) } },
    resultSummary: `invalid_input: ${issues.length ? issues.join("; ") : message}`,
  };
}

/** The conversation's verified customer, read from the database (never from tool input). */
export async function verifiedCustomerId(db: Db, conversationId: string): Promise<string | null> {
  const { data, error } = await db.from("conversations").select("verified_customer_id").eq("conversation_id", conversationId).maybeSingle();
  if (error) throw new Error(`reading verified customer failed (${error.code}): ${error.message}`);
  return ((data as { verified_customer_id: string | null } | null)?.verified_customer_id) ?? null;
}

export type EventType =
  | "identity_verified" | "identity_failed" | "identity_ambiguous" | "lookup_performed" | "clarification_requested"
  | "escalation_created" | "ticket_created" | "declined_unsupported" | "gate_blocked" | "other";

/** Guarded event write (log_conversation_event_guarded); throws AttemptNotActiveError when superseded. */
export async function logEvent(db: Db, ctx: LogContext, eventType: EventType, summary: string, metadata: Record<string, unknown> = {}): Promise<number> {
  return guardedRpc<number>(db, "log_conversation_event_guarded", {
    p_conversation_id: ctx.conversationId,
    p_turn_index: ctx.turnIndex,
    p_event_type: eventType,
    p_summary: summary.slice(0, 500),
    p_metadata: metadata,
  }, ctx.attemptId);
}

// ---- Per-conversation write cap (decision 2, D43): at most 2 plain tickets and 1 escalation per
// conversation, counted from the database. An escalation's own linked ticket counts under the
// escalation limit, not the ticket limit. A repeat of an existing idempotency key is never
// capped: it creates nothing and returns the existing row.
export const CONVERSATION_TICKET_LIMIT = 2;
export const CONVERSATION_ESCALATION_LIMIT = 1;

export type WriteKind = "ticket" | "escalation";

/** True if creating a NEW row of this kind (key not yet used) would exceed the conversation's cap. */
export async function writeLimitReached(db: Db, conversationId: string, kind: WriteKind, idempotencyKey: string): Promise<{ reached: boolean; existing: number }> {
  const table = kind === "ticket" ? "support_tickets" : "escalations";
  const { data, error } = await db.from(table).select("idempotency_key").eq("conversation_id", conversationId).limit(1000);
  if (error) throw new Error(`${table} count failed (${error.code}): ${error.message}`);
  const keys = ((data ?? []) as Array<{ idempotency_key: string }>).map((r) => r.idempotency_key);
  if (keys.includes(idempotencyKey)) return { reached: false, existing: keys.length };
  const counted = kind === "ticket" ? keys.filter((k) => k.startsWith("ticket:")) : keys;
  const limit = kind === "ticket" ? CONVERSATION_TICKET_LIMIT : CONVERSATION_ESCALATION_LIMIT;
  return { reached: counted.length >= limit, existing: counted.length };
}

export function writeLimitOutcome(kind: WriteKind, existing: number): ToolOutcome {
  return {
    status: "denied",
    result: {
      created: false,
      reason: "conversation_write_limit",
      message: "The support team already has the details for this call. Tell the caller that; do not try to create another one.",
    },
    resultSummary: `denied: conversation_write_limit (${existing} ${kind === "ticket" ? "ticket(s)" : "escalation(s)"} already)`,
  };
}

// One MCP server serves one turn, and the model can issue parallel tool calls; running the write
// tools one at a time means two parallel creates can't both pass the count above.
let writeChain: Promise<unknown> = Promise.resolve();
export function serialised<T>(fn: () => Promise<T>): Promise<T> {
  const run = writeChain.then(fn, fn);
  writeChain = run.catch(() => undefined);
  return run;
}

/** Today's date (UTC) as YYYY-MM-DD, for comparisons with DATE columns. */
export function todayUtc(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}
