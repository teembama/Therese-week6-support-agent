// Tunable constants shared by the backend and the MCP server.

/** Maximum knowledge-base chunks returned for one query. */
export const KB_MATCH_COUNT = 4;

/**
 * Minimum ts_rank_cd score (with KB_RANK_NORMALIZATION, so 0..1) for a chunk to count as
 * relevant. If no chunk reaches it, retrieval reports insufficient_knowledge.
 * Evidence for the value: docs/retrieval-eval.md.
 */
export const KB_MIN_RANK = 0.1;

/**
 * ts_rank_cd normalization bitmask. 32 maps rank to rank / (rank + 1), which bounds it to 0..1
 * so the threshold above is stable as chunks change length.
 */
export const KB_RANK_NORMALIZATION = 32;

/**
 * Words that appear throughout the corpus and carry no signal for choosing a chunk. They are
 * stemmed with the same English config as the index and removed from the OR query.
 */
export const KB_EXCLUDED_WORDS: readonly string[] = ["relaypay"];

/** Maximum length of input/result summaries and error messages written to the log tables. */
export const LOG_SUMMARY_MAX_CHARS = 500;
