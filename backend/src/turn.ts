// One caller turn, from request receipt to persisted row.
//
// Lifecycle (lever 3, docs/latency.md):
//   1. Timers start from request receipt, so the first-token timeout also covers DB work.
//   2. query() starts immediately in streaming-input mode, so the Claude Code CLI boots while
//      the backend does its independent DB work IN PARALLEL: conversation upsert, existing-turn
//      check, and pre-turn retrieval (ranking only).
//   3. Existing turn row -> the input stream is closed without a message, the query is
//      aborted, and the stored response is replayed. No agent run, no new rows.
//   4. Otherwise the retrieval_logs row is written, and the user message (prompt with chunks) is
//      yielded to the waiting CLI. The gate checks the reply against the in-memory retrieved set.
// Plus: hard cap, client-disconnect abort, tool-list guard, persistence + recomputed totals.

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { query, type SDKResultMessage, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { logRetrievalResult, rankKnowledge, summarize, type Db, type KbChunk, type LogContext } from "@relaypay/shared";
import { cliEnv, mcpEnv } from "./child-env.js";
import {
  AGENT_MAX_BUDGET_USD,
  AGENT_MAX_TURNS,
  AGENT_MCP_TOOLS,
  AGENT_MODEL,
  FALLBACK_LINE,
  FIRST_TOKEN_TIMEOUT_MS,
  FORBIDDEN_AGENT_TOOLS,
  SAFE_DECLINE_LINE,
  TURN_HARD_CAP_MS,
} from "./config.js";
import { sentences, StreamingGate } from "./gate.js";
import { findTurn, insertTurn, recomputeConversationTotals, upsertConversation, type AnswerType } from "./persistence.js";
import { buildTurnPrompt, SYSTEM_PROMPT, type HistoryEntry } from "./prompt.js";
import { buildRetrievalQuery } from "./retrieval-query.js";
import type { TurnSource } from "./sse.js";
import { styleViolations } from "./style.js";

// Test knob: attach the MCP server even though the agent allowlist is empty, so the endpoint
// tests can prove the guard fails the turn when a forbidden tool shows up.
const ATTACH_MCP = AGENT_MCP_TOOLS.length > 0 || process.env["RELAYPAY_ATTACH_MCP"] === "1";

const MCP_ENTRY =
  process.env["RELAYPAY_MCP_ENTRY"] ??
  resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "mcp-server", "dist", "main.js");

export interface TurnInput {
  db: Db;
  ctx: LogContext;
  channel: "voice" | "test";
  caller: string | null;
  userText: string;
  history: HistoryEntry[];
  /** performance.now() when the request arrived. */
  tReceivedMs: number;
  tReceivedIso: string;
}

export interface TurnSink {
  /** Called once, before the first write, with where the reply comes from. */
  begin(source: TurnSource): void;
  speak(text: string): void;
  end(): void;
  onClose(listener: () => void): void;
}

export interface TurnResult {
  /** What the caller heard; null if nothing was spoken (client gone). */
  spoken: string | null;
  answerType: AnswerType;
  source: "agent" | "replay";
}

export interface TurnHandle {
  /** Resolves as soon as the spoken outcome is decided (used by in-flight duplicates). */
  decided: Promise<TurnResult>;
  /** Resolves once the turn row exists (written, replayed, or its write failed). */
  persisted: Promise<void>;
  /** Resolves after the turn row and conversation totals are persisted. */
  done: Promise<void>;
}

