// Knowledge-base retrieval over kb_chunks via the search_kb SQL function (migration 002).
//
// The query is turned into an OR of meaningful lexemes (English stopwords and
// KB_EXCLUDED_WORDS removed) and ranked with ts_rank_cd, so natural questions match on any
// informative word instead of requiring every word (which websearch_to_tsquery would do).

import {
  KB_EXCLUDED_WORDS,
  KB_MATCH_COUNT,
  KB_MIN_RANK,
  KB_QUERY_SYNONYMS,
  KB_RANK_NORMALIZATION,
} from "./config.js";
import { logRetrieval, type LogContext } from "./logging.js";
import type { Db } from "./supabase.js";

export interface KbChunk {
  chunk_id: string;
  source_title: string;
  heading: string;
  content: string;
  rank: number;
}

export interface RankOptions {
  matchCount?: number;
  minRank?: number;
}

/** Appends KB_QUERY_SYNONYMS values for keys found as whole words in the query. */
export function expandQuery(query: string): string {
  const additions = Object.entries(KB_QUERY_SYNONYMS)
    .filter(([word]) => new RegExp(`\\b${word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(query))
    .map(([, synonym]) => synonym);
  return additions.length ? `${query} ${additions.join(" ")}` : query;
}

/** Ranked chunks for a query (synonyms applied), without logging. Throws on database errors. */
export async function rankKnowledge(db: Db, query: string, options: RankOptions = {}): Promise<KbChunk[]> {
  const { data, error } = await db.rpc("search_kb", {
    p_query: expandQuery(query),
    p_match_count: options.matchCount ?? KB_MATCH_COUNT,
    p_min_rank: options.minRank ?? KB_MIN_RANK,
    p_normalization: KB_RANK_NORMALIZATION,
    p_exclude_words: KB_EXCLUDED_WORDS,
  });
  if (error) throw new Error(`search_kb failed (${error.code}): ${error.message}`);
  return ((data ?? []) as KbChunk[]).map((c) => ({ ...c, rank: Number(c.rank) }));
}

export interface RetrievalResult {
  chunks: KbChunk[];
  insufficient_knowledge: boolean;
  /** False if the retrieval_logs row could not be written (details went to stderr). */
  logged: boolean;
}

/**
 * Retrieves the top KB_MATCH_COUNT chunks at or above KB_MIN_RANK and writes a
 * retrieval_logs row. insufficient_knowledge is true when no chunk qualifies.
 */
export async function retrieveKnowledge(db: Db, ctx: LogContext, query: string): Promise<RetrievalResult> {
  const chunks = await rankKnowledge(db, query);
  const insufficient = chunks.length === 0;
  const expanded = expandQuery(query);
  const sourceSummary =
    (expanded !== query ? `[searched as: ${expanded}] ` : "") +
    (insufficient
      ? `No chunk reached min rank ${KB_MIN_RANK}.`
      : `${chunks.length} chunk(s): ` + chunks.map((c) => `${c.heading} (${c.rank.toFixed(3)})`).join("; "));
  const logged = await logRetrieval(db, ctx, {
    query,
    chunkIds: chunks.map((c) => c.chunk_id),
    sourceTitles: chunks.map((c) => `${c.source_title} > ${c.heading}`),
    sourceSummary,
    insufficientKnowledge: insufficient,
  });
  return { chunks, insufficient_knowledge: insufficient, logged };
}
