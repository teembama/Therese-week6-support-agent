// Helpers shared by the Batch 2B tools. conversation_id / turn_index / attempt_id always come
// from ctx (the spawn environment, D9), never from tool input.

import { guardedRpc, summarize, type Db, type LogContext } from "@relaypay/shared";
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
  | "escalation_created" | "escalation_updated" | "ticket_created" | "declined_unsupported" | "gate_blocked" | "other";

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

/**
 * Best-effort event write (D68), for the events that RECORD a business action that already
 * committed (verification, ticket, escalation) or an outcome (identity failed). A failed event
 * write must never turn that action into a tool error: BEFORE eval (2026-10-01) saw the
 * verification commit, then the identity_verified write fail (fetch failed, 12.4 s), and the tool
 * report `error` - the model would tell the caller verification failed although it succeeded
 * (audit M5). The failure goes to stderr and is returned as a note for the tool_calls row.
 */
export async function logEventBestEffort(db: Db, ctx: LogContext, eventType: EventType, summary: string, metadata: Record<string, unknown> = {}): Promise<string> {
  try {
    await logEvent(db, ctx, eventType, summary, metadata);
    return "";
  } catch (err) {
    const message = summarize(err instanceof Error ? err.message : String(err), 200);
    console.error(`[relaypay-mcp] event ${eventType} not recorded for ${ctx.conversationId}#${ctx.turnIndex}: ${message}`);
    return `; event_write_failed (${eventType}): ${message}`;
  }
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

/**
 * Ownership rule (D44). A reference works as a bearer token only while no identity is
 * established. Once the conversation is verified, a record that belongs to another customer is
 * refused with exactly the same result as a reference that doesn't exist, so the answer never
 * confirms that the record exists and carries no status or summary.
 */
export function notAvailable(ref: string, detail: string): ToolOutcome {
  return {
    status: "denied",
    result: {
      found: false,
      reason: "not_available",
      message: "Details for this reference can't be shared on this call. Tell the caller you can't share details on that reference, and offer to connect them with a RelayPay specialist.",
    },
    resultSummary: `denied: not_available ${ref} (${detail})`,
  };
}

/** Record status as it may be spoken (D45): "review required" -> "under review". */
export function customerSafeStatus(status: string): string {
  return status === "review required" ? "under review" : status;
}

/**
 * A seed support_summary as it may be spoken (D45). Summaries that mention compliance or carry an
 * internal instruction ("Escalate account-specific questions.") are replaced by a plain status
 * sentence; the others pass through.
 */
export function customerSafeSummary(summary: string | null, kind: "transaction" | "payout", status: string): string | null {
  if (!summary) return null;
  if (!/compliance|escalate/i.test(summary)) return summary;
  return status === "review required" ? `The ${kind} is under review.` : `The ${kind} needs a specialist to look at it.`;
}

/** Today's date (UTC) as YYYY-MM-DD, for comparisons with DATE columns. */
export function todayUtc(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}
