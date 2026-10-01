// Backend turn settings. Retrieval settings live in @relaypay/shared (config.ts).

// The agent model comes ONLY from the environment (D49; the choice is in docs/model-choice.md):
//   AGENT_MODEL           required, e.g. claude-haiku-4-5
//   AGENT_MODEL_FALLBACK  optional, e.g. claude-sonnet-5-5: used once per turn, only when the
//                         primary is reported unavailable / retired / not found (model_not_found)
const MODEL_ID = /^claude-[a-z0-9][a-z0-9.-]*$/;
function modelFromEnv(name: string, required: boolean): string | null {
  const value = process.env[name]?.trim() ?? "";
  if (!value) {
    if (required) throw new Error(`${name} is not set (see .env.example; docs/model-choice.md)`);
    return null;
  }
  if (!MODEL_ID.test(value)) throw new Error(`${name} is not a Claude model id: ${JSON.stringify(value.slice(0, 60))}`);
  return value;
}
export const AGENT_MODEL: string = modelFromEnv("AGENT_MODEL", true)!;
export const AGENT_MODEL_FALLBACK: string | null = modelFromEnv("AGENT_MODEL_FALLBACK", false);

/**
 * The fallback run is started only if at least this much of the first-token budget remains:
 * a fresh CLI + MCP start plus a model reply takes ~3 s (docs/latency.md).
 */
export const MODEL_FALLBACK_MIN_REMAINING_MS = 3_000;

/** Agent SDK maxTurns: tool-use round trips per caller turn (checked after tools run, D18). */
export const AGENT_MAX_TURNS = 4;

/** Agent SDK maxBudgetUsd per caller turn. A typical turn is ~$0.005; this is ~10x headroom. */
export const AGENT_MAX_BUDGET_USD = 0.05;

/** The six support tools the agent may call (Batch 2C). */
export const AGENT_TOOL_NAMES = [
  "lookup_customer", "lookup_transaction", "lookup_payout", "create_support_ticket", "create_escalation", "log_conversation_event",
] as const;
export type AgentToolName = (typeof AGENT_TOOL_NAMES)[number];

/** Lookup tools whose successful result can ground a type=answer (D41). */
export const LOOKUP_TOOL_NAMES: readonly AgentToolName[] = ["lookup_customer", "lookup_transaction", "lookup_payout"];

/** The Claude Code name of a tool on the relaypay MCP server. */
export const MCP_TOOL_PREFIX = "mcp__relaypay__";

/** Test-only (scripts/test-endpoint.ts --compare-mcp): run without the MCP server, for a latency baseline. */
export const TEST_DETACH_MCP = process.env["RELAYPAY_TEST_DETACH_MCP"] === "1";

/**
 * MCP tools the AGENT may use. init.tools must equal this list exactly (tool-list guard).
 * search_knowledge_base is deliberately NOT here: retrieval is a guaranteed pre-turn step
 * owned by the backend (D20). The backend spawns the MCP server with MCP_TOOLSET=agent, so the
 * server neither lists nor runs it; Inspector/manual runs keep the full set.
 */
export const AGENT_MCP_TOOLS: readonly string[] = TEST_DETACH_MCP ? [] : AGENT_TOOL_NAMES.map((n) => `${MCP_TOOL_PREFIX}${n}`);

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

function envCount(name: string, fallback: number): number {
  const raw = process.env[name];
  const n = raw === undefined || raw === "" ? fallback : Number(raw);
  if (!Number.isInteger(n) || n < 1) throw new Error(`${name} must be a positive integer (got "${raw}")`);
  return n;
}

/** No spoken text within this long of receiving the request: speak FALLBACK_LINE. */
export const FIRST_TOKEN_TIMEOUT_MS = envMs("RELAYPAY_FIRST_TOKEN_TIMEOUT_MS", 8_000);

/** Absolute cap on one turn, from request receipt. The agent run is aborted at this point. */
export const TURN_HARD_CAP_MS = envMs("RELAYPAY_TURN_HARD_CAP_MS", 20_000);

