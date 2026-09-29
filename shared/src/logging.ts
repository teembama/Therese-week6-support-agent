// Log-table writers and the redaction applied to everything they store.
// Writers never throw: a failed log write is reported on stderr and returns false, so a
// logging problem can never break a tool call or a turn.

import { LOG_SUMMARY_MAX_CHARS } from "./config.js";
import type { Db } from "./supabase.js";

export type ToolCallStatus = "success" | "not_found" | "invalid_input" | "denied" | "error";

/** Identifies the turn being logged. Always supplied by the backend, never by the model (D9). */
export interface LogContext {
  conversationId: string;
  turnIndex: number;
  /** The turn attempt (migration 003, D28); set by the backend, never by the model. */
  attemptId?: string | undefined;
}

const SECRET_KEY_NAME = /(api[_-]?key|secret|token|password|authorization|service[_-]?role)/i;

const SECRET_PATTERNS: readonly RegExp[] = [
  /eyJ[\w-]+\.[\w-]+\.[\w-]+/g, // JWTs (Supabase legacy keys, access tokens)
  /sb_(?:secret|publishable)_[\w-]+/g, // Supabase new-style keys
  /sk-ant-[\w-]+/g, // Anthropic keys
  /Bearer\s+[\w.~+/=-]+/gi,
];

// Exact values of secrets this process knows about are always redacted, whatever their shape.
const SECRET_ENV_VARS = ["SUPABASE_SERVICE_ROLE_KEY", "ANTHROPIC_API_KEY", "VAPI_LLM_SECRET"] as const;

function redactString(text: string): string {
  let out = text;
  for (const name of SECRET_ENV_VARS) {
    const value = process.env[name];
    if (value && value.length >= 8) out = out.split(value).join("[redacted]");
  }
  for (const pattern of SECRET_PATTERNS) out = out.replace(pattern, "[redacted]");
  return out;
}

/** Deep copy with secret-named fields and secret-looking strings replaced by "[redacted]". */
export function redact(value: unknown): unknown {
  if (typeof value === "string") return redactString(value);
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, SECRET_KEY_NAME.test(k) ? "[redacted]" : redact(v)]),
    );
  }
  return value;
}

/** Redacted, length-capped one-line summary suitable for a log column. */
export function summarize(value: unknown, maxChars: number = LOG_SUMMARY_MAX_CHARS): string {
  let text: string;
  if (typeof value === "string") text = redactString(value);
  else {
    try {
      text = JSON.stringify(redact(value)) ?? String(value);
    } catch {
      text = "[unserializable]";
    }
  }
  text = text.replace(/\s+/g, " ").trim();
  if (text.length <= maxChars) return text;
  const suffix = `…(+${text.length - maxChars} chars)`;
  return text.slice(0, Math.max(0, maxChars - suffix.length)) + suffix;
}

function reportLogFailure(table: string, detail: string): void {
  console.error(`[relaypay] log write to ${table} failed: ${redactString(detail)}`);
}

async function insertLogRow(db: Db, table: string, row: Record<string, unknown>): Promise<boolean> {
  try {
    const { error } = await db.from(table).insert(row);
    if (error) {
      reportLogFailure(table, `${error.code ?? ""} ${error.message}`);
      return false;
    }
    return true;
  } catch (err) {
    reportLogFailure(table, err instanceof Error ? err.message : String(err));
    return false;
  }
}

export interface ToolCallLog {
  toolName: string;
  purpose: string;
  input: unknown;
  resultSummary: string;
  status: ToolCallStatus;
  errorMessage?: string | undefined;
  durationMs: number;
}

export function logToolCall(db: Db, ctx: LogContext, log: ToolCallLog): Promise<boolean> {
  return insertLogRow(db, "tool_calls", {
    conversation_id: ctx.conversationId,
    turn_index: ctx.turnIndex,
    ...(ctx.attemptId ? { attempt_id: ctx.attemptId } : {}),
    tool_name: log.toolName,
    purpose: log.purpose,
    input_summary: summarize(log.input),
    result_summary: summarize(log.resultSummary),
    status: log.status,
    error_message: log.errorMessage ? summarize(log.errorMessage) : null,
    duration_ms: Math.round(log.durationMs),
  });
}

export interface RetrievalLog {
  query: string;
  chunkIds: string[];
  sourceTitles: string[];
  sourceSummary: string;
  insufficientKnowledge: boolean;
}

export function logRetrieval(db: Db, ctx: LogContext, log: RetrievalLog): Promise<boolean> {
  return insertLogRow(db, "retrieval_logs", {
    conversation_id: ctx.conversationId,
    turn_index: ctx.turnIndex,
    ...(ctx.attemptId ? { attempt_id: ctx.attemptId } : {}),
    query: summarize(log.query),
    chunk_ids: log.chunkIds,
    source_titles: log.sourceTitles,
    source_summary: summarize(log.sourceSummary),
    insufficient_knowledge: log.insufficientKnowledge,
  });
}
