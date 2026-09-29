// End-to-end tests of POST /chat/completions against local backend servers (real Agent SDK,
// real MCP server, real Supabase). Spawns:
//   A: normal server              (port 8799)
//   B: 1.5s first-token timeout   (port 8798)  -> fallback + abort
//   C: MCP entry that doesn't exist (port 8797) -> tool-list guard
// Usage: npm run test:endpoint   (after npm run build)

import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServiceClient, type Db } from "@relaypay/shared";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SERVER = resolve(REPO, "backend", "dist", "server.js");
const RUN = new Date().toISOString().replace(/[:.]/g, "-");

let failures = 0;
const check = (ok: boolean, label: string, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  ${detail}` : ""}`);
  if (!ok) failures++;
};

interface Server { proc: ChildProcess; port: number; logs: string[] }

async function startServer(port: number, extraEnv: Record<string, string> = {}): Promise<Server> {
  const proc = spawn(process.execPath, [SERVER], { env: { ...process.env, PORT: String(port), ...extraEnv }, stdio: ["ignore", "pipe", "pipe"] });
  const logs: string[] = [];
  proc.stdout!.on("data", (d: Buffer) => logs.push(...d.toString().split("\n").filter(Boolean)));
  proc.stderr!.on("data", (d: Buffer) => logs.push(...d.toString().split("\n").filter(Boolean)));
  for (let i = 0; i < 100; i++) {
    if (logs.some((l) => l.includes('"event":"listening"'))) return { proc, port, logs };
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`server on ${port} did not start: ${logs.join(" | ")}`);
}

interface Reply { status: number; source: string | null; text: string; events: unknown[]; raw: string; ms: number }

async function post(port: number, body: unknown, opts: { auth?: string | null; path?: string; method?: string; abortAfterMs?: number } = {}): Promise<Reply> {
  const t0 = performance.now();
  const controller = new AbortController();
  if (opts.abortAfterMs) setTimeout(() => controller.abort(), opts.abortAfterMs);
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const auth = opts.auth === undefined ? `Bearer ${process.env["VAPI_LLM_SECRET"]}` : opts.auth;
  if (auth) headers["Authorization"] = auth;
  try {
    const res = await fetch(`http://localhost:${port}${opts.path ?? "/chat/completions"}`, {
      method: opts.method ?? "POST",
      headers,
      signal: controller.signal,
      ...(opts.method === "GET" ? {} : { body: JSON.stringify(body) }),
    });
    const raw = await res.text();
    const events = raw.split("\n").filter((l) => l.startsWith("data: ")).map((l) => l.slice(6)).map((d) => (d === "[DONE]" ? d : JSON.parse(d)));
    const text = events
      .filter((e): e is { choices: Array<{ delta: { content?: string } }> } => typeof e === "object")
      .map((e) => e.choices[0]?.delta.content ?? "")
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    return { status: res.status, source: res.headers.get("x-relaypay-turn-source"), text, events, raw, ms: Math.round(performance.now() - t0) };
  } catch (err) {
    return { status: -1, source: null, text: "", events: [], raw: String(err), ms: Math.round(performance.now() - t0) };
  }
}

const body = (callId: string, userTexts: string[], assistantTexts: string[] = []) => ({
  model: "relaypay-agent",
  stream: true,
  call: { id: callId },
  messages: [
    { role: "system", content: "Vapi placeholder prompt: the backend owns the real prompt." },
    ...userTexts.flatMap((u, i) => [{ role: "user", content: u }, ...(assistantTexts[i] ? [{ role: "assistant", content: assistantTexts[i] }] : [])]),
  ],
});

async function turnRow(db: Db, conversationId: string, turnIndex = 0, waitMs = 15_000) {
  for (let waited = 0; waited <= waitMs; waited += 250) {
    const { data } = await db.from("conversation_turns").select("*").eq("conversation_id", conversationId).eq("turn_index", turnIndex).maybeSingle();
    if (data) return data as Record<string, unknown>;
    await new Promise((r) => setTimeout(r, 250));
  }
  return null;
}