/**
 * Budget for the pre-turn database work (register the attempt + rank retrieval, in parallel),
 * including the Supabase client's one pre-connect retry (fix 6). If it is exceeded the caller
 * hears the fallback line and the attempt ends as 'failed' (D34). Keeps first audio within ~4s.
 */
export const PRETURN_DB_BUDGET_MS = 3_500;

/** Timeout for each background database call (recording, finishing attempts). */
export const DB_CALL_TIMEOUT_MS = 3_000;

/**
 * TEST-ONLY fault injection (scripts/test-endpoint.ts). Unset in production. Values:
 * throw_in_handler | throw_in_turn | unhandled_rejection | uncaught_exception.
 */
export const FAULT_INJECT = process.env["RELAYPAY_FAULT_INJECT"] ?? "";

/** The reply header must be complete within this many characters of the reply's start. */
export const HEADER_WINDOW_CHARS = 200;

export const MAX_BODY_BYTES = 1_000_000;

/** abandon_stale_conversations() cadence (D51). Test knob RELAYPAY_STALE_SWEEP_MS; default 5 minutes. */
export const STALE_SWEEP_INTERVAL_MS = envMs("RELAYPAY_STALE_SWEEP_MS", 5 * 60_000);

/** Vapi server messages: an end-of-call report carries the whole transcript and messages. */
export const EVENTS_MAX_BODY_BYTES = 10_000_000;

/**
 * Social replies (D31): the model only picks the intent via [[type=social; intent=...]]; the
 * backend speaks one of these fixed lines and discards any model text, so no free text is ever
 * spoken ungrounded.
 */
export const SOCIAL_LINES = {
  thanks: "You're welcome. Is there anything else I can help you with?",
  goodbye: "Thanks for calling RelayPay. Goodbye.",
  greeting: "Hello, how can I help you with RelayPay today?",
  /** The caller declined an offer (a ticket, a callback); NOT a goodbye. Asks "anything else?". */
  declined_offer: "No problem. Is there anything else I can help you with?",
} as const;

/** Conversation ids from our test and eval scripts are recorded as channel 'test', never 'voice'. */
export function channelFor(conversationId: string): "test" | "voice" {
  return conversationId.startsWith("test-") || conversationId.startsWith("eval-") ? "test" : "voice";
}

/** Spoken when the gate blocks a reply. */
export const SAFE_DECLINE_LINE =
  "I'm sorry, I can't confirm that from our support information. I can connect you with a RelayPay support specialist if you'd like.";

/** Spoken on timeout or internal failure. */
/**
 * Spoken by the BACKEND (never model text) when a lookup or write tool call starts and nothing
 * has been said yet in the turn; at most once per turn (Batch 2C step 5). Write tools are
 * included because a create_escalation turn otherwise hit the 8 s first-token timeout after the
 * escalation was created (test:agent S7, first run).
 */
export const FILLER_LINE = "One moment while I check that.";

/** Tools whose start triggers the filler line (not log_conversation_event, which is instant). */
export const FILLER_TOOL_NAMES: readonly string[] = ["lookup_customer", "lookup_transaction", "lookup_payout", "create_support_ticket", "create_escalation"];

/**
 * At most this many agent turns (a Claude CLI + MCP server each) run at once in this process
 * (audit H4, D59). Beyond it the backend speaks BUSY_LINE without spawning anything. Turns are
 * counted per conversation turn, so a speculative replacement of the same turn reuses its slot.
 * The social fast path is exempt.
 */
export const MAX_CONCURRENT_TURNS = envCount("RELAYPAY_MAX_CONCURRENT_TURNS", 3);

/** Spoken when the concurrency cap is reached, or while the process shuts down (D59, D60). */
export const BUSY_LINE = "We're getting a lot of calls right now. Please try again in a moment.";

/** SIGTERM: how long in-flight turns may take to finish before the process exits (D60). */
export const SHUTDOWN_GRACE_MS = envMs("RELAYPAY_SHUTDOWN_GRACE_MS", 10_000);

export const FALLBACK_LINE = "Sorry, I'm having trouble checking that right now. Could you try again in a moment?";
