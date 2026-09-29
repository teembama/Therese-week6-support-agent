// Tunable constants shared by the backend and the MCP server.

// Retrieval optimises for RECALL; the agent and the grounding gate handle PRECISION
// (docs/decisions.md D16). The rank threshold is a noise floor, not an off-topic detector.

/**
 * Maximum knowledge-base chunks returned for one query. Chunks are 7-82 words, so 6 costs
 * little context. Raised from 4 because S2's correct chunk ranked 6th (docs/retrieval-eval.md).
 */
export const KB_MATCH_COUNT = 6;

/**
 * Noise floor for ts_rank_cd scores (with KB_RANK_NORMALIZATION). Chunks below it are dropped;
 * if none remain, retrieval reports insufficient_knowledge. It is NOT an off-topic detector:
 * judging that retrieved chunks don't answer the question is the agent's job (D16).
 * The lowest judged-correct chunk in the eval is S2 at 0.0526. 0.05 kept it with only
 * 0.0026 margin, so the floor was lowered to 0.04 for margin (0.0126), recall-first (D16).
 * Re-run `npm run eval:retrieval` after any KB or retrieval change. Evidence:
 * docs/retrieval-eval.md.
 */
export const KB_MIN_RANK = 0.04;

/**
 * ts_rank_cd normalization bitmask: 2 (divide by the number of unique words in the chunk) |
 * 32 (rank / (rank + 1), bounded to 0..1). Chosen over 32 alone because it stops long,
 * general chunks that repeat a query word from outranking the specific answer
 * (docs/retrieval-eval.md).
 */
export const KB_RANK_NORMALIZATION = 34;

/**
 * Words that appear throughout the corpus and carry no signal for choosing a chunk. They are
 * stemmed with the same English config as the index and removed from the OR query.
 */
export const KB_EXCLUDED_WORDS: readonly string[] = ["relaypay"];

/**
 * Query-side synonyms, applied before search_kb: when a key appears as a whole word
 * (case-insensitive), its value is APPENDED to the query (the original word is kept, since
 * the OR query favours recall). Only add an entry that a failing eval case justifies, and
 * name that case in a comment. No speculative entries.
 */
export const KB_QUERY_SYNONYMS: Readonly<Record<string, string>> = {
  // X1 "do you support crypto wallets": the English stemmer keeps `crypto` and `cryptocurr`
  // apart, so the "Cryptocurrency payments" limitation chunk was never matched.
  crypto: "cryptocurrency",
};

/** Maximum length of input/result summaries and error messages written to the log tables. */
export const LOG_SUMMARY_MAX_CHARS = 500;
