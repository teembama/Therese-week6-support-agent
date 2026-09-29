// One caller turn: pre-turn retrieval -> Agent SDK query -> grounding gate -> spoken stream,
// with first-token timeout, hard cap, client-disconnect abort, tool-list guard, and
// persistence of the turn row plus recomputed conversation totals.

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { query, type SDKMessage, type SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";
import { retrieveKnowledge, summarize, type Db, type LogContext } from "@relaypay/shared";
import { cliEnv, mcpEnv } from "./child-env.js";
import {
  AGENT_MAX_BUDGET_USD,
  AGENT_MAX_TURNS,
  AGENT_MODEL,
  ALLOWED_TOOLS,
  FALLBACK_LINE,
  FIRST_TOKEN_TIMEOUT_MS,
  SAFE_DECLINE_LINE,
  TURN_HARD_CAP_MS,
} from "./config.js";
import { evaluateReply, SegmentTracker, sentences } from "./gate.js";
import {
  insertTurn,
  recomputeConversationTotals,
  retrievedIdsForTurn,
  type AnswerType,
} from "./persistence.js";
import { buildTurnPrompt, SYSTEM_PROMPT, type HistoryEntry } from "./prompt.js";

const MCP_ENTRY =
  process.env["RELAYPAY_MCP_ENTRY"] ??
  resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "mcp-server", "dist", "main.js");

export interface TurnInput {
  db: Db;
  ctx: LogContext;
  userText: string;
  history: HistoryEntry[];
  /** performance.now() when the request arrived. */
  tReceivedMs: number;
  tReceivedIso: string;
}

export interface TurnSink {
  speak(text: string): void;
  end(): void;
  onClose(listener: () => void): void;
}

export interface TurnResult {
  /** What the caller heard; null if nothing was spoken (client gone). */
  spoken: string | null;
  answerType: AnswerType;
}

export interface TurnHandle {
  /** Resolves as soon as the spoken outcome is decided (used by in-flight duplicates). */
  decided: Promise<TurnResult>;
  /** Resolves once the turn row is written (or its write failed); from then on, replay. */
  persisted: Promise<void>;
  /** Resolves after the turn row and conversation totals are persisted. */
  done: Promise<void>;
}

function toolListProblem(m: Extract<SDKMessage, { type: "system"; subtype: "init" }>): string | null {
  const got = [...m.tools].sort();
  const want = [...ALLOWED_TOOLS].sort();
  if (JSON.stringify(got) !== JSON.stringify(want)) return `tools ${JSON.stringify(got)} != allowlist ${JSON.stringify(want)}`;
  const server = m.mcp_servers.find((s) => s.name === "relaypay");
  if (server?.status !== "connected") return `relaypay MCP server status ${server?.status ?? "missing"}`;
  return null;
}

function usageFrom(result: SDKResultMessage | null) {
  if (!result) {
    return { inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheCreationTokens: null, costUsdEstimate: null, sdkDurationMs: null, sdkNumTurns: null };
  }
  // modelUsage covers every model call of the query (main loop + auxiliary), unlike `usage` (D18).
  const models = Object.values(result.modelUsage);
  const sum = (pick: (u: (typeof models)[number]) => number) => models.reduce((t, u) => t + pick(u), 0);
  return {
    inputTokens: sum((u) => u.inputTokens),
    outputTokens: sum((u) => u.outputTokens),
    cacheReadTokens: sum((u) => u.cacheReadInputTokens),
    cacheCreationTokens: sum((u) => u.cacheCreationInputTokens),
    costUsdEstimate: result.total_cost_usd,
    sdkDurationMs: result.duration_ms,
    sdkNumTurns: result.num_turns,
  };
}

