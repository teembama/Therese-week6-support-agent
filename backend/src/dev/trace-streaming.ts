// Lever 3 evidence: timing trace of one turn, sequential vs overlapped (streaming input).
//   sequential: DB work (upsert, turn check, retrieval) -> query(prompt string)   [current server]
//   overlap:    query(async generator) at t0 || DB work in parallel -> yield the user message
// Marks (ms from "request received"): query() called/returned, CLI spawned (spawn hook),
// CLI first stdout, init, work start/done, message yielded, first model event, first token,
// result. An event-loop heartbeat records the longest stall, to test whether query() blocks.
// Run: node backend/dist/dev/trace-streaming.js [runsPerMode=4]

import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { query, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { createServiceClient, logRetrieval, rankKnowledge, type Db, type LogContext } from "@relaypay/shared";
import { cliEnv } from "../child-env.js";
import { AGENT_MODEL } from "../config.js";
import { findTurn, upsertConversation } from "../persistence.js";
import { buildTurnPrompt, SYSTEM_PROMPT } from "../prompt.js";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const QUESTION = "What fees does RelayPay charge for international payments?";

async function dbWork(db: Db, ctx: LogContext, parallel: boolean, mark: (n: string) => void) {
  mark("work_start");
  const upsert = () => upsertConversation(db, ctx.conversationId, "test", "trace");
  const check = () => findTurn(db, ctx);
  const rank = () => rankKnowledge(db, QUESTION);
  let chunks;
  if (parallel) {
    [, , chunks] = await Promise.all([upsert(), check(), rank()]);
  } else {
    await upsert();
    await check();
    chunks = await rank();
  }
  await logRetrieval(db, ctx, { query: QUESTION, chunkIds: chunks.map((c) => c.chunk_id), sourceTitles: [], sourceSummary: "trace", insufficientKnowledge: chunks.length === 0 });
  mark("work_done");
  return chunks;
}

async function traceOnce(db: Db, mode: "sequential" | "overlap", run: number) {
  const ctx: LogContext = { conversationId: `test-trace-${mode}-${Date.now()}`, turnIndex: 0 };
  const t0 = performance.now();
  const marks: Record<string, number> = {};
  const mark = (n: string) => void (marks[n] ??= Math.round(performance.now() - t0));
  let maxStall = 0;
  let last = performance.now();
  const beat = setInterval(() => {
    const now = performance.now();
    maxStall = Math.max(maxStall, now - last - 10);
    last = now;
  }, 10);

  const options = {
    model: AGENT_MODEL,
    systemPrompt: SYSTEM_PROMPT,
    tools: [],
    allowedTools: [],
    permissionMode: "dontAsk" as const,
    settingSources: [],
    strictMcpConfig: true,
    persistSession: false,
    maxTurns: 2,
    thinking: { type: "disabled" as const },
    includePartialMessages: true,
    env: cliEnv(),
    spawnClaudeCodeProcess: (o: { command: string; args: string[]; cwd?: string; env: Record<string, string | undefined>; signal: AbortSignal }) => {
      mark("cli_spawned");
      const child = spawn(o.command, o.args, { cwd: o.cwd, env: o.env as NodeJS.ProcessEnv, signal: o.signal, stdio: ["pipe", "pipe", "pipe"] });
      child.stdout.once("data", () => mark("cli_first_stdout"));
      return child;
    },
  };

  let q;
  if (mode === "sequential") {
    const chunks = await dbWork(db, ctx, false, mark);
    mark("query_called");
    q = query({ prompt: buildTurnPrompt([], QUESTION, chunks), options });
    mark("query_returned");
  } else {
    let finish!: () => void;
    const finished = new Promise<void>((r) => (finish = r));
    const work = dbWork(db, ctx, true, mark);
    async function* input(): AsyncGenerator<SDKUserMessage> {
      const chunks = await work;
      mark("message_yielded");
      yield { type: "user", message: { role: "user", content: buildTurnPrompt([], QUESTION, chunks) }, parent_tool_use_id: null };
      await finished; // keep stdin open until the result arrives
    }
    mark("query_called");
    q = query({ prompt: input(), options });
    mark("query_returned");
    void work;
    for await (const m of q) {
      if (m.type === "system" && m.subtype === "init") mark("init");
      else if (m.type === "stream_event" && m.event.type === "message_start") mark("first_model_event");
      else if (m.type === "stream_event" && m.event.type === "content_block_delta" && m.event.delta.type === "text_delta") mark("first_token");
      else if (m.type === "result") {
        mark("result");
        finish();
        break;
      }
    }
    clearInterval(beat);
    return { mode, run, ...marks, max_event_loop_stall_ms: Math.round(maxStall) };
  }
  for await (const m of q) {
    if (m.type === "system" && m.subtype === "init") mark("init");
    else if (m.type === "stream_event" && m.event.type === "message_start") mark("first_model_event");
    else if (m.type === "stream_event" && m.event.type === "content_block_delta" && m.event.delta.type === "text_delta") mark("first_token");
    else if (m.type === "result") mark("result");
  }
  clearInterval(beat);
  return { mode, run, ...marks, max_event_loop_stall_ms: Math.round(maxStall) };
}

async function main(): Promise<void> {
  process.loadEnvFile(resolve(REPO, ".env"));
  const db = createServiceClient();
  const runs = Number(process.argv[2] ?? 4);
  const rows = [];
  for (let i = 0; i < runs; i++) {
    for (const mode of ["sequential", "overlap"] as const) rows.push(await traceOnce(db, mode, i));
  }
  const cols = ["mode", "run", "work_start", "query_called", "query_returned", "cli_spawned", "cli_first_stdout", "init", "work_done", "message_yielded", "first_model_event", "first_token", "result", "max_event_loop_stall_ms"];
  console.table(rows.map((r) => Object.fromEntries(cols.map((c) => [c, (r as Record<string, unknown>)[c] ?? ""]))));
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.stack : String(err));
  process.exit(1);
});