async function turnRowCount(db: Db, conversationId: string): Promise<number> {
  const { count } = await db.from("conversation_turns").select("*", { count: "exact", head: true }).eq("conversation_id", conversationId);
  return count ?? 0;
}

const agentRuns = (s: Server, conversationId: string) =>
  s.logs.filter((l) => l.includes('"event":"turn"') && l.includes(`"conversation_id":"${conversationId}"`)).length;

function sseWellFormed(r: Reply): boolean {
  const e = r.events;
  const first = e[0] as { choices?: Array<{ delta?: { role?: string } }> } | undefined;
  const beforeDone = e[e.length - 2] as { choices?: Array<{ finish_reason?: string | null }> } | undefined;
  return first?.choices?.[0]?.delta?.role === "assistant" && beforeDone?.choices?.[0]?.finish_reason === "stop" && e[e.length - 1] === "[DONE]";
}

function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]!;
}

async function main(): Promise<number> {
  process.loadEnvFile(resolve(REPO, ".env"));
  // Per-run secret for the spawned test servers (they inherit it; loadEnvFile does not
  // override variables that are already set). The real VAPI_LLM_SECRET is never needed here.
  process.env["VAPI_LLM_SECRET"] = `test-${randomBytes(24).toString("hex")}`;
  const db = createServiceClient();
  const A = await startServer(8799);
  const servers = [A];
  try {
    console.log("== HTTP surface");
    check((await post(A.port, body(`test-ep-${RUN}-noauth`, ["hi"]), { auth: null })).status === 401, "no Authorization header -> 401");
    check((await post(A.port, body(`test-ep-${RUN}-badauth`, ["hi"]), { auth: "Bearer wrong-secret" })).status === 401, "wrong secret -> 401");
    check((await post(A.port, {}, { path: "/v1/chat/completions" })).status === 404, "wrong path -> 404");
    check((await post(A.port, {}, { method: "GET" })).status === 404, "GET -> 404");
    check((await post(A.port, { messages: [{ role: "user", content: "hi" }] })).status === 400, "missing call.id -> 400");
    check(A.logs.some((l) => l.includes('"event":"not_found"') && l.includes('"path":"/v1/chat/completions"')), "404 logged with method and path");
    check(!A.logs.some((l) => l.includes(process.env["VAPI_LLM_SECRET"]!) || l.includes("wrong-secret")), "no secret or Authorization value in server logs");

    console.log("\n== Fees question");
    const feesId = `test-ep-${RUN}-fees`;
    const fees = await post(A.port, body(feesId, ["What fees does RelayPay charge for international payments?"]));
    const feesRow = await turnRow(db, feesId);
    console.log(`spoken: ${JSON.stringify(fees.text)}`);
    console.log(`row: answer_type=${feesRow?.["answer_type"]} kb=${JSON.stringify(feesRow?.["kb_chunk_ids"])} note=${JSON.stringify(feesRow?.["confidence_note"])}`);
    check(fees.status === 200 && sseWellFormed(fees), "SSE: role delta first, finish_reason stop, then [DONE]");
    check(feesRow?.["answer_type"] === "answer", "fees: answer_type answer");
    const { data: feesLogs } = await db.from("retrieval_logs").select("chunk_ids").eq("conversation_id", feesId).eq("turn_index", 0);
    const retrieved = new Set((feesLogs ?? []).flatMap((r) => (r as { chunk_ids: string[] }).chunk_ids));
    const kb = (feesRow?.["kb_chunk_ids"] ?? []) as string[];
    check(kb.length > 0 && kb.every((id) => retrieved.has(id)), "fees: kb ids non-empty and all in retrieval_logs for the turn", JSON.stringify(kb));
    check(fees.text.length > 0 && !/\[\[|type=|kb=|[*#`]/.test(fees.text), "fees: spoken text has no header or markdown");
    check(feesRow?.["assistant_response"] === fees.text, "fees: stored assistant_response equals what was streamed");

    console.log("\n== Second turn with history (turn_index from Vapi's messages)");
    const t2 = await post(A.port, body(feesId, ["What fees does RelayPay charge for international payments?", "And how long do payouts to Kenya take?"], [fees.text]));
    const t2Row = await turnRow(db, feesId, 1);
    console.log(`spoken: ${JSON.stringify(t2.text)}  answer_type=${t2Row?.["answer_type"]}`);
    check(t2Row !== null, "second user message stored as turn_index 1");

    console.log("\n== Crypto (known limitation D17)");
    const cryptoId = `test-ep-${RUN}-crypto`;
    const crypto = await post(A.port, body(cryptoId, ["do you support crypto wallets"]));
    const cryptoRow = await turnRow(db, cryptoId);
    console.log(`spoken: ${JSON.stringify(crypto.text)}  answer_type=${cryptoRow?.["answer_type"]}  note=${JSON.stringify(cryptoRow?.["confidence_note"])}`);
    check(["decline", "blocked"].includes(String(cryptoRow?.["answer_type"])), "crypto: decline or blocked");

    console.log("\n== Weather (off-topic)");
    const weatherId = `test-ep-${RUN}-weather`;
    const weather = await post(A.port, body(weatherId, ["what is the weather in Lagos"]));
    const weatherRow = await turnRow(db, weatherId);
    console.log(`spoken: ${JSON.stringify(weather.text)}  answer_type=${weatherRow?.["answer_type"]}  note=${JSON.stringify(weatherRow?.["confidence_note"])}`);
    check(weatherRow?.["answer_type"] === "decline", "weather: decline");

    console.log("\n== Same request twice, sequentially");
    const seqId = `test-ep-${RUN}-seq`;
    const seqBody = body(seqId, ["How long do local payouts take?"]);
    const s1 = await post(A.port, seqBody);
    await turnRow(db, seqId);
    const s2 = await post(A.port, seqBody);
    const seqRow = await turnRow(db, seqId);
    console.log(`1st source=${s1.source} ${s1.ms}ms | 2nd source=${s2.source} ${s2.ms}ms | agent runs=${agentRuns(A, seqId)} | cost=${seqRow?.["cost_usd_estimate"]}`);
    check(s1.source === "agent" && s2.source === "replay", "second request replayed from the stored turn");
    check(s1.text === s2.text && s1.text.length > 0, "replay streams the same text");
    check((await turnRowCount(db, seqId)) === 1 && agentRuns(A, seqId) === 1, "exactly one turn row and one agent run (one result, one cost)");

    console.log("\n== Same request twice, concurrently");
    const conId = `test-ep-${RUN}-concurrent`;
    const conBody = body(conId, ["Can I create invoices in multiple currencies?"]);
    const [c1, c2] = await Promise.all([post(A.port, conBody), post(A.port, conBody)]);
    await turnRow(db, conId);
    await new Promise((r) => setTimeout(r, 500));
    console.log(`sources: ${c1.source}, ${c2.source} | agent runs=${agentRuns(A, conId)}`);
    check([c1.source, c2.source].sort().join(",") === "agent,inflight", "one request ran the agent, the other joined it in flight");
    check(c1.text === c2.text && c1.text.length > 0, "both streamed the same text");
    check((await turnRowCount(db, conId)) === 1 && agentRuns(A, conId) === 1, "exactly one turn row and one agent run");

    console.log("\n== Client disconnect aborts the agent");
    const dcId = `test-ep-${RUN}-disconnect`;
    await post(A.port, body(dcId, ["What should I do if my account is restricted?"]), { abortAfterMs: 800 });
    const dcRow = await turnRow(db, dcId);
    console.log(`row: answer_type=${dcRow?.["answer_type"]} response=${JSON.stringify(dcRow?.["assistant_response"])} note=${JSON.stringify(dcRow?.["confidence_note"])} cost=${dcRow?.["cost_usd_estimate"]}`);
    check(dcRow?.["answer_type"] === "error" && String(dcRow?.["confidence_note"]).includes("aborted: client disconnected"), "disconnect before speech: turn aborted and logged");

    console.log("\n== First-token timeout (server B, timeout 1500ms)");
    const B = await startServer(8798, { RELAYPAY_FIRST_TOKEN_TIMEOUT_MS: "1500" });
    servers.push(B);
    const toId = `test-ep-${RUN}-timeout`;
    const to = await post(B.port, body(toId, ["What fees does RelayPay charge?"]));
    const toRow = await turnRow(db, toId);
    console.log(`spoken: ${JSON.stringify(to.text)} in ${to.ms}ms | note=${JSON.stringify(toRow?.["confidence_note"])}`);
    check(to.text === "Sorry, I'm having trouble checking that right now. Could you try again in a moment?", "timeout: fallback line spoken");
    check(toRow?.["answer_type"] === "error" && String(toRow?.["confidence_note"]).includes("aborted: first-token timeout"), "timeout: answer_type error, agent aborted and logged");

    console.log("\n== Tool-list guard (server C, MCP entry missing)");
    const C = await startServer(8797, { RELAYPAY_MCP_ENTRY: resolve(REPO, "mcp-server", "dist", "does-not-exist.js") });
    servers.push(C);
    const gId = `test-ep-${RUN}-guard`;
    const g = await post(C.port, body(gId, ["What fees does RelayPay charge?"]));
    const gRow = await turnRow(db, gId);
    console.log(`spoken: ${JSON.stringify(g.text)} | note=${JSON.stringify(gRow?.["confidence_note"])}`);
    check(gRow?.["answer_type"] === "error" && String(gRow?.["confidence_note"]).includes("tool-list guard"), "guard: turn failed with answer_type error and logged");

    console.log("\n== Conversation totals recomputed from turns");
    const { data: conv } = await db.from("conversations").select("total_cost_usd, total_input_tokens, total_output_tokens, channel").eq("conversation_id", feesId).single();
    const { data: turns } = await db.from("conversation_turns").select("cost_usd_estimate, input_tokens, output_tokens").eq("conversation_id", feesId);
    const sumCost = (turns ?? []).reduce((t, r) => t + Number((r as { cost_usd_estimate: number | null }).cost_usd_estimate ?? 0), 0);
    console.log(`conversation: ${JSON.stringify(conv)} | sum of turns cost=${sumCost.toFixed(6)}`);
    check(Math.abs(Number(conv?.["total_cost_usd"]) - sumCost) < 1e-6 && conv?.["channel"] === "test", "totals equal SUM over turns; channel=test for test- ids");

    console.log("\n== Latency: 5 runs of the fees question");
    const firsts: number[] = [];
    const totals: number[] = [];
    const rows: Record<string, unknown>[] = [];
    for (let i = 0; i < 5; i++) {
      const id = `test-ep-${RUN}-latency-${i}`;
      await post(A.port, body(id, ["What fees does RelayPay charge for international payments?"]));
      const row = await turnRow(db, id);
      if (row) {
        rows.push(row);
        firsts.push(Number(row["ms_first_token"]));
        totals.push(Number(row["ms_total"]));
      }
    }
    console.table(rows.map((r) => ({ answer_type: r["answer_type"], ms_retrieval: r["ms_retrieval"], ms_first_token: r["ms_first_token"], ms_total: r["ms_total"], sdk_duration_ms: r["sdk_duration_ms"], ms_tools: r["ms_tools"], sdk_num_turns: r["sdk_num_turns"], cost: r["cost_usd_estimate"] })));
    console.log(`ms_first_token p50=${percentile(firsts, 50)} p95=${percentile(firsts, 95)} | ms_total p50=${percentile(totals, 50)} p95=${percentile(totals, 95)}`);
    console.log("\nper-run timing marks (ms from request receipt, from the server's turn log):");
    const markRows = A.logs
      .filter((l) => l.includes('"event":"turn"') && l.includes(`test-ep-${RUN}-latency-`))
      .map((l) => JSON.parse(l) as { conversation_id: string; marks: Record<string, number> })
      .map((e) => ({ run: e.conversation_id.slice(-1), ...e.marks }));
    console.table(markRows);
  } finally {
    for (const s of servers) s.proc.kill();
  }
  console.log(`\n${failures === 0 ? "TEST-ENDPOINT OK" : `TEST-ENDPOINT FAILED (${failures})`}`);
  return failures === 0 ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    console.error(`TEST-ENDPOINT ERROR: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
    process.exit(1);
  },
);
