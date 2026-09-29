// Backend turn settings. Retrieval settings live in @relaypay/shared (config.ts).

export const AGENT_MODEL = "claude-haiku-4-5";

/** Agent SDK maxTurns: tool-use round trips per caller turn (checked after tools run, D18). */
export const AGENT_MAX_TURNS = 4;

/** Agent SDK maxBudgetUsd per caller turn. A typical turn is ~$0.005; this is ~10x headroom. */
export const AGENT_MAX_BUDGET_USD = 0.05;

/** The only tools the agent may have. init.tools must equal this list exactly (Task 4 step 4). */
export const ALLOWED_TOOLS: readonly string[] = ["mcp__relaypay__search_knowledge_base"];

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

/** Spoken when the gate blocks a reply. */
export const SAFE_DECLINE_LINE =
  "I'm sorry, I can't confirm that from our support information. I can connect you with a RelayPay support specialist if you'd like.";

/** Spoken on timeout or internal failure. */
export const FALLBACK_LINE = "Sorry, I'm having trouble checking that right now. Could you try again in a moment?";