export function toolListProblem(init: { tools: string[]; mcp_servers: Array<{ name: string; status: string }> }): string | null {
  const forbidden = init.tools.filter((t) => FORBIDDEN_AGENT_TOOLS.includes(t));
  if (forbidden.length) return `forbidden tool(s) present: ${forbidden.join(",")}`;
  const got = [...init.tools].sort();
  const want = [...AGENT_MCP_TOOLS].sort();
  if (JSON.stringify(got) !== JSON.stringify(want)) return `tools ${JSON.stringify(got)} != allowlist ${JSON.stringify(want)}`;
  if (AGENT_MCP_TOOLS.length > 0) {
    const server = init.mcp_servers.find((s) => s.name === "relaypay");
    if (server?.status !== "connected") return `relaypay MCP server status ${server?.status ?? "missing"}`;
  }
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
    const { db, ctx } = input;
    const notes: string[] = [];
    const abort = new AbortController();
    const elapsed = () => Math.round(performance.now() - input.tReceivedMs);
    const marks: Record<string, number> = {};
    const mark = (name: string) => void (marks[name] ??= elapsed());
    let finished: TurnResult | null = null;
    let msFirstToken: number | null = null;
    let msTotal: number | null = null;
    let kbChunkIds: string[] = [];
    let begun = false;
    const spokenParts: string[] = [];

    const begin = (source: TurnResult["source"]) => {
      if (begun) return;
      begun = true;
      sink.begin(source);
    };
    /** Streams one gated sentence to the caller now. */
    const speak = (sentence: string, source: TurnResult["source"] = "agent") => {
      if (finished) return;
      begin(source);
      if (spokenParts.length === 0) {
        msFirstToken = elapsed();
        clearTimeout(firstTokenTimer);
      }
      spokenParts.push(sentence);
      sink.speak(sentence);
    };
    /** Ends the spoken stream and fixes the turn outcome. */
    const finish = (answerType: AnswerType, note?: string, source: TurnResult["source"] = "agent") => {
      if (finished) return;
      if (note) notes.push(note);
      begin(source);
      sink.end();
      msTotal = elapsed();
      finished = { spoken: spokenParts.length ? spokenParts.join(" ") : null, answerType, source };
      resolveDecided(finished);
    };
    /** Speaks a fixed line (fallback, safe decline, replay) and finishes. */
    const release = (text: string | null, answerType: AnswerType, note?: string, source: TurnResult["source"] = "agent") => {
      if (finished) return;
      if (text !== null) for (const s of sentences(text)) speak(s, source);
      finish(answerType, note, source);
    };
    const stop = (reason: string) => {
      if (abort.signal.aborted) return;
      notes.push(`aborted: ${reason}`);
      abort.abort(new Error(reason));
    };

    const firstTokenTimer: NodeJS.Timeout = setTimeout(() => {
      if (finished || spokenParts.length) return;
      release(FALLBACK_LINE, "error", `timeout: no speakable reply within ${FIRST_TOKEN_TIMEOUT_MS}ms`);
      stop("first-token timeout");
    }, Math.max(0, FIRST_TOKEN_TIMEOUT_MS - elapsed()));
    const hardCapTimer = setTimeout(() => {
      stop(`hard cap ${TURN_HARD_CAP_MS}ms`);
      if (spokenParts.length) finish("error", "hard cap reached mid-reply");
      else release(FALLBACK_LINE, "error");
    }, Math.max(0, TURN_HARD_CAP_MS - elapsed()));
    sink.onClose(() => {
      if (finished) return;
      stop(spokenParts.length ? "client disconnected mid-reply" : "client disconnected before any speech");
      finish("error");
    });

    // --- Streaming input: the CLI boots now; the user message is yielded once it is ready.
    let providePrompt!: (prompt: string | null) => void;
    const promptReady = new Promise<string | null>((r) => (providePrompt = r));
    let closeInput!: () => void;
    const inputClosed = new Promise<void>((r) => (closeInput = r));
    async function* userMessages(): AsyncGenerator<SDKUserMessage> {
      const prompt = await promptReady;
      if (prompt === null) return; // replay or already failed: never send anything
      mark("message_yielded");
      yield { type: "user", message: { role: "user", content: prompt }, parent_tool_use_id: null };
      await inputClosed; // keep stdin open until the result, then let the CLI exit
    }

    let retrievedIds: ReadonlySet<string> = new Set();
    let gate: StreamingGate | null = null;
    let stopReason: string | null = null;
    const discarded: string[] = [];
    const toolStarts = new Map<string, number>();
    let msTools = 0;
    let result: SDKResultMessage | null = null;

    mark("query_start");
    const q = query({
      prompt: userMessages(),
      options: {
        model: AGENT_MODEL,
        systemPrompt: SYSTEM_PROMPT,
        tools: [],
        allowedTools: [...AGENT_MCP_TOOLS],
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
        mcpServers: ATTACH_MCP
          ? { relaypay: { type: "stdio", command: process.execPath, args: [MCP_ENTRY], env: mcpEnv(ctx), alwaysLoad: true } }
          : {},
      },
    });

    const consume = (async () => {
      for await (const m of q) {
        if (m.type === "system" && m.subtype === "init") {
          mark("init");
          const problem = toolListProblem(m);
          if (problem) {
            notes.push(`tool-list guard: ${problem}`);
            if (spokenParts.length) finish("error");
            else release(FALLBACK_LINE, "error");
            stop("tool-list guard");
            break;
          }
        } else if (m.type === "stream_event" && m.parent_tool_use_id === null) {
          const e = m.event;
          if (finished) continue;
          if (e.type === "message_start") {
            mark("first_model_message");
            gate ??= new StreamingGate(retrievedIds); // retrievedIds is set before the prompt is yielded
            gate.start();
            stopReason = null;
          } else if (!gate) {
            continue;
          } else if (e.type === "content_block_start" && e.content_block.type === "tool_use") {
            const t = gate.toolUse();
            if (t.violation) {
              const sent = summarize(t.spokenBeforeToolUse.join(" "), 300);
              notes.push(`gate_violation: tool_use after speech had started; already sent: ${sent}`);
              console.log(JSON.stringify({ event: "gate_violation", conversation_id: ctx.conversationId, turn_index: ctx.turnIndex, already_sent: sent }));
            }
          } else if (e.type === "content_block_delta" && e.delta.type === "text_delta") {
            mark("first_text_delta");
            for (const sentence of gate.text(e.delta.text)) {
              mark("first_spoken");
              speak(sentence);
            }
          } else if (e.type === "message_delta") {
            stopReason = e.delta.stop_reason ?? stopReason;
          } else if (e.type === "message_stop") {
            const outcome = gate.end(stopReason);
            if (outcome.kind === "discarded") {
              if (outcome.raw) discarded.push(outcome.raw);
            } else if (outcome.kind === "final") {
              mark("final_message_stop");
              for (const sentence of outcome.speak) speak(sentence);
              kbChunkIds = outcome.validKbIds;
              const style = styleViolations(spokenParts.join(" "));
              if (style.length) notes.push(`style_violation: ${style.join(",")}`);
              if (outcome.unknownKbIds.length) notes.push(`cited ids not retrieved: ${outcome.unknownKbIds.join(",")}`);
              if (stopReason === "max_tokens") notes.push("final reply hit max_tokens");
              finish(outcome.type);
            } else {
              mark("final_message_stop");
              const note = `gate blocked: ${outcome.reason}; raw: ${summarize(outcome.raw, 300)}`;
              if (spokenParts.length) finish("blocked", note);
              else release(SAFE_DECLINE_LINE, "blocked", note);
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
          closeInput();
        }
      }
    })()
      .catch((err: unknown) => {
        // The SDK iterator throws after an error result (e.g. error_max_turns) and on abort.
        if (!abort.signal.aborted) notes.push(`agent error: ${summarize(err instanceof Error ? err.message : String(err), 300)}`);
      })
      .finally(() => closeInput());

    // --- Independent DB work, in parallel, while the CLI boots.
    let msRetrieval: number | null = null;
    let replayed = false;
    let retrievalLogged: Promise<boolean> = Promise.resolve(true);
    try {
      const rq = buildRetrievalQuery(input.history, input.userText);
      if (rq.combinedWithPrevious) notes.push("follow-up: retrieval searched previous + latest caller message");
      mark("db_start");
      const tRank = performance.now();
      const [, stored, chunks] = await Promise.all([
        upsertConversation(db, ctx.conversationId, input.channel, input.caller),
        findTurn(db, ctx),
        rankKnowledge(db, rq.query.slice(0, 1000)).then((c: KbChunk[]) => {
          msRetrieval = Math.round(performance.now() - tRank);
          return c;
        }),
      ]);
      mark("db_done");

      if (stored) {
        // Idempotent replay: nothing is sent to the model; the waiting CLI is shut down.
        replayed = true;
        providePrompt(null);
        abort.abort(new Error("replay"));
        release(stored.assistant_response ?? FALLBACK_LINE, stored.answer_type, undefined, "replay");
      } else if (finished) {
        // Timed out or disconnected during DB work: don't start the model.
        providePrompt(null);
      } else {
        retrievedIds = new Set(chunks.map((c) => c.chunk_id));
        if (chunks.length === 0) notes.push("pre-turn retrieval: insufficient_knowledge");
        retrievalLogged = logRetrievalResult(db, ctx, rq.query.slice(0, 1000), chunks);
        providePrompt(buildTurnPrompt(input.history, input.userText, chunks));
      }
      await consume;
      if (!(await retrievalLogged)) notes.push("pre-turn retrieval_logs write FAILED (see stderr)");
    } catch (err) {
      notes.push(`turn error: ${summarize(err instanceof Error ? err.message : String(err), 300)}`);
      providePrompt(null);
      stop("turn error");
    } finally {
      clearTimeout(firstTokenTimer);
      clearTimeout(hardCapTimer);
      closeInput();
    }

    if (replayed) {
      resolvePersisted();
      console.log(JSON.stringify({ event: "turn_replayed", conversation_id: ctx.conversationId, turn_index: ctx.turnIndex, marks }));
      return;
    }

    if (!finished) {
      const why = `no speakable final reply${result ? ` (result ${(result as SDKResultMessage).subtype})` : ""}`;
      if (spokenParts.length) finish("error", why);
      else release(FALLBACK_LINE, "error", why);
    }
    const finalResult = result as SDKResultMessage | null;
    if (finalResult && finalResult.subtype !== "success") notes.push(`result subtype ${finalResult.subtype}`);
    if (discarded.length) {
      notes.push(`discarded ${discarded.length} non-final segment(s): ${summarize(discarded.join(" | "), 200)}`);
    }

    const outcome = finished as unknown as TurnResult; // always set by finish() above
    try {
      const inserted = await insertTurn(db, ctx, {
        userTranscript: input.userText,
        assistantResponse: outcome.spoken,
        answerType: outcome.answerType,
        confidenceNote: summarize(notes.join("; ") || "ok", 1000),
        kbChunkIds,
        tReceived: input.tReceivedIso,
        msRetrieval,
        msFirstToken,
        msTools: finalResult || msTools ? Math.round(msTools) : null,
        msTotal,
        model: AGENT_MODEL,
        ...usageFrom(finalResult),
      });
      resolvePersisted();
      if (!inserted) console.error(`[relaypay] turn ${ctx.conversationId}#${ctx.turnIndex} already persisted by another run`);
      await recomputeConversationTotals(db, ctx.conversationId);
    } catch (err) {
      resolvePersisted();
      console.error(`[relaypay] persistence failed for ${ctx.conversationId}#${ctx.turnIndex}: ${summarize(err instanceof Error ? err.message : String(err))}`);
    }
    console.log(JSON.stringify({
      event: "turn",
      conversation_id: ctx.conversationId,
      turn_index: ctx.turnIndex,
      answer_type: outcome.answerType,
      ms_first_token: msFirstToken,
      ms_total: msTotal,
      cost_usd_estimate: finalResult?.total_cost_usd ?? null,
      aborted: abort.signal.aborted,
      marks: { ...marks, released: msFirstToken },
    }));
  })();

  return { decided, persisted, done };
}
