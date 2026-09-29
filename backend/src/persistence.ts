// Turn persistence through the migration-003 functions (D28). The database decides replay vs
// run and records every attempt; conversation totals are recomputed in SQL.

import type { Db } from "@relaypay/shared";

export type AnswerType = "answer" | "clarify" | "escalate" | "decline" | "blocked" | "error" | "social";
export type AttemptFinalStatus = "completed" | "aborted" | "failed";

export interface BeginAttemptInput {
  conversationId: string;
  channel: "voice" | "test";
  caller: string | null;
  turnIndex: number;
  attemptId: string;
  transcriptHash: string;
  userTranscript: string;
}

export type BeginAttemptResult =
  | { action: "replay"; assistantResponse: string; answerType: AnswerType }
  | { action: "run"; replacedAttemptIds: string[] };

/**
 * One round trip: upserts the conversation, then either returns the stored turn to replay
 * (it spoke something AND has the same transcript hash) or registers this attempt, replacing
 * any active attempt (or aborted one with a different transcript) for the same turn.
 */
export async function beginTurnAttempt(db: Db, a: BeginAttemptInput): Promise<BeginAttemptResult> {
  const { data, error } = await db.rpc("begin_turn_attempt", {
    p_conversation_id: a.conversationId,
    p_channel: a.channel,
    p_caller: a.caller,
    p_turn_index: a.turnIndex,
    p_attempt_id: a.attemptId,
    p_transcript_hash: a.transcriptHash,
    p_user_transcript: a.userTranscript,
  });
  if (error) throw new Error(`begin_turn_attempt failed (${error.code}): ${error.message}`);
  const row = (data as Array<{ action: string; assistant_response: string | null; answer_type: string | null; replaced_attempt_ids: string[] }>)[0];
  if (!row) throw new Error("begin_turn_attempt returned no row");
  if (row.action === "replay" && row.assistant_response) {
    return { action: "replay", assistantResponse: row.assistant_response, answerType: row.answer_type as AnswerType };
  }
  return { action: "run", replacedAttemptIds: row.replaced_attempt_ids ?? [] };
}

export interface AttemptMetrics {
  ms_retrieval: number | null;
  ms_first_token: number | null;
  ms_total: number | null;
  model: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read_tokens: number | null;
  cache_creation_tokens: number | null;
  cost_usd_estimate: number | null;
  sdk_duration_ms: number | null;
  sdk_num_turns: number | null;
}

export interface TurnRow extends AttemptMetrics {
  transcript_hash: string;
  user_transcript: string;
  assistant_response: string;
  answer_type: AnswerType;
  confidence_note: string;
  kb_chunk_ids: string[];
  t_received: string;
  ms_tools: number | null;
}

/**
 * Records the attempt's outcome and usage and returns its FINAL status (an attempt already
 * marked 'replaced' stays replaced). Only a completed attempt passes `turn`; the function then
 * stores it as the turn and recomputes the conversation totals.
 */
export async function finishTurnAttempt(
  db: Db,
  attemptId: string,
  status: AttemptFinalStatus,
  statusReason: string,
  metrics: AttemptMetrics,
  turn: TurnRow | null,
): Promise<string> {
  const { data, error } = await db.rpc("finish_turn_attempt", {
    p_attempt_id: attemptId,
    p_status: status,
    p_status_reason: statusReason,
    p_metrics: metrics,
    p_turn: turn,
  });
  if (error) throw new Error(`finish_turn_attempt failed (${error.code}): ${error.message}`);
  return String(data);
}
