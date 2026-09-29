// Conversation and turn persistence. The database is the source of truth for replay and for
// the set of chunk ids retrieved during a turn.

import type { Db, LogContext } from "@relaypay/shared";

export type AnswerType = "answer" | "clarify" | "escalate" | "decline" | "blocked" | "error";

export async function upsertConversation(
  db: Db,
  conversationId: string,
  channel: "voice" | "test",
  caller: string | null,
): Promise<void> {
  const { error } = await db
    .from("conversations")
    .upsert({ conversation_id: conversationId, channel, caller }, { onConflict: "conversation_id", ignoreDuplicates: true });
  if (error) throw new Error(`conversation upsert failed (${error.code}): ${error.message}`);
}

export interface StoredTurn {
  assistant_response: string | null;
  answer_type: AnswerType;
}

export async function findTurn(db: Db, ctx: LogContext): Promise<StoredTurn | null> {
  const { data, error } = await db
    .from("conversation_turns")
    .select("assistant_response, answer_type")
    .eq("conversation_id", ctx.conversationId)
    .eq("turn_index", ctx.turnIndex)
    .maybeSingle();
  if (error) throw new Error(`turn lookup failed (${error.code}): ${error.message}`);
  return (data as StoredTurn | null) ?? null;
}

export interface TurnRecord {
  userTranscript: string;
  assistantResponse: string | null;
  answerType: AnswerType;
  confidenceNote: string;
  kbChunkIds: string[];
  tReceived: string;
  msRetrieval: number | null;
  msFirstToken: number | null;
  msTools: number | null;
  msTotal: number | null;
  model: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheCreationTokens: number | null;
  costUsdEstimate: number | null;
  sdkDurationMs: number | null;
  sdkNumTurns: number | null;
}

/** Inserts the turn row. Returns false if a row for this turn already exists (another run won). */
export async function insertTurn(db: Db, ctx: LogContext, r: TurnRecord): Promise<boolean> {
  const { error } = await db.from("conversation_turns").insert({
    conversation_id: ctx.conversationId,
    turn_index: ctx.turnIndex,
    user_transcript: r.userTranscript,
    assistant_response: r.assistantResponse,
    answer_type: r.answerType,
    confidence_note: r.confidenceNote,
    kb_chunk_ids: r.kbChunkIds,
    t_received: r.tReceived,
    ms_retrieval: r.msRetrieval,
    ms_first_token: r.msFirstToken,
    ms_tools: r.msTools,
    ms_total: r.msTotal,
    model: r.model,
    input_tokens: r.inputTokens,
    output_tokens: r.outputTokens,
    cache_read_tokens: r.cacheReadTokens,
    cache_creation_tokens: r.cacheCreationTokens,
    cost_usd_estimate: r.costUsdEstimate,
    sdk_duration_ms: r.sdkDurationMs,
    sdk_num_turns: r.sdkNumTurns,
  });
  if (error?.code === "23505") return false;
  if (error) throw new Error(`turn insert failed (${error.code}): ${error.message}`);
  return true;
}

/**
 * Recomputes the conversation totals as SUM() over all its turns (never incremented), per the
 * column comments in migration 001. Summed in app code because PostgREST aggregates are off.
 */
export async function recomputeConversationTotals(db: Db, conversationId: string): Promise<void> {
  const { data, error } = await db
    .from("conversation_turns")
    .select("cost_usd_estimate, input_tokens, output_tokens")
    .eq("conversation_id", conversationId);
  if (error) throw new Error(`totals read failed (${error.code}): ${error.message}`);
  const rows = (data ?? []) as Array<{ cost_usd_estimate: string | number | null; input_tokens: number | null; output_tokens: number | null }>;
  const totals = rows.reduce(
    (t, r) => ({
      cost: t.cost + Number(r.cost_usd_estimate ?? 0),
      input: t.input + (r.input_tokens ?? 0),
      output: t.output + (r.output_tokens ?? 0),
    }),
    { cost: 0, input: 0, output: 0 },
  );
  const { error: updateError } = await db
    .from("conversations")
    .update({
      total_cost_usd: Number(totals.cost.toFixed(6)),
      total_input_tokens: totals.input,
      total_output_tokens: totals.output,
    })
    .eq("conversation_id", conversationId);
  if (updateError) throw new Error(`totals update failed (${updateError.code}): ${updateError.message}`);
}
