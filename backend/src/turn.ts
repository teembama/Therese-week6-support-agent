// One caller turn, from request receipt to persisted row.
//
// Lifecycle (lever 3, docs/latency.md):
//   1. Timers start from request receipt, so the first-token timeout also covers DB work.
//   2. query() starts immediately in streaming-input mode, so the Claude Code CLI boots while
//      the backend does its independent DB work IN PARALLEL: conversation upsert, existing-turn
//      check, and pre-turn retrieval (ranking only).
//   3. begin_turn_attempt (migration 003, D28) decides: a stored turn that SPOKE something with
//      the same transcript hash is replayed (input closed without a message, CLI tree killed,
//      no attempt row); otherwise this request becomes an ATTEMPT, replacing any active one.
//   4. Otherwise the retrieval_logs row is written, and the user message (prompt with chunks) is
//      yielded to the waiting CLI. The gate checks the reply against the in-memory retrieved set.
// Plus: hard cap, client-disconnect abort, tool-list guard, persistence + recomputed totals.

import type { ChildProcess } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { query, type SDKResultMessage, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { logRetrievalResult, newAttemptId, rankKnowledge, summarize, type Db, type KbChunk, type LogContext } from "@relaypay/shared";
import { cliEnv, mcpEnv } from "./child-env.js";
import { pickMcpEntry } from "./mcp-entry.js";
import {
  AGENT_MAX_BUDGET_USD,
  AGENT_MAX_TURNS,
  AGENT_MCP_TOOLS,
  AGENT_MODEL,
  DB_CALL_TIMEOUT_MS,
  FALLBACK_LINE,
  FAULT_INJECT,
  PRETURN_DB_BUDGET_MS,
  FIRST_TOKEN_TIMEOUT_MS,
  FORBIDDEN_AGENT_TOOLS,
  SAFE_DECLINE_LINE,
  TURN_HARD_CAP_MS,
} from "./config.js";
import { sentences, socialLine, StreamingGate, type GateEvidence, type SocialIntent } from "./gate.js";
import { matchSocial } from "./social-fast-path.js";
import { beginTurnAttempt, finishTurnAttempt, type AnswerType, type AttemptFinalStatus, type AttemptMetrics } from "./persistence.js";
import { retryOnce, withTimeout } from "./bounded.js";
import { isAlive, killTree, spawnCli } from "./process-tree.js";
import { buildTurnPrompt, SYSTEM_PROMPT, type HistoryEntry } from "./prompt.js";
import { buildRetrievalQuery } from "./retrieval-query.js";
import type { TurnSource } from "./sse.js";
import { styleViolations } from "./style.js";

// The MCP server is attached whenever the agent has tools (always, except the test-only
// latency baseline RELAYPAY_TEST_DETACH_MCP=1).
const ATTACH_MCP = AGENT_MCP_TOOLS.length > 0;

const EMPTY_METRICS: AttemptMetrics = {
  ms_retrieval: null, ms_first_token: null, ms_total: null, model: null, input_tokens: null, output_tokens: null,
  cache_read_tokens: null, cache_creation_tokens: null, cost_usd_estimate: null, sdk_duration_ms: null, sdk_num_turns: null,
};

const MCP = pickMcpEntry();
if (ATTACH_MCP && MCP.reason) console.error(`[relaypay] MCP server entry: ${MCP.path} (${MCP.reason})`);
const MCP_ENTRY = MCP.path;
export const MCP_ENTRY_KIND = MCP.kind;

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
  /** Hash of the latest caller message (the third part of the turn key, D28). */
  transcriptHash: string;
  /**
   * Settles when the attempt this one replaces has registered (or given up registering) in the
   * database, so this attempt's begin_turn_attempt always runs after it and marks it replaced.
   */
  afterPrevious?: Promise<void>;
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
  /** Settles once begin_turn_attempt has returned (or failed) for this request. */
  begun: Promise<void>;
  /** A newer request with a different transcript arrived: abort this attempt now (D28). */
  replace(): void;
  attemptId: string | undefined;
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

/** The last thing the agent said, as Vapi reports it in the conversation history. */
function previousAgentLine(history: HistoryEntry[]): string | null {
  for (let i = history.length - 1; i >= 0; i--) if (history[i]!.role === "agent") return history[i]!.text;
  return null;
}

/**
 * Social fast path (D35): speak the fixed line immediately (no model call, no database wait),
 * then record the attempt and the turn in the background, bounded: each database call has a
 * timeout, registration gets one retry under a fresh attempt id (a timed-out first try may
 * still have committed; the retry marks it replaced), and failures only reach stderr. Social
 * replies have no side effects, so recording late is safe.
 */
function runSocialFastPath(input: TurnInput, sink: TurnSink, intent: SocialIntent): TurnHandle {
  const { db, ctx } = input;
  const line = socialLine(intent);
  sink.begin("agent");
  for (const s of sentences(line)) sink.speak(s);
  sink.end();
  const msSpoken = Math.round(performance.now() - input.tReceivedMs);
  const result: TurnResult = { spoken: line, answerType: "social", source: "agent" };

  let resolveBegun!: () => void;
  const begun = new Promise<void>((r) => (resolveBegun = r));
  const persisted = (async () => {
    let attemptId = ctx.attemptId!;
    let status = "not recorded";
    try {
      if (input.afterPrevious) await withTimeout(input.afterPrevious, 3_000, "previous attempt").catch(() => undefined);
      const beginWith = (id: string) =>
        beginTurnAttempt(db, {
          conversationId: ctx.conversationId, channel: input.channel, caller: input.caller, turnIndex: ctx.turnIndex,
          attemptId: id, transcriptHash: input.transcriptHash, userTranscript: input.userText,
        });
      let started;
      try {
        started = await withTimeout(beginWith(attemptId), DB_CALL_TIMEOUT_MS, "begin_turn_attempt (fast path)");
      } catch {
        attemptId = newAttemptId();
        started = await withTimeout(beginWith(attemptId), DB_CALL_TIMEOUT_MS, "begin_turn_attempt (fast path, retry)");
      }
      resolveBegun();
      if (started.action === "replay") {
        status = "replay (already recorded)";
        return;
      }
      const metrics: AttemptMetrics = { ...EMPTY_METRICS, ms_first_token: msSpoken, ms_total: msSpoken };
      status = await retryOnce(
        () =>
          finishTurnAttempt(db, attemptId, "completed", "social (fast_path)", metrics, {
            ...metrics,
            transcript_hash: input.transcriptHash,
            user_transcript: input.userText,
            assistant_response: line,
            answer_type: "social",
            confidence_note: `fast_path; intent=${intent}`,
            kb_chunk_ids: [],
            t_received: input.tReceivedIso,
            ms_tools: null,
          }),
        DB_CALL_TIMEOUT_MS,
        "finish_turn_attempt (fast path)",
      );
    } catch (err) {
      console.error(`[relaypay] fast-path turn ${ctx.conversationId}#${ctx.turnIndex} (${attemptId}) not recorded: ${summarize(err instanceof Error ? err.message : String(err), 200)}`);
    } finally {
      resolveBegun();
      console.log(JSON.stringify({ event: "turn", conversation_id: ctx.conversationId, turn_index: ctx.turnIndex, attempt_id: attemptId, attempt_status: status, answer_type: "social", fast_path: true, intent, ms_first_token: msSpoken, ms_total: msSpoken, cost_usd_estimate: 0 }));
    }
  })();
  return { decided: Promise.resolve(result), persisted, done: persisted, begun, replace: () => {}, attemptId: ctx.attemptId };
}

export function runTurn(input: TurnInput, sink: TurnSink): TurnHandle {
  const socialIntent = matchSocial(input.userText, previousAgentLine(input.history));
  if (socialIntent) return runSocialFastPath(input, sink, socialIntent);

  let resolveDecided!: (r: TurnResult) => void;
  const decided = new Promise<TurnResult>((r) => (resolveDecided = r));
  let resolvePersisted!: () => void;
  const persisted = new Promise<void>((r) => (resolvePersisted = r));
  let resolveBegun!: () => void;
  const begun = new Promise<void>((r) => (resolveBegun = r));
  let replaceHook: () => void = () => {};
  let replacedEarly = false;

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
    let sinkBegun = false;
    const spokenParts: string[] = [];
    let replaced = false;
    let clientGone = false;
    let cliChild: ChildProcess | null = null;
    let killedPids: number[] = [];
    let filterStats = null as StreamingGate["filterStats"] | null; // set inside a closure

    const begin = (source: TurnResult["source"]) => {
      if (sinkBegun) return;
      sinkBegun = true;
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
    const killCliTree = async () => {
      const pid = cliChild?.pid;
      if (!pid || cliChild?.exitCode !== null) return;
      killedPids = await killTree(pid);
      console.log(JSON.stringify({ event: "process_tree_killed", conversation_id: ctx.conversationId, turn_index: ctx.turnIndex, attempt_id: ctx.attemptId, root_pid: pid, killed_pids: killedPids, root_alive_after: isAlive(pid) }));
    };
    const stop = (reason: string, quiet = false) => {
      if (abort.signal.aborted) return;
      if (!quiet) notes.push(`aborted: ${reason}`);
      abort.abort(new Error(reason));
      void killCliTree();
    };
    replaceHook = () => {
      if (replaced) return;
      replaced = true;
      stop("replaced by a newer request with a different transcript");
      finish("error");
    };
    if (replacedEarly) replaceHook();

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
      clientGone = true;
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
    let evidence: GateEvidence | undefined;
    let gate: StreamingGate | null = null;
    /** Logs sentences the runtime grounding filter dropped (D37); never spoken. */
    const logFiltered = () => {
      for (const { sentence, flags } of gate?.takeFiltered() ?? []) {
        const checks = [...new Set(flags.map((x) => x.kind))];
        notes.push(`grounding_filtered: ${flags.map((x) => `${x.kind}(${x.term})`).join(",")}: ${summarize(sentence, 200)}`);
        // Log line: check names and a redacted excerpt only (digits masked, 80 chars).
        const excerpt = summarize(sentence.replace(/\d/g, "#"), 80);
        console.log(JSON.stringify({ event: "grounding_filtered", conversation_id: ctx.conversationId, turn_index: ctx.turnIndex, attempt_id: ctx.attemptId, checks, excerpt }));
      }
    };
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
        spawnClaudeCodeProcess: (o) =>
          spawnCli(o, (child) => {
            cliChild = child;
            mark("cli_spawned");
            if (abort.signal.aborted) void killCliTree();
          }),
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
            gate ??= new StreamingGate(retrievedIds, undefined, evidence); // both are set before the prompt is yielded
            filterStats = gate.filterStats;
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
            logFiltered();
          } else if (e.type === "message_delta") {
            stopReason = e.delta.stop_reason ?? stopReason;
          } else if (e.type === "message_stop") {
            const outcome = gate.end(stopReason);
            logFiltered();
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
    let registered = false;
    let retrievalLogged: Promise<boolean> = Promise.resolve(true);
    let beginPromise: Promise<Awaited<ReturnType<typeof beginTurnAttempt>>> | null = null;
    try {
      const rq = buildRetrievalQuery(input.history, input.userText);
      if (rq.combinedWithPrevious) notes.push("follow-up: retrieval searched previous + latest caller message");
      mark("db_start");
      const tRank = performance.now();
      beginPromise = (async () => {
        // Never register before the attempt this one replaces (see TurnInput.afterPrevious).
        if (input.afterPrevious) await Promise.race([input.afterPrevious, new Promise((r) => setTimeout(r, 3_000))]);
        return beginTurnAttempt(db, {
          conversationId: ctx.conversationId,
          channel: input.channel,
          caller: input.caller,
          turnIndex: ctx.turnIndex,
          attemptId: ctx.attemptId!,
          transcriptHash: input.transcriptHash,
          userTranscript: input.userText,
        });
      })().finally(() => resolveBegun());
      // Bounded (D34): a stalled database must not keep the caller silent. Past the budget the
      // caller hears the fallback and a late registration is closed as 'failed' in the background.
      const [started, chunks] = await withTimeout(
        Promise.all([
          beginPromise,
          rankKnowledge(db, rq.query.slice(0, 1000)).then((c: KbChunk[]) => {
            msRetrieval = Math.round(performance.now() - tRank);
            return c;
          }),
        ]),
        PRETURN_DB_BUDGET_MS,
        "pre-turn database work",
      );
      mark("db_done");
      if (FAULT_INJECT === "throw_in_turn") throw new Error("injected fault: throw_in_turn");
      if (FAULT_INJECT === "unhandled_rejection") void Promise.reject(new Error("injected fault: unhandled_rejection"));

      if (started.action === "replay") {
        // Genuine retry of a turn that spoke: replay it. Nothing is sent to the model and the
        // waiting CLI tree is killed; no attempt row is created.
        replayed = true;
        providePrompt(null);
        stop("replay", true);
        release(started.assistantResponse, started.answerType, undefined, "replay");
      } else if (finished) {
        registered = true;
        // Timed out, disconnected or replaced during DB work: don't start the model.
        providePrompt(null);
      } else {
        registered = true;
        if (started.replacedAttemptIds.length) notes.push(`replaced attempt(s): ${started.replacedAttemptIds.join(",")}`);
        retrievedIds = new Set(chunks.map((c) => c.chunk_id));
        const callerWords = [...input.history.filter((h) => h.role === "caller").map((h) => h.text), input.userText].join("\n");
        evidence = { chunks: new Map(chunks.map((c) => [c.chunk_id, `${c.heading}\n${c.content}`])), callerText: callerWords };
        if (chunks.length === 0) notes.push("pre-turn retrieval: insufficient_knowledge");
        retrievalLogged = logRetrievalResult(db, ctx, rq.query.slice(0, 1000), chunks);
        providePrompt(buildTurnPrompt(input.history, input.userText, chunks));
      }
      await consume;
      if (!(await retrievalLogged)) notes.push("pre-turn retrieval_logs write FAILED (see stderr)");
    } catch (err) {
      const reason = summarize(err instanceof Error ? err.message : String(err), 300);
      notes.push(`turn error: ${reason}`);
      providePrompt(null);
      stop("turn error");
      if (!finished) release(FALLBACK_LINE, "error"); // the caller hears something right away
      resolveBegun();
      // The registration may still complete after we gave up on it: close it as 'failed' so the
      // attempt never stays 'active' (bounded: waits for it, one finish call with a timeout).
      if (!registered && beginPromise) {
        const late = beginPromise;
        void (async () => {
          try {
            const r = await withTimeout(late, 10_000, "late begin_turn_attempt");
            if (r.action === "run") {
              await retryOnce(() => finishTurnAttempt(db, ctx.attemptId!, "failed", `pre-turn failure: ${reason}`, EMPTY_METRICS, null), DB_CALL_TIMEOUT_MS, "finish_turn_attempt(failed)");
            }
          } catch (lateErr) {
            console.error(`[relaypay] attempt ${ctx.attemptId} for ${ctx.conversationId}#${ctx.turnIndex} left in an unknown state: ${summarize(lateErr instanceof Error ? lateErr.message : String(lateErr), 200)}`);
          }
        })();
      }
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
    // Attempt status: completed = something was spoken to the caller; otherwise why not.
    const status: AttemptFinalStatus = replaced || clientGone ? "aborted" : outcome.spoken !== null ? "completed" : "failed";
    const statusReason = replaced
      ? "replaced by a newer request with a different transcript"
      : clientGone && outcome.spoken === null
        ? "client disconnected before any speech"
        : clientGone
          ? "client disconnected mid-reply"
          : outcome.spoken !== null
            ? outcome.answerType
            : "nothing spoken";
    const usage = usageFrom(finalResult);
    const metrics = {
      ms_retrieval: msRetrieval,
      ms_first_token: msFirstToken,
      ms_total: msTotal,
      model: AGENT_MODEL,
      input_tokens: usage.inputTokens,
      output_tokens: usage.outputTokens,
      cache_read_tokens: usage.cacheReadTokens,
      cache_creation_tokens: usage.cacheCreationTokens,
      cost_usd_estimate: usage.costUsdEstimate,
      sdk_duration_ms: usage.sdkDurationMs,
      sdk_num_turns: usage.sdkNumTurns,
    };
    let finalStatus: string | null = null;
    if (registered) {
      try {
        const turnRow = status === "completed" && outcome.spoken !== null
            ? {
                ...metrics,
                transcript_hash: input.transcriptHash,
                user_transcript: input.userText,
                assistant_response: outcome.spoken,
                answer_type: outcome.answerType,
                confidence_note: summarize(notes.join("; ") || "ok", 1000),
                kb_chunk_ids: kbChunkIds,
                t_received: input.tReceivedIso,
                ms_tools: finalResult || msTools ? Math.round(msTools) : null,
              }
            : null;
        // Bounded (D34): one retry, each call with a timeout; the caller's response is already sent.
        finalStatus = await retryOnce(() => finishTurnAttempt(db, ctx.attemptId!, status, statusReason, metrics, turnRow), DB_CALL_TIMEOUT_MS, "finish_turn_attempt");
      } catch (err) {
        console.error(`[relaypay] persistence failed for ${ctx.conversationId}#${ctx.turnIndex} (${ctx.attemptId}): ${summarize(err instanceof Error ? err.message : String(err))}`);
      }
    } else {
      console.error(`[relaypay] attempt ${ctx.attemptId} for ${ctx.conversationId}#${ctx.turnIndex} was never registered; nothing persisted (${summarize(notes.join("; "), 300)})`);
    }
    resolvePersisted();
    console.log(JSON.stringify({
      event: "turn",
      conversation_id: ctx.conversationId,
      turn_index: ctx.turnIndex,
      attempt_id: ctx.attemptId,
      attempt_status: finalStatus,
      answer_type: outcome.answerType,
      ms_first_token: msFirstToken,
      ms_total: msTotal,
      cost_usd_estimate: finalResult?.total_cost_usd ?? null,
      aborted: abort.signal.aborted,
      killed_pids: killedPids,
      filter: filterStats && filterStats.sentences ? { sentences: filterStats.sentences, max_ms: Number(filterStats.maxMs.toFixed(3)) } : undefined,
      marks: { ...marks, released: msFirstToken },
    }));
  })();

  return {
    decided,
    persisted,
    done,
    begun,
    replace: () => {
      replacedEarly = true;
      replaceHook();
    },
    attemptId: input.ctx.attemptId,
  };
}
