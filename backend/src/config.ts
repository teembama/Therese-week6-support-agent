// Backend turn settings. Retrieval settings live in @relaypay/shared (config.ts).

export const AGENT_MODEL = "claude-haiku-4-5";

/** Agent SDK maxTurns: tool-use round trips per caller turn (checked after tools run, D18). */
export const AGENT_MAX_TURNS = 4;

/** Agent SDK maxBudgetUsd per caller turn. A typical turn is ~$0.005; this is ~10x headroom. */
export const AGENT_MAX_BUDGET_USD = 0.05;

/**
 * MCP tools the AGENT may use. init.tools must equal this list exactly (tool-list guard).
 * search_knowledge_base is deliberately NOT here: retrieval is a guaranteed pre-turn step
 * owned by the backend (D20). The MCP server keeps the tool for Inspector/manual testing.
 * While this list is empty the MCP server is not attached to the agent at all.
 */
export const AGENT_MCP_TOOLS: readonly string[] = [];

/** Tools that must never appear in the agent's tool list; the guard fails the turn if they do. */
export const FORBIDDEN_AGENT_TOOLS: readonly string[] = ["mcp__relaypay__search_knowledge_base"];

/**
 * A latest caller message with fewer meaningful (non-stopword) words than this is treated as
 * a follow-up: retrieval searches the previous caller message plus the latest one.
 */
export const FOLLOW_UP_MIN_MEANINGFUL_WORDS = 5;

/**
 * Observability only, never blocks: implementation terms that should not reach the caller.
 * "document" is deliberately absent (verification documents are legitimate in this domain).
 */
export const STYLE_VIOLATION_TERMS: readonly string[] = [
  "knowledge base", "chunk", "retrieval", "retrieved", "context window", "system prompt",
];

// Timeouts can be shortened by env for tests (scripts/test-endpoint.ts) only; they cannot
// widen the tool allowlist or disable the gate.
function envMs(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

/** No spoken text within this long of receiving the request: speak FALLBACK_LINE. */
export const FIRST_TOKEN_TIMEOUT_MS = envMs("RELAYPAY_FIRST_TOKEN_TIMEOUT_MS", 8_000);

/** Absolute cap on one turn, from request receipt. The agent run is aborted at this point. */
export const TURN_HARD_CAP_MS = envMs("RELAYPAY_TURN_HARD_CAP_MS", 20_000);

/** The reply header must be complete within this many characters of the reply's start. */
export const HEADER_WINDOW_CHARS = 200;

export const MAX_BODY_BYTES = 1_000_000;

/**
 * Social replies (D31): the model only picks the intent via [[type=social; intent=...]]; the
 * backend speaks one of these fixed lines and discards any model text, so no free text is ever
 * spoken ungrounded.
 */
export const SOCIAL_LINES = {
  thanks: "You're welcome. Is there anything else I can help you with?",
  goodbye: "Thanks for calling RelayPay. Goodbye.",
  greeting: "Hello, how can I help you with RelayPay today?",
} as const;

/** Spoken when the gate blocks a reply. */
export const SAFE_DECLINE_LINE =
  "I'm sorry, I can't confirm that from our support information. I can connect you with a RelayPay support specialist if you'd like.";

/** Spoken on timeout or internal failure. */
export const FALLBACK_LINE = "Sorry, I'm having trouble checking that right now. Could you try again in a moment?";
