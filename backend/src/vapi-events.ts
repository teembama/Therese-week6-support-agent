// Vapi server messages (Batch 2D step 1, D50): POST /v/:token/vapi/events.
//
// Only `end-of-call-report` is handled; every other message type gets 200 and is ignored. The
// report closes our conversation row: ended_at, ended_reason, final_status, Vapi's performance
// metrics (vapi_metrics) and a DETERMINISTIC summary built from our own records (never Vapi's
// summary or an LLM: it can't hallucinate and costs nothing). Idempotent by call.id: a repeated
// delivery writes the same values. The transcript and messages are never stored or logged.
//
// Payload shape: the OpenAPI schema ServerMessageEndOfCallReport (https://api.vapi.ai/api-json),
// { message: { type, endedReason, startedAt, endedAt, cost, call: { id }, artifact: {
//   performanceMetrics: { turnLatencies[], modelLatencyAverage, ... } } } }.

import type { Db } from "@relaypay/shared";
import { channelFor } from "./config.js";

export type FinalStatus = "completed" | "failed";

// Normal endings (https://docs.vapi.ai/calls/call-ended-reason). Timeouts are normal endings of a
// call that worked; media problems on the caller's side and every pipeline/provider error fail.
const NORMAL_ENDINGS = new Set([
  "customer-ended-call", "assistant-ended-call", "assistant-ended-call-after-message-spoken",
  "assistant-ended-call-with-hangup-task", "assistant-said-end-call-phrase", "assistant-forwarded-call",
  "manually-canceled", "voicemail", "call-deleted", "silence-timed-out", "exceeded-max-duration",
]);

/**
 * final_status for a call. With no answered turn the call failed (no_interaction, D61) whatever
 * Vapi's endedReason says: a silence timeout or a hang-up before any answer is not a completed
 * support call. Otherwise anything not known to be a normal ending counts as failed.
 */
export function finalStatusFor(endedReason: string | null | undefined, answeredTurns: number): FinalStatus {
  if (answeredTurns === 0) return "failed";
  return endedReason && NORMAL_ENDINGS.has(endedReason) ? "completed" : "failed";
}

/**
 * A turn the caller got a real reply to: something was spoken and it wasn't an error line
 * (fallback or busy). A blocked turn counts: the safe decline line was spoken (D61).
 */
export function isAnswered(turn: { answer_type: string; assistant_response: string | null }): boolean {
  return turn.answer_type !== "error" && turn.assistant_response !== null;
}

/** The subset of Vapi's report we keep: latency metrics, cost and duration (no transcript). */
export function vapiMetricsFrom(message: Record<string, unknown>): Record<string, unknown> {
  const artifact = (message["artifact"] ?? {}) as Record<string, unknown>;
  const pm = (artifact["performanceMetrics"] ?? null) as Record<string, unknown> | null;
  const started = typeof message["startedAt"] === "string" ? Date.parse(message["startedAt"]) : NaN;
  const ended = typeof message["endedAt"] === "string" ? Date.parse(message["endedAt"]) : NaN;
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  const keep = ["modelLatencyAverage", "voiceLatencyAverage", "transcriberLatencyAverage", "endpointingLatencyAverage", "turnLatencyAverage", "fromTransportLatencyAverage", "toTransportLatencyAverage", "numUserInterrupted", "numAssistantInterrupted"];
  return {
    cost_usd: num(message["cost"]),
    duration_seconds: Number.isFinite(started) && Number.isFinite(ended) ? Math.round((ended - started) / 100) / 10 : null,
    performance_metrics: pm
      ? {
          ...Object.fromEntries(keep.map((k) => [k, num(pm[k])])),
          turnLatencies: Array.isArray(pm["turnLatencies"])
            ? (pm["turnLatencies"] as Array<Record<string, unknown>>).slice(0, 200).map((t) => ({
                modelLatency: num(t["modelLatency"]), voiceLatency: num(t["voiceLatency"]), transcriberLatency: num(t["transcriberLatency"]),
                endpointingLatency: num(t["endpointingLatency"]), turnLatency: num(t["turnLatency"]),
              }))
            : [],
        }
      : null,
  };
}

