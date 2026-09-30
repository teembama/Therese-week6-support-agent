// withToolLogging: every tool call, whatever its outcome, is timed and written to tool_calls.
// Handlers return a ToolOutcome instead of throwing; anything thrown anyway becomes a
// structured `error` result. A failed log write never changes the tool's result (the
// failure goes to stderr from the shared logger).

import { AttemptNotActiveError, logToolCall, summarize, type Db, type LogContext, type ToolCallStatus } from "@relaypay/shared";

export interface ToolDeps {
  db: Db;
  /** From the spawn environment, never from tool input (D9). */
  ctx: LogContext;
}

export interface ToolOutcome {
  status: ToolCallStatus;
  /** Structured result returned to the model. */
  result: Record<string, unknown>;
  /** Short log summary; defaults to a redacted summary of `result`. */
  resultSummary?: string;
  /** Internal detail for the log only; never sent to the model. */
  errorMessage?: string;
}

export interface ToolResult {
  [key: string]: unknown;
  content: Array<{ type: "text"; text: string }>;
  structuredContent: Record<string, unknown>;
  isError: boolean;
}

export type ToolHandler = (args: unknown, deps: ToolDeps) => Promise<ToolOutcome>;
export type LoggedTool = (args: unknown, deps: ToolDeps) => Promise<ToolResult>;

/** Statuses the model should treat as a failed call (it can retry with different input). */
const ERROR_STATUSES: ReadonlySet<ToolCallStatus> = new Set(["invalid_input", "error"]);

export function toToolResult(outcome: Pick<ToolOutcome, "status" | "result">): ToolResult {
  const structured = { status: outcome.status, ...outcome.result };
  return {
    content: [{ type: "text", text: JSON.stringify(structured) }],
    structuredContent: structured,
    isError: ERROR_STATUSES.has(outcome.status),
  };
}

export function withToolLogging(toolName: string, purpose: string, handler: ToolHandler): LoggedTool {
  return async (args, deps) => {
    const started = performance.now();
    let outcome: ToolOutcome;
    try {
      outcome = await handler(args, deps);
      if ("status" in outcome.result) {
        // "status" is the tool-call status the model reads; a record's own status must use a
        // prefixed key (transaction_status, ticket_status, ...) or it would silently replace it.
        outcome = {
          status: "error",
          result: { error: { code: "internal_error", message: "The tool failed unexpectedly. Do not retry; tell the caller you could not complete this step." } },
          errorMessage: `tool result uses the reserved key "status" (${summarize(outcome.result["status"], 40)})`,
        };
      }
    } catch (err) {
      outcome = {
        status: "error",
        result: { error: { code: "internal_error", message: "The tool failed unexpectedly. Do not retry; tell the caller you could not complete this step." } },
        errorMessage: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
      };
    }
    await logToolCall(deps.db, deps.ctx, {
      toolName,
      purpose,
      input: args,
      resultSummary: outcome.resultSummary ?? summarize(outcome.result),
      status: outcome.status,
      errorMessage: outcome.errorMessage,
      durationMs: performance.now() - started,
    });
    return toToolResult(outcome);
  };
}

/**
 * The shared write path (D28, D29). Every tool that writes (tickets, escalations, and any later
 * write tool) MUST be wrapped with this instead of withToolLogging, and MUST perform its write
 * with guardedRpc(db, fn, params, ctx.attemptId), which calls a Postgres function that checks
 * require_active_attempt(p_attempt_id) and writes in ONE transaction.
 * There is deliberately NO pre-check here: a separate "is it active?" call followed by the
 * write would leave a window in which the attempt is replaced. When the database refuses
 * (P0001 ATTEMPT_NOT_ACTIVE -> AttemptNotActiveError), the tool result is status 'denied' and
 * nothing was written.
 * Why: Vapi fires speculative requests on partial transcripts and abort is not immediate, so a
 * replaced attempt could otherwise still create a ticket or escalation from a half-heard turn.
 */
export function withWriteToolLogging(toolName: string, purpose: string, handler: ToolHandler): LoggedTool {
  return withToolLogging(toolName, purpose, async (args, deps) => {
    try {
      return await handler(args, deps);
    } catch (err) {
      if (err instanceof AttemptNotActiveError) {
        return {
          status: "denied",
          result: { error: { code: "attempt_not_active", message: "This request was superseded by a newer one. Nothing was written. Do not retry." } },
          resultSummary: `denied: attempt ${deps.ctx.attemptId ?? "(none)"} is not active`,
          errorMessage: err.message,
        };
      }
      throw err; // withToolLogging turns it into a structured 'error' result
    }
  });
}
