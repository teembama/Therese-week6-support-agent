// End-to-end tests of POST /v/:token/chat/completions against local backend servers (real Agent SDK,
// real MCP server, real Supabase). Spawns:
//   A: normal server              (port 8799)
//   B: 1.5s first-token timeout   (port 8798)  -> fallback + abort
//   C: MCP server force-attached   (port 8797) -> forbidden search tool -> tool-list guard
// Usage: npm run test:endpoint [-- --latency-only] [-- --runs N]   (default 10 latency runs)

import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer as createNetServer } from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { createServiceClient, type Db } from "@relaypay/shared";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SERVER = resolve(REPO, "backend", "dist", "server.js");
const RUN = new Date().toISOString().replace(/[:.]/g, "-");

let failures = 0;
const check = (ok: boolean, label: string, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  ${detail}` : ""}`);
  if (!ok) failures++;
};

interface Server { proc: ChildProcess; port: number; logs: string[]; exitCode: number | null; injected: boolean }

async function startServer(port: number, extraEnv: Record<string, string> = {}): Promise<Server> {
  const proc = spawn(process.execPath, [SERVER], { env: { ...process.env, PORT: String(port), ...extraEnv }, stdio: ["ignore", "pipe", "pipe"] });
  const server: Server = { proc, port, logs: [], exitCode: null, injected: Boolean(extraEnv["RELAYPAY_FAULT_INJECT"]) };
  proc.stdout!.on("data", (d: Buffer) => server.logs.push(...d.toString().split("\n").filter(Boolean)));
  proc.stderr!.on("data", (d: Buffer) => server.logs.push(...d.toString().split("\n").filter(Boolean)));
  proc.on("exit", (code) => (server.exitCode = code));
  for (let i = 0; i < 100; i++) {
    if (server.logs.some((l) => l.includes('"event":"listening"'))) return server;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`server on ${port} did not start: ${server.logs.join(" | ")}`);
}

/** Every HTTP status the suite received, to assert that nothing ever returned a 5xx (D34). */
const STATUSES: Array<{ status: number; label: string }> = [];

const FALLBACK = "Sorry, I'm having trouble checking that right now. Could you try again in a moment?";
const THANKS_LINE = "You're welcome. Is there anything else I can help you with?";
const GOODBYE_LINE = "Thanks for calling RelayPay. Goodbye.";

interface Reply { status: number; source: string | null; text: string; events: unknown[]; raw: string; ms: number }

/** The valid chat path for the per-run test secret (D26: the token travels in the path). */
const chatPath = () => `/v/${process.env["VAPI_LLM_SECRET"]}/chat/completions`;

