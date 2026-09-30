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

/** Today's date (UTC) as YYYY-MM-DD, for comparisons with DATE columns. */
export function todayUtc(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}