export interface SummaryFacts {
  turns: number;
  /** Turns with a real reply (isAnswered). */
  answered: number;
  answerTypes: Record<string, number>;
  tickets: string[]; // categories
  escalations: string[]; // categories
  identity: "verified" | "not verified" | "not attempted";
  endedReason: string | null;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** The deterministic summary. Same facts in, same text out. No names, emails or transcript. */
export function buildSummary(f: SummaryFacts): string {
  const types = Object.entries(f.answerTypes).sort(([a], [b]) => a.localeCompare(b)).map(([t, n]) => `${t} ${n}`).join(", ");
  const list = (xs: string[]) => (xs.length ? ` (${[...xs].sort().join(", ")})` : "");
  return [
    `${plural(f.turns, "turn")}${types ? ` (${types})` : ""}.`,
    `Identity: ${f.identity}.`,
    `Tickets: ${f.tickets.length}${list(f.tickets)}.`,
    `Escalations: ${f.escalations.length}${list(f.escalations)}.`,
    `Ended: ${f.endedReason ?? "unknown"}.`,
    ...(f.answered === 0 ? ["No interaction: no answered turn."] : []),
  ].join(" ");
}

async function summaryFacts(db: Db, conversationId: string, endedReason: string | null): Promise<SummaryFacts> {
  const [turns, tickets, escalations, events] = await Promise.all([
    db.from("conversation_turns").select("answer_type, assistant_response").eq("conversation_id", conversationId),
    db.from("support_tickets").select("category, idempotency_key").eq("conversation_id", conversationId),
    db.from("escalations").select("category").eq("conversation_id", conversationId),
    db.from("conversation_events").select("event_type").eq("conversation_id", conversationId).in("event_type", ["identity_verified", "identity_failed", "identity_ambiguous"]),
  ]);
  for (const r of [turns, tickets, escalations, events]) if (r.error) throw new Error(`summary read failed (${r.error.code}): ${r.error.message}`);
  const answerTypes: Record<string, number> = {};
  const turnRows = (turns.data ?? []) as Array<{ answer_type: string; assistant_response: string | null }>;
  for (const t of turnRows) answerTypes[t.answer_type] = (answerTypes[t.answer_type] ?? 0) + 1;
  const eventTypes = ((events.data ?? []) as Array<{ event_type: string }>).map((e) => e.event_type);
  return {
    turns: turnRows.length,
    answered: turnRows.filter(isAnswered).length,
    answerTypes,
    // Plain tickets only; an escalation's own ticket is counted under escalations.
    tickets: ((tickets.data ?? []) as Array<{ category: string; idempotency_key: string }>).filter((t) => t.idempotency_key.startsWith("ticket:")).map((t) => t.category),
    escalations: ((escalations.data ?? []) as Array<{ category: string }>).map((e) => e.category),
    identity: eventTypes.includes("identity_verified") ? "verified" : eventTypes.length ? "not verified" : "not attempted",
    endedReason,
  };
}

export type EventOutcome =
  | { kind: "ignored"; type: string }
  | { kind: "end_of_call"; conversationId: string; message: Record<string, unknown> };

/** Classifies a parsed server message body; never throws. */
export function classifyEvent(json: unknown): EventOutcome {
  const message = (json && typeof json === "object" ? (json as Record<string, unknown>)["message"] : null) as Record<string, unknown> | null;
  const type = typeof message?.["type"] === "string" ? (message["type"] as string).slice(0, 60) : "(none)";
  if (type !== "end-of-call-report") return { kind: "ignored", type };
  const call = (message!["call"] ?? {}) as Record<string, unknown>;
  const id = typeof call["id"] === "string" ? call["id"].trim() : "";
  if (!id || id.length > 200) return { kind: "ignored", type: "end-of-call-report (no call.id)" };
  return { kind: "end_of_call", conversationId: id, message: message! };
}

/** Records one end-of-call report. Idempotent: the same report always writes the same row values. */
export async function recordEndOfCall(db: Db, conversationId: string, message: Record<string, unknown>): Promise<{ finalStatus: FinalStatus; summary: string; created: boolean }> {
  const endedReason = typeof message["endedReason"] === "string" ? message["endedReason"].slice(0, 200) : null;
  const endedAt = typeof message["endedAt"] === "string" && Number.isFinite(Date.parse(message["endedAt"])) ? new Date(message["endedAt"]).toISOString() : new Date().toISOString();
  const startedAt = typeof message["startedAt"] === "string" && Number.isFinite(Date.parse(message["startedAt"])) ? new Date(message["startedAt"]).toISOString() : null;

  // A call can end without ever reaching the LLM (no turn, so no conversation row yet).
  const { data: existing, error: readError } = await db.from("conversations").select("conversation_id").eq("conversation_id", conversationId).maybeSingle();
  if (readError) throw new Error(`conversation read failed (${readError.code}): ${readError.message}`);
  let created = false;
  if (!existing) {
    const { error } = await db.from("conversations").upsert(
      { conversation_id: conversationId, channel: channelFor(conversationId), ...(startedAt ? { started_at: startedAt } : {}) },
      { onConflict: "conversation_id", ignoreDuplicates: true },
    );
    if (error) throw new Error(`conversation insert failed (${error.code}): ${error.message}`);
    created = true;
  }

  const facts = await summaryFacts(db, conversationId, endedReason);
  const finalStatus = finalStatusFor(endedReason, facts.answered);
  const summary = buildSummary(facts);
  const { error: updateError } = await db.from("conversations").update({
    ended_at: endedAt,
    ended_reason: endedReason,
    final_status: finalStatus,
    vapi_metrics: vapiMetricsFrom(message),
    summary,
  }).eq("conversation_id", conversationId);
  if (updateError) throw new Error(`conversation update failed (${updateError.code}): ${updateError.message}`);
  const { error: totalsError } = await db.rpc("recompute_conversation_totals", { p_conversation_id: conversationId });
  if (totalsError) throw new Error(`recompute_conversation_totals failed (${totalsError.code}): ${totalsError.message}`);
  return { finalStatus, summary, created };
}