async function post(port: number, body: unknown, opts: { path?: string; method?: string; abortAfterMs?: number; rawBody?: string } = {}): Promise<Reply> {
  const t0 = performance.now();
  const controller = new AbortController();
  if (opts.abortAfterMs) setTimeout(() => controller.abort(), opts.abortAfterMs);
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  try {
    const res = await fetch(`http://localhost:${port}${opts.path ?? chatPath()}`, {
      method: opts.method ?? "POST",
      headers,
      signal: controller.signal,
      ...(opts.method === "GET" ? {} : { body: opts.rawBody ?? JSON.stringify(body) }),
    });
    STATUSES.push({ status: res.status, label: `${opts.method ?? "POST"} ${opts.path ? "custom path" : "chat"} :${port}` });
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

/** turn_attempts rows for a conversation, oldest first; waits until at least `min` exist and none is active. */
async function attemptsFor(db: Db, conversationId: string, min: number, waitMs = 15_000): Promise<Record<string, unknown>[]> {
  let rows: Record<string, unknown>[] = [];
  for (let waited = 0; waited <= waitMs; waited += 250) {
    const { data } = await db.from("turn_attempts").select("*").eq("conversation_id", conversationId).order("started_at");
    rows = (data ?? []) as Record<string, unknown>[];
    if (rows.length >= min && rows.every((r) => r["status"] !== "active")) return rows;
    await new Promise((r) => setTimeout(r, 250));
  }
  return rows;
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function turnRowCount(db: Db, conversationId: string): Promise<number> {
  const { count } = await db.from("conversation_turns").select("*", { count: "exact", head: true }).eq("conversation_id", conversationId);
  return count ?? 0;
}

const agentRunCount = (s: Server, conversationId: string) =>
  s.logs.filter((l) => l.includes('"event":"turn"') && l.includes(`"conversation_id":"${conversationId}"`)).length;

/**
 * Agent runs for a conversation, from the server's `turn` log lines. That line is written
 * after the turn row and the conversation totals, so wait for at least one before counting,
 * then settle briefly so a (wrong) second run would also have logged.
 */
async function agentRuns(s: Server, conversationId: string): Promise<number> {
  for (let waited = 0; waited < 10_000 && agentRunCount(s, conversationId) === 0; waited += 100) {
    await new Promise((r) => setTimeout(r, 100));
  }
  await new Promise((r) => setTimeout(r, 1_000));
  return agentRunCount(s, conversationId);
}

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
  const { values } = parseArgs({ options: { "latency-only": { type: "boolean" }, runs: { type: "string" }, "compare-mcp": { type: "boolean" } } });
  const latencyRuns = Number(values.runs ?? 10);
  process.loadEnvFile(resolve(REPO, ".env"));
  // Per-run secret for the spawned test servers (they inherit it; loadEnvFile does not
  // override variables that are already set). The real VAPI_LLM_SECRET is never needed here.
  process.env["VAPI_LLM_SECRET"] = `test-${randomBytes(24).toString("hex")}`; // 53 URL-safe chars
  const db = createServiceClient();
  const A = await startServer(8799);
  const servers = [A];
  try {
   if (!values["latency-only"]) {
    console.log("== HTTP surface");
    const secret = process.env["VAPI_LLM_SECRET"]!;
    const wrongToken = `wrong-${randomBytes(20).toString("hex")}`;
    const hiBody = body(`test-ep-${RUN}-surface`, ["hi"]);
    check((await post(A.port, hiBody, { path: `/v/${wrongToken}/chat/completions` })).status === 404, "wrong token -> 404 (not 401)");
    check((await post(A.port, hiBody, { path: "/v//chat/completions" })).status === 404, "empty token -> 404");
    check((await post(A.port, hiBody, { path: "/chat/completions" })).status === 404, "no token (old unprefixed route) -> 404");
    check((await post(A.port, hiBody, { path: `/v/${secret}/chat/completions/chat/completions` })).status === 404, "valid token, doubled suffix -> 404");
    check((await post(A.port, {}, { path: "/v1/chat/completions" })).status === 404, "other path -> 404");
    check((await post(A.port, {}, { method: "GET" })).status === 404, "GET on the valid path -> 404");
    // D34: behind a valid token, bad requests still get 200 + a fallback stream (never 4xx/5xx to Vapi).
    const noCallId = await post(A.port, { messages: [{ role: "user", content: "hi" }] });
    check(noCallId.status === 200 && noCallId.text === FALLBACK && sseWellFormed(noCallId), "valid token, missing call.id -> 200 + fallback stream");
    const badJson = await post(A.port, null, { rawBody: "{not json" });
    check(badJson.status === 200 && badJson.text === FALLBACK && sseWellFormed(badJson), "valid token, invalid JSON -> 200 + fallback stream");
    const huge = await post(A.port, null, { rawBody: JSON.stringify({ call: { id: `test-ep-${RUN}-huge` }, messages: [{ role: "user", content: "x".repeat(1_100_000) }] }) });
    check(huge.status === 200 && huge.text === FALLBACK, "valid token, oversized body -> 200 + fallback stream");
    check(A.logs.filter((l) => l.includes('"event":"bad_request"')).length >= 3, "bad requests logged as bad_request");
    check(A.logs.some((l) => l.includes('"event":"not_found"') && l.includes('"path":"/v/[redacted]/chat/completions"')), "wrong-token 404 logged with the redacted path");
    check(A.logs.some((l) => l.includes('"event":"not_found"') && l.includes('"path":"/v1/chat/completions"')), "unknown-path 404 logged with method and path");

    console.log("\n== Public web routes (D52): page, assets, /config, /health");
    const get = async (path: string, method = "GET") => {
      const r = await fetch(`http://localhost:${A.port}${path}`, { method });
      STATUSES.push({ status: r.status, label: `${method} ${path}` });
      return { status: r.status, headers: r.headers, text: await r.text() };
    };
    const page = await get("/");
    check(page.status === 200 && /text\/html/.test(page.headers.get("content-type") ?? "") && page.text.includes("Start call") && page.text.includes("End call") && page.text.includes('role="status"') && page.text.includes('aria-live="polite"'), "GET / -> the voice page (Start/End call, aria-live status)");
    const csp = page.headers.get("content-security-policy") ?? "";
    check(csp.includes("script-src 'self' https://esm.sh https://*.daily.co") && csp.includes("frame-ancestors 'none'") && page.headers.get("x-content-type-options") === "nosniff", "page has the CSP (scripts: self, esm.sh, Daily) and nosniff");
    const js = await get("/app.js");
    check(js.status === 200 && js.text.includes("https://esm.sh/@vapi-ai/web@2.7.1?deps=@daily-co/daily-js@0.87.0") && !/pk_|vapiPublicKey\s*=\s*["']/.test(js.text), "GET /app.js -> SDK pinned (web 2.7.1, daily-js 0.87.0); no key in the file");
    check((await get("/app.css")).status === 200, "GET /app.css -> 200");
    const cfg = await get("/config");
    const cfgJson = (() => { try { return JSON.parse(cfg.text) as Record<string, unknown>; } catch { return {}; } })();
    const expected = process.env["VAPI_PUBLIC_KEY"] && process.env["VAPI_ASSISTANT_ID"];
    check(expected
      ? cfg.status === 200 && JSON.stringify(Object.keys(cfgJson).sort()) === JSON.stringify(["vapiAssistantId", "vapiPublicKey"]) && cfgJson["vapiPublicKey"] === process.env["VAPI_PUBLIC_KEY"] && cfgJson["vapiAssistantId"] === process.env["VAPI_ASSISTANT_ID"]
      : cfg.status === 503, "GET /config -> exactly the two public Vapi values from env (values not printed)");
    const health = await get("/health");
    check(health.status === 200 && health.text === '{"status":"ok"}', "GET /health -> {\"status\":\"ok\"} and nothing else");
    check((await get("/", "HEAD")).status === 200 && (await get("/nope")).status === 404 && (await get("/config", "POST")).status === 404, "HEAD / -> 200; unknown GET -> 404; POST /config -> 404");
    check(csp.includes("report-uri /csp-report"), "CSP reports violations to /csp-report");
    const cspPost = await fetch(`http://localhost:${A.port}/csp-report`, { method: "POST", headers: { "Content-Type": "application/csp-report" }, body: JSON.stringify({ "csp-report": { "effective-directive": "script-src-elem", "blocked-uri": "https://c.daily.co/static/call-machine-object-bundle.js?token=SECRET-MARKER", "source-file": "https://esm.sh/x.mjs" } }) });
    STATUSES.push({ status: cspPost.status, label: "POST /csp-report" });
    await new Promise((r) => setTimeout(r, 200));
    const cspLog = A.logs.find((l) => l.includes('"event":"csp_violation"')) ?? "";
    check(cspPost.status === 204 && cspLog.includes('"directive":"script-src-elem"') && cspLog.includes('"blocked":"c.daily.co"') && !cspLog.includes("SECRET-MARKER"), "POST /csp-report -> 204; logged directive and blocked host only (no path or query)");

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
    const { data: t2Logs } = await db.from("retrieval_logs").select("query").eq("conversation_id", feesId).eq("turn_index", 1);
    const t2Query = String((t2Logs?.[0] as { query?: string } | undefined)?.query ?? "");
    console.log("turn 1 retrieval query: " + JSON.stringify(t2Query));
    check(t2Query.startsWith("What fees does RelayPay charge") && t2Query.endsWith("And how long do payouts to Kenya take?"), "follow-up (<5 meaningful words): retrieval searched previous + latest, and logged that query");

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
    console.log(`1st source=${s1.source} ${s1.ms}ms | 2nd source=${s2.source} ${s2.ms}ms | agent runs=${await agentRuns(A, seqId)} | cost=${seqRow?.["cost_usd_estimate"]}`);
    check(s1.source === "agent" && s2.source === "replay", "second request replayed from the stored turn");
    check(s1.text === s2.text && s1.text.length > 0, "replay streams the same text");
    check((await turnRowCount(db, seqId)) === 1 && (await agentRuns(A, seqId)) === 1, "exactly one turn row and one agent run (one result, one cost)");

    console.log("\n== Same request twice, concurrently");
    const conId = `test-ep-${RUN}-concurrent`;
    const conBody = body(conId, ["Can I create invoices in multiple currencies?"]);
    const [c1, c2] = await Promise.all([post(A.port, conBody), post(A.port, conBody)]);
    await turnRow(db, conId);
    await new Promise((r) => setTimeout(r, 500));
    console.log(`sources: ${c1.source}, ${c2.source} | agent runs=${await agentRuns(A, conId)}`);
    check([c1.source, c2.source].sort().join(",") === "agent,inflight", "one request ran the agent, the other joined it in flight");
    check(c1.text === c2.text && c1.text.length > 0, "both streamed the same text");
    check((await turnRowCount(db, conId)) === 1 && (await agentRuns(A, conId)) === 1, "exactly one turn row and one agent run");

    console.log("\n== Client disconnect aborts the agent");
    const dcId = `test-ep-${RUN}-disconnect`;
    await post(A.port, body(dcId, ["What should I do if my account is restricted?"]), { abortAfterMs: 800 });
    const dcAttempts = await attemptsFor(db, dcId, 1);
    console.log(`attempts: ${JSON.stringify(dcAttempts.map((a) => ({ status: a["status"], reason: a["status_reason"], cost: a["cost_usd_estimate"] })))}`);
    check(dcAttempts.length === 1 && dcAttempts[0]!["status"] === "aborted" && dcAttempts[0]!["status_reason"] === "client disconnected before any speech", "disconnect before speech: attempt recorded as aborted");
    check((await turnRowCount(db, dcId)) === 0, "disconnect before speech: no turn row (nothing to replay)");

    // ---- Vapi's real behaviour (live call 01a0eece…, D28) ----
    console.log("\n== Speculative sequence: partial A disconnects, fuller B answers");
    const specId = `test-ep-${RUN}-speculative`;
    const partial = await post(A.port, body(specId, ["What fees does"]), { abortAfterMs: 900 });
    const full = await post(A.port, body(specId, ["What fees does RelayPay charge for international payments?"]));
    const specRow = await turnRow(db, specId);
    const specAttempts = await attemptsFor(db, specId, 2);
    console.log(`A: status ${partial.status} (client aborted) | B: source=${full.source} spoken=${JSON.stringify(full.text.slice(0, 120))}`);
    console.log(`attempts: ${JSON.stringify(specAttempts.map((a) => ({ id: a["attempt_id"], status: a["status"], replaced_by: a["replaced_by"], transcript: a["user_transcript"] })))}`);
    const attA = specAttempts.find((a) => a["user_transcript"] === "What fees does");
    const attB = specAttempts.find((a) => a["user_transcript"] !== "What fees does");
    check(full.source === "agent" && full.text.length > 0 && !full.text.startsWith("Sorry, I'm having trouble"), "B gets a real answer (not the fallback)");
    check(attA?.["status"] === "replaced" && attA?.["replaced_by"] === attB?.["attempt_id"], "A recorded as replaced by B");
    check(specRow?.["attempt_id"] === attB?.["attempt_id"] && specRow?.["assistant_response"] === full.text, "B's answer is stored as the turn");

    console.log("\n== Identical retry of B");
    const runsBefore = await agentRuns(A, specId);
    const retryB = await post(A.port, body(specId, ["What fees does RelayPay charge for international payments?"]));
    console.log(`retry: source=${retryB.source}`);
    check(retryB.source === "replay" && retryB.text === full.text, "identical retry replays B's stored answer");
    check((await attemptsFor(db, specId, 2)).length === 2 && (await agentRuns(A, specId)) === runsBefore, "no new attempt and no new agent run");

    console.log("\n== Disconnect before speaking, then the identical request");
    const againId = `test-ep-${RUN}-again`;
    await post(A.port, body(againId, ["How long do local payouts take?"]), { abortAfterMs: 900 });
    const again = await post(A.port, body(againId, ["How long do local payouts take?"]));
    const againAttempts = await attemptsFor(db, againId, 2);
    console.log(`second: source=${again.source} spoken=${JSON.stringify(again.text.slice(0, 100))} | attempts: ${JSON.stringify(againAttempts.map((a) => a["status"]))}`);
    check(again.source === "agent" && again.text.length > 0 && !again.text.startsWith("Sorry, I'm having trouble"), "identical request runs fresh and answers (never replays 'nothing')");
    check(againAttempts.map((a) => a["status"]).join(",") === "aborted,completed", "attempts: first aborted, second completed");

    console.log("\n== Replacement while the first attempt is still in flight");
    const liveId = `test-ep-${RUN}-inflight-replace`;
    const first = post(A.port, body(liveId, ["Why is my"]));
    await new Promise((r) => setTimeout(r, 600));
    const second = await post(A.port, body(liveId, ["Why is my payment delayed?"]));
    const firstReply = await first;
    const liveAttempts = await attemptsFor(db, liveId, 2);
    console.log(`first: spoken=${JSON.stringify(firstReply.text)} | second: source=${second.source} spoken=${JSON.stringify(second.text.slice(0, 100))}`);
    console.log(`attempts: ${JSON.stringify(liveAttempts.map((a) => ({ status: a["status"], reason: a["status_reason"] })))}`);
    check(firstReply.text === "" && second.text.length > 0 && !second.text.startsWith("Sorry, I'm having trouble"), "replaced attempt speaks nothing; the new one answers");
    check(liveAttempts.map((a) => a["status"]).join(",") === "replaced,completed", "attempts: first replaced, second completed");

    console.log("\n== Aborted attempts leave no process behind");
    const killLines = A.logs.filter((l) => l.includes('"event":"process_tree_killed"')).map((l) => JSON.parse(l) as { killed_pids: number[]; root_pid: number });
    await new Promise((r) => setTimeout(r, 1_500));
    const survivors = killLines.flatMap((k) => [k.root_pid, ...k.killed_pids]).filter(isPidAlive);
    console.log(`process_tree_killed events: ${killLines.length}; pids: ${JSON.stringify(killLines.map((k) => k.killed_pids))}; still alive: ${JSON.stringify(survivors)}`);
    check(killLines.length >= 3 && survivors.length === 0, "every aborted attempt's CLI process tree is gone");

    console.log("\n== First-token timeout (server B, timeout 1500ms)");
    const B = await startServer(8798, { RELAYPAY_FIRST_TOKEN_TIMEOUT_MS: "1500" });
    servers.push(B);
    const toId = `test-ep-${RUN}-timeout`;
    const to = await post(B.port, body(toId, ["What fees does RelayPay charge?"]));
    const toRow = await turnRow(db, toId);
    console.log(`spoken: ${JSON.stringify(to.text)} in ${to.ms}ms | note=${JSON.stringify(toRow?.["confidence_note"])}`);
    check(to.text === "Sorry, I'm having trouble checking that right now. Could you try again in a moment?", "timeout: fallback line spoken");
    check(toRow?.["answer_type"] === "error" && String(toRow?.["confidence_note"]).includes("aborted: first-token timeout"), "timeout: answer_type error, agent aborted and logged");

    console.log("\n== Tool-list guard (server C, MCP server with the full toolset -> search_knowledge_base visible)");
    const C = await startServer(8797, { RELAYPAY_TEST_MCP_TOOLSET: "all" });
    servers.push(C);
    const gId = `test-ep-${RUN}-guard`;
    const g = await post(C.port, body(gId, ["What fees does RelayPay charge?"]));
    const gRow = await turnRow(db, gId);
    console.log(`spoken: ${JSON.stringify(g.text)} | note=${JSON.stringify(gRow?.["confidence_note"])}`);
    check(gRow?.["answer_type"] === "error" && String(gRow?.["confidence_note"]).includes("forbidden tool(s) present: mcp__relaypay__search_knowledge_base"), "guard: search_knowledge_base present -> turn failed (error) and logged");
    // The guard abort must kill the CLI AND the MCP server it spawned.
    await new Promise((r) => setTimeout(r, 1_500));
    const gKill = C.logs.filter((l) => l.includes('"event":"process_tree_killed"')).map((l) => JSON.parse(l) as { killed_pids: number[]; root_pid: number });
    const gPids = gKill.flatMap((k) => k.killed_pids);
    console.log(`guard abort killed pids: ${JSON.stringify(gPids)}; still alive: ${JSON.stringify(gPids.filter(isPidAlive))}`);
    check(gPids.length >= 2 && gPids.filter(isPidAlive).length === 0, "guard abort: CLI and MCP server process tree terminated, nothing left running");

    console.log("\n== Conversation totals recomputed from turns");
    const { data: conv } = await db.from("conversations").select("total_cost_usd, total_input_tokens, total_output_tokens, channel").eq("conversation_id", feesId).single();
    const { data: turns } = await db.from("conversation_turns").select("cost_usd_estimate, input_tokens, output_tokens").eq("conversation_id", feesId);
    const sumCost = (turns ?? []).reduce((t, r) => t + Number((r as { cost_usd_estimate: number | null }).cost_usd_estimate ?? 0), 0);
    console.log(`conversation: ${JSON.stringify(conv)} | sum of turns cost=${sumCost.toFixed(6)}`);
    check(Math.abs(Number(conv?.["total_cost_usd"]) - sumCost) < 1e-6 && conv?.["channel"] === "test", "totals equal SUM over turns; channel=test for test- ids");

    console.log("\n== Vapi end-of-call webhook (D50): POST /v/<token>/vapi/events");
    const eventsPath = `/v/${secret}/vapi/events`;
    // Recorded shape (ServerMessageEndOfCallReport, https://api.vapi.ai/api-json); values made up.
    const report = (callId: string, endedReason: string) => ({
      message: {
        type: "end-of-call-report", timestamp: 1790000000000, endedReason,
        startedAt: "2026-09-30T12:00:00.000Z", endedAt: "2026-09-30T12:01:30.000Z", cost: 0.12,
        call: { id: callId, type: "webCall", assistantId: "asst-test" },
        customer: { number: "+2348000000000" },
        analysis: { summary: "VAPI-OWN-SUMMARY-MARKER" },
        artifact: {
          transcript: "AI: Hello. User: TRANSCRIPT-MARKER amara at lagos ledger dot example",
          messages: [{ role: "bot", message: "Hello" }],
          performanceMetrics: {
            turnLatencies: [{ modelLatency: 620, voiceLatency: 210, transcriberLatency: 180, endpointingLatency: 300, turnLatency: 1310 }],
            modelLatencyAverage: 620, voiceLatencyAverage: 210, transcriberLatencyAverage: 180, endpointingLatencyAverage: 300, turnLatencyAverage: 1310,
          },
        },
      },
    });
    const recorded = async (id: string, n: number) => {
      for (let i = 0; i < 60 && A.logs.filter((l) => l.includes('"event":"vapi_end_of_call"') && l.includes(`"conversation_id":"${id}"`)).length < n; i++) await new Promise((r) => setTimeout(r, 250));
      const { data } = await db.from("conversations").select("ended_at, ended_reason, final_status, vapi_metrics, summary, total_cost_usd").eq("conversation_id", id).maybeSingle();
      return data as Record<string, unknown> | null;
    };
    const firstEvent = await post(A.port, report(feesId, "customer-ended-call"), { path: eventsPath });
    const row1 = await recorded(feesId, 1);
    console.log(`first delivery: HTTP ${firstEvent.status} in ${firstEvent.ms}ms | ${JSON.stringify(row1).slice(0, 400)}`);
    check(firstEvent.status === 200 && firstEvent.ms < 1_000, "end-of-call-report acknowledged with 200 fast (< 1 s; recorded afterwards)");
    check(row1?.["ended_reason"] === "customer-ended-call" && row1?.["final_status"] === "completed" && row1?.["ended_at"] !== null, "ended_reason and ended_at set; customer-ended-call -> completed");
    const pm = ((row1?.["vapi_metrics"] ?? {}) as Record<string, unknown>)["performance_metrics"] as Record<string, unknown> | undefined;
    check(pm?.["turnLatencyAverage"] === 1310 && Array.isArray(pm?.["turnLatencies"]) && (pm?.["turnLatencies"] as unknown[]).length === 1, "vapi_metrics has turnLatencies and the averages");
    const { data: feesTurns } = await db.from("conversation_turns").select("answer_type").eq("conversation_id", feesId);
    const nTurns = (feesTurns ?? []).length;
    const expectedSummary = `${nTurns} turn${nTurns === 1 ? "" : "s"} (answer ${nTurns}). Identity: not attempted. Tickets: 0. Escalations: 0. Ended: customer-ended-call.`;
    check(row1?.["summary"] === expectedSummary && (feesTurns ?? []).every((t) => (t as { answer_type: string }).answer_type === "answer"), "deterministic summary from our own records", `${String(row1?.["summary"])} vs ${expectedSummary}`);
    check(!/TRANSCRIPT-MARKER|VAPI-OWN-SUMMARY-MARKER|\+234|amara/i.test(JSON.stringify(row1)), "transcript, Vapi's summary and customer details are not stored");
    const dup = await post(A.port, report(feesId, "customer-ended-call"), { path: eventsPath });
    const row2 = await recorded(feesId, 2);
    check(dup.status === 200 && JSON.stringify(row2) === JSON.stringify(row1), "duplicate delivery -> 200, identical row (idempotent)");
    const unknownType = await post(A.port, { message: { type: "status-update", status: "in-progress", call: { id: feesId } } }, { path: eventsPath });
    await new Promise((r) => setTimeout(r, 500));
    const row3 = await recorded(feesId, 2);
    check(unknownType.status === 200 && JSON.stringify(row3) === JSON.stringify(row1) && A.logs.some((l) => l.includes('"event":"vapi_event_ignored"') && l.includes('"type":"status-update"')), "unknown message type -> 200, ignored and logged, row unchanged");
    check((await post(A.port, report(feesId, "customer-ended-call"), { path: `/v/${wrongToken}/vapi/events` })).status === 404, "wrong token on the events route -> 404");
    const noTurnsId = `test-ep-${RUN}-webhook-no-turns`;
    await post(A.port, report(noTurnsId, "pipeline-error-custom-llm-llm-failed"), { path: eventsPath });
    const row4 = await recorded(noTurnsId, 1);
    check(row4?.["final_status"] === "failed" && String(row4?.["summary"]).startsWith("0 turns. Identity: not attempted.") , "a call with no turns gets a row; error ending -> failed", JSON.stringify(row4).slice(0, 200));
    check(!A.logs.some((l) => /TRANSCRIPT-MARKER|VAPI-OWN-SUMMARY-MARKER|\+2348000000000/.test(l)), "webhook logs carry no transcript, summary or customer details");
    check(A.logs.some((l) => l.includes('"event":"stale_sweep"') && /"abandoned":\d+/.test(l)), "stale sweep ran at startup and logged its count (D51)");

    console.log("\n== Debug request-shape log (server E, RELAYPAY_DEBUG_REQUEST_SHAPE=1)");
    const E = await startServer(8795, { RELAYPAY_DEBUG_REQUEST_SHAPE: "1" });
    servers.push(E);
    const marker = "UNIQUE-CONTENT-MARKER-7f3a";
    await post(E.port, body(`test-ep-${RUN}-debug`, [`What fees does RelayPay charge? ${marker}`]));
    await post(E.port, hiBody, { path: `/v/${wrongToken}/chat/completions` });
    const debugLines = E.logs.filter((l) => l.includes('"event":"debug_request_shape"'));
    for (const l of debugLines) console.log(`  ${l.slice(0, 400)}`);
    check(debugLines.some((l) => l.includes('"token_ok":true') && l.includes('"body_shape"')) && debugLines.some((l) => l.includes('"token_ok":false')), "debug log: structure for token ok and token failed");
    check(!debugLines.some((l) => l.includes(marker) || l.includes(secret) || l.includes(wrongToken)), "debug log: no message content, no token");

    console.log("\n== Model fallback (D49): unknown primary model -> one retry with AGENT_MODEL_FALLBACK");
    const F = await startServer(8789, { AGENT_MODEL: "claude-nonexistent-0-0", AGENT_MODEL_FALLBACK: "claude-haiku-4-5" });
    servers.push(F);
    const fbId = `test-ep-${RUN}-model-fallback`;
    const fb = await post(F.port, body(fbId, ["What fees does RelayPay charge for international payments?"]));
    const fbRow = await turnRow(db, fbId);
    const fbLog = F.logs.find((l) => l.includes('"event":"model_fallback"')) ?? "";
    console.log(`spoken in ${fb.ms}ms: ${JSON.stringify(fb.text.slice(0, 120))} | model=${fbRow?.["model"]} | ${fbLog.slice(0, 220)}`);
    check(fbRow?.["answer_type"] === "answer" && fbRow?.["model"] === "claude-haiku-4-5", "unknown primary -> answered by the fallback model, recorded as claude-haiku-4-5");
    check(fbLog.includes('"retried":true') && fbLog.includes('"from":"claude-nonexistent-0-0"') && fbLog.includes('"to":"claude-haiku-4-5"'), "model_fallback logged (from, to, retried)");
    check(String(fbRow?.["confidence_note"]).includes("model fallback: claude-nonexistent-0-0 -> claude-haiku-4-5"), "turn note records the fallback");
    const G = await startServer(8788, { AGENT_MODEL: "claude-nonexistent-0-0", AGENT_MODEL_FALLBACK: "" });
    servers.push(G);
    const nfId = `test-ep-${RUN}-model-no-fallback`;
    const nf = await post(G.port, body(nfId, ["What fees does RelayPay charge for international payments?"]));
    const nfRow = await turnRow(db, nfId);
    check(nf.status === 200 && nf.text === FALLBACK && nfRow?.["answer_type"] === "error", "unknown primary and no fallback set -> 200 + fallback line, answer_type error");
    check(G.logs.some((l) => l.includes('"event":"model_fallback"') && l.includes('"retried":false')), "model_fallback logged with retried:false");
    G.proc.kill();
    F.proc.kill();
   }

    const variants: Array<{ name: string; server: Server }> = [{ name: "default", server: A }];
    if (values["compare-mcp"]) {
      // Batch 2C step 1: the same KB-only question without the MCP server attached (baseline).
      const D = await startServer(8794, { RELAYPAY_TEST_DETACH_MCP: "1" });
      servers.push(D);
      variants.unshift({ name: "no-mcp", server: D });
    }
    console.log(`\n== Latency: ${latencyRuns} runs of the fees question per variant (${variants.map((v) => v.name).join(", ")})`);
    const results = new Map(variants.map((v) => [v.name, { firsts: [] as number[], totals: [] as number[], rows: [] as Record<string, unknown>[] }]));
    for (let i = 0; i < latencyRuns; i++) {
      for (const v of variants) {
        const id = `test-ep-${RUN}-latency-${v.name}-${i}`;
        await post(v.server.port, body(id, ["What fees does RelayPay charge for international payments?"]));
        const row = await turnRow(db, id);
        const r = results.get(v.name)!;
        if (row) {
          r.rows.push(row);
          r.firsts.push(Number(row["ms_first_token"]));
          r.totals.push(Number(row["ms_total"]));
        }
      }
    }
    for (const v of variants) {
      const r = results.get(v.name)!;
      console.log(`\n-- variant ${v.name}`);
      console.table(r.rows.map((x) => ({ answer_type: x["answer_type"], ms_retrieval: x["ms_retrieval"], ms_first_token: x["ms_first_token"], ms_total: x["ms_total"], sdk_duration_ms: x["sdk_duration_ms"], input_tokens: x["input_tokens"], output_tokens: x["output_tokens"], cost: x["cost_usd_estimate"] })));
      console.log(`[${v.name}] ms_first_token p50=${percentile(r.firsts, 50)} p95=${percentile(r.firsts, 95)} | ms_total p50=${percentile(r.totals, 50)} p95=${percentile(r.totals, 95)} | errors=${r.rows.filter((x) => x["answer_type"] === "error").length}`);
      console.log(`[${v.name}] per-run timing marks (ms from request receipt, from the server's turn log):`);
      console.table(v.server.logs
        .filter((l) => l.includes('"event":"turn"') && l.includes(`test-ep-${RUN}-latency-${v.name}-`))
        .map((l) => JSON.parse(l) as { conversation_id: string; marks: Record<string, number> })
        .map((e) => ({ run: e.conversation_id.split("-").pop(), ...e.marks })));
    }
    console.log("\n== Social fast path (D35): fixed line, no model call");
    const fpThanks = `test-ep-${RUN}-fp-thanks`;
    const t1 = await post(A.port, body(fpThanks, ["All right, thank you."]));
    const fpBye = `test-ep-${RUN}-fp-bye`;
    const t2 = await post(A.port, body(fpBye, ["Thank you.", "No, I'm good."], [THANKS_LINE]));
    const fpNo = `test-ep-${RUN}-fp-bare-no`;
    const t3 = await post(A.port, body(fpNo, ["No."]));
    const fpRow1 = await turnRow(db, fpThanks);
    const fpRow2 = await turnRow(db, fpBye, 1);
    const fastLines = A.logs.filter((l) => l.includes('"fast_path":true'));
    console.log(`thanks: ${t1.ms}ms ${JSON.stringify(t1.text)} | goodbye: ${t2.ms}ms ${JSON.stringify(t2.text)} | bare "no": ${JSON.stringify(t3.text.slice(0, 80))}`);
    check(t1.text === THANKS_LINE && fpRow1?.["answer_type"] === "social" && String(fpRow1?.["confidence_note"]).startsWith("fast_path"), "'All right, thank you.' -> thanks line, social, note fast_path");
    check(t2.text === GOODBYE_LINE && fpRow2?.["answer_type"] === "social", "'No, I'm good.' after 'anything else?' -> goodbye line");
    check(fastLines.some((l) => l.includes(fpThanks)) && fastLines.some((l) => l.includes(fpBye)) && !fastLines.some((l) => l.includes(fpNo)), "fast path used for both; a bare 'no' without context went to the model");
    const fpTurnLines = A.logs.filter((l) => l.includes('"event":"turn"') && (l.includes(fpThanks) || l.includes(fpBye)));
    check(fpTurnLines.length === 2 && fpTurnLines.every((l) => l.includes('"fast_path":true') && l.includes('"cost_usd_estimate":0')), "one turn each, no model call (cost 0)");

    console.log("\n== Never a 500 (D34): database unreachable / slow, injected faults");
    const probe = async (label: string, extraEnv: Record<string, string>, msgs: string[]) => {
      const s = await startServer(8791, extraEnv);
      const id = `test-ep-${RUN}-${label}`;
      const r = await post(s.port, body(id, msgs));
      await new Promise((res) => setTimeout(res, 1_500));
      if (s.exitCode === null) s.proc.kill();
      await new Promise((res) => setTimeout(res, 500));
      return { r, s, id };
    };
    const unreach = await probe("db-unreachable", { SUPABASE_URL: "https://relaypay-unreachable.invalid" }, ["What fees does RelayPay charge?"]);
    console.log(`db unreachable: HTTP ${unreach.r.status} in ${unreach.r.ms}ms ${JSON.stringify(unreach.r.text)}`);
    check(unreach.r.status === 200 && unreach.r.text === FALLBACK && sseWellFormed(unreach.r) && unreach.r.ms < 4_500, "database unreachable -> 200 + fallback within ~4s");

    const held = new Set<import("node:net").Socket>();
    const blackhole = createNetServer((sock) => {
      // Accept and never answer; resets from the killed server are expected.
      sock.on("error", () => {});
      held.add(sock);
    });
    await new Promise<void>((r) => blackhole.listen(8790, "127.0.0.1", () => r()));
    const slow = await probe("db-slow", { SUPABASE_URL: "http://127.0.0.1:8790" }, ["What fees does RelayPay charge?"]);
    console.log(`db never answers: HTTP ${slow.r.status} in ${slow.r.ms}ms ${JSON.stringify(slow.r.text)}`);
    check(slow.r.status === 200 && slow.r.text === FALLBACK && slow.r.ms < 4_500, "database never answers -> 200 + fallback within ~4s (budget 3.5s)");
    const slowThanks = await probe("db-slow-thanks", { SUPABASE_URL: "http://127.0.0.1:8790" }, ["Thank you."]);
    console.log(`fast path with a dead database: ${slowThanks.r.ms}ms ${JSON.stringify(slowThanks.r.text)}`);
    check(slowThanks.r.text === THANKS_LINE && slowThanks.r.ms < 1_000, "fast path speaks without waiting for the database");
    for (const sock of held) sock.destroy();
    blackhole.close();

    const inHandler = await probe("fault-handler", { RELAYPAY_FAULT_INJECT: "throw_in_handler" }, ["What fees does RelayPay charge?"]);
    check(inHandler.r.status === 200 && inHandler.r.text === FALLBACK && inHandler.s.logs.some((l) => l.includes('"event":"request_error"') && l.includes('"stack"')), "exception in the handler -> 200 + fallback, logged with stack");
    const inTurn = await probe("fault-turn", { RELAYPAY_FAULT_INJECT: "throw_in_turn" }, ["What fees does RelayPay charge?"]);
    const inTurnAttempts = await attemptsFor(db, inTurn.id, 1);
    console.log(`exception in the turn: ${JSON.stringify(inTurn.r.text)} | attempt: ${JSON.stringify(inTurnAttempts.map((a) => [a["status"], a["status_reason"]]))}`);
    check(inTurn.r.status === 200 && inTurn.r.text === FALLBACK && inTurnAttempts[0]?.["status"] === "failed", "exception in the turn -> 200 + fallback; attempt ends 'failed'");
    const rejection = await probe("fault-rejection", { RELAYPAY_FAULT_INJECT: "unhandled_rejection" }, ["What fees does RelayPay charge?"]);
    const rejLine = rejection.s.logs.find((l) => l.includes('"event":"unhandled_rejection"')) ?? "";
    check(rejection.r.status === 200 && rejection.r.text === FALLBACK && rejLine.includes('"request_identified":true'), "unhandled rejection -> logged, identified, its request gets the fallback");
    const crash = await probe("fault-uncaught", { RELAYPAY_FAULT_INJECT: "uncaught_exception" }, ["What fees does RelayPay charge?"]);
    const crashLine = crash.s.logs.find((l) => l.includes('"event":"uncaught_exception"')) ?? "";
    console.log(`uncaught exception: server exit code ${crash.s.exitCode}; request status ${crash.r.status}`);
    check(crash.s.exitCode === 1 && crashLine.includes('"stack"') && !crashLine.includes("What fees"), "uncaught exception -> logged (stack, no content) and exit(1) for the host to restart");
    for (const x of [unreach, slow, slowThanks, inHandler, inTurn, rejection, crash]) servers.push(x.s);

    console.log("\n== Token never logged (every server, every stdout/stderr line)");
    const allLines = servers.flatMap((s) => s.logs);
    const leaks = allLines.filter((l) => l.includes(process.env["VAPI_LLM_SECRET"]!) || /\/v\/wrong-[0-9a-f]{40}/.test(l));
    console.log(`scanned ${allLines.length} log lines; lines containing a token: ${leaks.length}`);
    check(leaks.length === 0, "no log line contains the real or the wrong token");
    const fiveHundreds = STATUSES.filter((s) => s.status >= 500);
    console.log(`responses received: ${STATUSES.length}; 5xx: ${fiveHundreds.length} ${JSON.stringify(fiveHundreds)}`);
    check(fiveHundreds.length === 0, "no response in the whole suite returned a 5xx");
    const rejections = servers.filter((s) => !s.injected).flatMap((s) => s.logs).filter((l) => l.includes('"event":"unhandled_rejection"'));
    check(rejections.length === 0, "zero unhandled rejections on every server without injected faults", rejections.slice(0, 2).join(" | "));
    const serverErrors = allLines.filter((l) => /\[relaypay\]|"event":"request_error"/.test(l));
    if (serverErrors.length) {
      console.log(`\nserver-side error lines (${serverErrors.length}):`);
      for (const l of serverErrors) console.log(`  ${l.slice(0, 300)}`);
    }
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