export function runTurn(input: TurnInput, sink: TurnSink): TurnHandle {
  let resolveDecided!: (r: TurnResult) => void;
  const decided = new Promise<TurnResult>((r) => (resolveDecided = r));
  let resolvePersisted!: () => void;
  const persisted = new Promise<void>((r) => (resolvePersisted = r));

  const done = (async () => {
    const notes: string[] = [];
    const abort = new AbortController();
    const elapsed = () => Math.round(performance.now() - input.tReceivedMs);
    // Latency breakdown (ms from request receipt), logged with the turn event.
    const marks: Record<string, number> = {};
    const mark = (name: string) => void (marks[name] ??= elapsed());
    let released: TurnResult | null = null;
    let msFirstToken: number | null = null;
    let msTotal: number | null = null;
    let kbChunkIds: string[] = [];

    const release = (spoken: string | null, answerType: AnswerType, note?: string) => {
      if (released) return;
      if (note) notes.push(note);
      released = { spoken, answerType };
      if (spoken !== null) {
        msFirstToken = elapsed();
        for (const s of sentences(spoken)) sink.speak(s);
      }
      sink.end();
      msTotal = elapsed();
      resolveDecided(released);
    };
    const stop = (reason: string) => {
      if (abort.signal.aborted) return;
      notes.push(`aborted: ${reason}`);
      abort.abort(new Error(reason));
    };

    const firstTokenTimer = setTimeout(() => {
      if (released) return;
      release(FALLBACK_LINE, "error", `timeout: no speakable reply within ${FIRST_TOKEN_TIMEOUT_MS}ms`);
      stop("first-token timeout");
    }, Math.max(0, FIRST_TOKEN_TIMEOUT_MS - elapsed()));
    const hardCapTimer = setTimeout(() => {
      stop(`hard cap ${TURN_HARD_CAP_MS}ms`);
      release(FALLBACK_LINE, "error");
    }, Math.max(0, TURN_HARD_CAP_MS - elapsed()));
    sink.onClose(() => {
      if (released) return;
      stop("client disconnected before any speech");
      release(null, "error");
    });

    const tracker = new SegmentTracker();
    const toolStarts = new Map<string, number>();
    let msRetrieval: number | null = null;
    let msTools = 0;
    let result: SDKResultMessage | null = null;

    try {
      const t = performance.now();
      const retrieval = await retrieveKnowledge(input.db, input.ctx, input.userText.slice(0, 1000));
      msRetrieval = Math.round(performance.now() - t);
      mark("retrieval_done");
      if (retrieval.insufficient_knowledge) notes.push("pre-turn retrieval: insufficient_knowledge");
      if (!retrieval.logged) notes.push("pre-turn retrieval_logs write FAILED (gate cannot see those chunks)");
      if (abort.signal.aborted) throw new Error("aborted before agent start");

      mark("query_start");
      const q = query({
        prompt: buildTurnPrompt(input.history, input.userText, retrieval.chunks),
        options: {
          model: AGENT_MODEL,
          systemPrompt: SYSTEM_PROMPT,
          tools: [],
          allowedTools: [...ALLOWED_TOOLS],
          permissionMode: "dontAsk",
          settingSources: [],
          strictMcpConfig: true,
          persistSession: false,
          maxTurns: AGENT_MAX_TURNS,
          maxBudgetUsd: AGENT_MAX_BUDGET_USD,
          thinking: { type: "disabled" },
          includePartialMessages: true,
          abortController: abort,
          env: cliEnv(),
          stderr: () => {},
          mcpServers: {
            relaypay: {
              type: "stdio",
              command: process.execPath,
              args: [MCP_ENTRY],
              env: mcpEnv(input.ctx),
              alwaysLoad: true,
            },
          },
        },
      });

      for await (const m of q) {
        if (m.type === "system" && m.subtype === "init") {
          mark("init");
          const problem = toolListProblem(m);
          if (problem) {
            notes.push(`tool-list guard: ${problem}`);
            release(FALLBACK_LINE, "error");
            stop("tool-list guard");
            break;
          }
        } else if (m.type === "stream_event" && m.parent_tool_use_id === null) {
          const e = m.event;
          if (e.type === "message_start") {
            mark("first_model_message");
            tracker.start();
          }
          else if (e.type === "content_block_start" && e.content_block.type === "tool_use") tracker.toolUseStart();
          else if (e.type === "content_block_delta" && e.delta.type === "text_delta") {
            mark("first_text_delta");
            tracker.textDelta(e.delta.text);
          }
          else if (e.type === "message_delta") tracker.messageDelta(e.delta.stop_reason);
          else if (e.type === "message_stop") {
            const segment = tracker.finish();
            if (segment) mark("final_message_stop");
            if (segment && !released) {
              const retrieved = await retrievedIdsForTurn(input.db, input.ctx);
              const verdict = evaluateReply(segment.text, retrieved);
              if (verdict.ok) {
                kbChunkIds = verdict.validKbIds;
                if (verdict.unknownKbIds.length) notes.push(`cited ids not retrieved: ${verdict.unknownKbIds.join(",")}`);
                if (segment.stopReason === "max_tokens") notes.push("final reply hit max_tokens");
                release(verdict.spoken, verdict.type);
              } else {
                release(SAFE_DECLINE_LINE, "blocked", `gate blocked: ${verdict.reason}; raw: ${summarize(segment.text, 300)}`);
              }
            }
          }
        } else if (m.type === "assistant" && m.parent_tool_use_id === null) {
          for (const block of m.message.content) {
            if (block.type === "tool_use") toolStarts.set(block.id, performance.now());
          }
        } else if (m.type === "user" && Array.isArray(m.message.content)) {
          for (const block of m.message.content) {
            if (typeof block === "object" && block !== null && "type" in block && block.type === "tool_result") {
              const started = toolStarts.get(block.tool_use_id);
              if (started !== undefined) msTools += performance.now() - started;
              toolStarts.delete(block.tool_use_id);
            }
          }
        } else if (m.type === "result") {
          mark("result");
          result = m;
        }
      }
    } catch (err) {
      // The SDK iterator throws after an error result (e.g. error_max_turns) and on abort.
      if (!abort.signal.aborted) notes.push(`agent error: ${summarize(err instanceof Error ? err.message : String(err), 300)}`);
    } finally {
      clearTimeout(firstTokenTimer);
      clearTimeout(hardCapTimer);
    }

    if (!released) {
      release(FALLBACK_LINE, "error", `no speakable final reply${result ? ` (result ${result.subtype})` : ""}`);
    }
    if (result && result.subtype !== "success") notes.push(`result subtype ${result.subtype}`);
    if (tracker.discarded.length) {
      notes.push(`discarded ${tracker.discarded.length} non-final segment(s): ${summarize(tracker.discarded.join(" | "), 200)}`);
    }

    const outcome = released as unknown as TurnResult; // set by release() above
    try {
      const inserted = await insertTurn(input.db, input.ctx, {
        userTranscript: input.userText,
        assistantResponse: outcome.spoken,
        answerType: outcome.answerType,
        confidenceNote: summarize(notes.join("; ") || "ok", 1000),
        kbChunkIds,
        tReceived: input.tReceivedIso,
        msRetrieval,
        msFirstToken,
        msTools: result || msTools ? Math.round(msTools) : null,
        msTotal,
        model: AGENT_MODEL,
        ...usageFrom(result),
      });
      resolvePersisted();
      if (!inserted) console.error(`[relaypay] turn ${input.ctx.conversationId}#${input.ctx.turnIndex} already persisted by another run`);
      await recomputeConversationTotals(input.db, input.ctx.conversationId);
    } catch (err) {
      resolvePersisted();
      console.error(`[relaypay] persistence failed for ${input.ctx.conversationId}#${input.ctx.turnIndex}: ${summarize(err instanceof Error ? err.message : String(err))}`);
    }
    console.log(JSON.stringify({
      event: "turn",
      conversation_id: input.ctx.conversationId,
      turn_index: input.ctx.turnIndex,
      answer_type: outcome.answerType,
      ms_first_token: msFirstToken,
      ms_total: msTotal,
      cost_usd_estimate: result?.total_cost_usd ?? null,
      aborted: abort.signal.aborted,
      marks: { ...marks, released: msFirstToken },
    }));
  })();

  return { decided, persisted, done };
}
