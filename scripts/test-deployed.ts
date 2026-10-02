// Batch 2D Part B: the deployed backend, over HTTPS. The subset of test:endpoint that works
// against a remote host (no local server knobs, fault injection or process-tree checks), plus
// latency runs measured SERVER-SIDE (turn rows and the turn log's marks from `railway logs`).
//
// Usage: npm run test:deployed -- --base-url https://<domain> [--kb-runs 10] [--s4-runs 10] [--cap 0.15]
// Needs .env (the same VAPI_LLM_SECRET as the Railway service) and the Railway CLI linked to the project.

import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServiceClient, type Db } from "@relaypay/shared";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const arg = (flag: string) => { const i = process.argv.indexOf(flag); return i >= 0 ? process.argv[i + 1] : undefined; };
const BASE = (arg("--base-url") ?? "").replace(/\/$/, "");
const KB_RUNS = Number(arg("--kb-runs") ?? 10);
const S4_RUNS = Number(arg("--s4-runs") ?? 10);
const CAP = Number(arg("--cap") ?? 0.15);
const RUN = new Date().toISOString().replace(/[:.]/g, "-");
const FALLBACK = "Sorry, I'm having trouble checking that right now. Could you try again in a moment?";
const THANKS_LINE = "You're welcome. Is there anything else I can help you with?";

type Row = Record<string, unknown>;
let failures = 0;
/**
 * D88/D92: with call passes required, every conversation carries a real one-time GUEST pass (the
 * call page's "Continue as a guest" path), inserted as its hash just before its first request.
 */
const passes = new Map<string, string>();
const pendingPassHashes: string[] = [];
let passDb: Db | null = null;
function passOf(callId: string): string {
  let p = passes.get(callId);
  if (!p) {
    p = randomBytes(32).toString("base64url");
    passes.set(callId, p);
    pendingPassHashes.push(createHash("sha256").update(p).digest("hex"));
  }
  return p;
}
async function flushPasses(): Promise<void> {
  if (!passDb || pendingPassHashes.length === 0) return;
  const rows = pendingPassHashes.splice(0).map((pass_hash) => ({ pass_hash, source: "guest" }));
  const { error } = await passDb.from("call_passes").insert(rows);
  if (error) throw new Error(`guest pass insert failed: ${error.message}`);
}
const check = (ok: boolean, label: string, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail && !ok ? `  -> ${detail}` : ""}`);
  if (!ok) failures++;
};
const statuses: number[] = [];

interface Reply { status: number; source: string | null; text: string; raw: string; ms: number }

async function post(path: string, body: unknown, opts: { raw?: string; abortAfterMs?: number; method?: string } = {}): Promise<Reply> {
  await flushPasses();
  const t0 = performance.now();
  const ctl = new AbortController();
  if (opts.abortAfterMs) setTimeout(() => ctl.abort(), opts.abortAfterMs);
  try {
    const res = await fetch(`${BASE}${path}`, {
      method: opts.method ?? "POST", headers: { "Content-Type": "application/json" }, signal: ctl.signal,
      ...(opts.method === "GET" ? {} : { body: opts.raw ?? JSON.stringify(body) }),
    });
    statuses.push(res.status);
    const raw = await res.text();
    const text = raw.split("\n").filter((l) => l.startsWith("data: ") && l !== "data: [DONE]")
      .map((l) => { try { return (JSON.parse(l.slice(6)) as { choices: Array<{ delta: { content?: string } }> }).choices[0]?.delta.content ?? ""; } catch { return ""; } })
      .join("").replace(/\s+/g, " ").trim();
    return { status: res.status, source: res.headers.get("x-relaypay-turn-source"), text, raw, ms: Math.round(performance.now() - t0) };
  } catch (err) {
    return { status: -1, source: null, text: "", raw: String(err), ms: Math.round(performance.now() - t0) };
  }
}

const chat = () => `/v/${process.env["VAPI_LLM_SECRET"]}/chat/completions`;
const events = () => `/v/${process.env["VAPI_LLM_SECRET"]}/vapi/events`;
const body = (callId: string, users: string[], agents: string[] = []) => ({
  model: "relaypay-agent", stream: true, call: { id: callId, assistantOverrides: { variableValues: { callPass: passOf(callId) } } },
  messages: [{ role: "system", content: "placeholder" }, ...users.flatMap((u, i) => [{ role: "user", content: u }, ...(agents[i] ? [{ role: "assistant", content: agents[i] }] : [])])],
});

async function turnRow(db: Db, id: string, idx = 0): Promise<Row | null> {
  for (let i = 0; i < 120; i++) {
    const { data } = await db.from("conversation_turns").select("*").eq("conversation_id", id).eq("turn_index", idx).maybeSingle();
    if (data) return data as Row;
    await new Promise((r) => setTimeout(r, 250));
  }
  return null;
}

/** Turn-log entries from the deployed service (Railway flattens our JSON log lines). */
function railwayLogsOnce(lines: number): Row[] {
  const r = spawnSync("railway", ["logs", "--service", "relaypay-backend", "--deployment", "--lines", String(lines), "--json"], { encoding: "utf8", shell: true, timeout: 90_000, maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) console.log(`  railway logs exited ${r.status}${r.error ? ` (${r.error.message})` : ""}`);
  return (r.stdout ?? "").split("\n").map((l) => { try { return JSON.parse(l) as Row; } catch { return null; } }).filter((x): x is Row => x !== null);
}

/** Railway ingests logs with a delay: poll until every expected conversation has its turn event (max ~90 s). */
export async function railwayLogs(expectTurnFor: string[] = [], lines = 3000): Promise<Row[]> {
  let rows: Row[] = [];
  for (let i = 0; i < 9; i++) {
    rows = railwayLogsOnce(lines);
    const seen = new Set(rows.filter((e) => e["event"] === "turn").map((e) => String(e["conversation_id"])));
    if (rows.length > 0 && expectTurnFor.every((id) => seen.has(id))) return rows;
    await new Promise((r) => setTimeout(r, 10_000));
  }
  return rows;
}

const pct = (xs: number[], p: number) => { const s = xs.filter(Number.isFinite).sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)]! : NaN; };

async function spendOf(db: Db): Promise<number> {
  const { data } = await db.from("conversations").select("total_cost_usd").like("conversation_id", `test-dep-${RUN}%`);
  return ((data ?? []) as Row[]).reduce((t, r) => t + Number(r["total_cost_usd"] ?? 0), 0);
}

async function main(): Promise<number> {
  if (!/^https:\/\//.test(BASE)) throw new Error("--base-url https://<domain> is required");
  process.loadEnvFile(resolve(REPO, ".env"));
  const db = createServiceClient();
  passDb = db;
  const secret = process.env["VAPI_LLM_SECRET"]!;
  const id = (name: string) => `test-dep-${RUN}-${name}`;
  console.log(`deployed: ${BASE} (token path redacted)`);

  console.log("\n== HTTP surface");
  check((await post(`/v/wrong-${"x".repeat(40)}/chat/completions`, body(id("s"), ["hi"]))).status === 404, "wrong token -> 404");
  check((await post("/chat/completions", body(id("s"), ["hi"]))).status === 404, "unprefixed route -> 404");
  check((await post(chat(), null, { method: "GET" })).status === 404, "GET on the chat route -> 404");
  const missing = await post(chat(), { messages: [{ role: "user", content: "hi" }] });
  check(missing.status === 200 && missing.text === FALLBACK, "missing call.id -> 200 + fallback");
  const badJson = await post(chat(), null, { raw: "{not json" });
  check(badJson.status === 200 && badJson.text === FALLBACK, "invalid JSON -> 200 + fallback");

  console.log("\n== Public routes");
  const landing = await fetch(`${BASE}/`);
  statuses.push(landing.status);
  const landingHtml = await landing.text();
  check(landing.status === 200 && landingHtml.includes('href="/support"') && landingHtml.includes('href="/staff"'), "GET / -> the landing page (customer support, staff) (D92)");
  const page = await fetch(`${BASE}/support`);
  statuses.push(page.status);
  const html = await page.text();
  const dcsp = page.headers.get("content-security-policy") ?? "";
  check(page.status === 200 && html.includes("Start call") && dcsp.includes("script-src 'self' 'unsafe-eval' blob: https://esm.sh https://*.daily.co;") && !dcsp.includes("unsafe-inline"), "GET /support -> the call page with CSP ('unsafe-eval' for Daily only, no 'unsafe-inline')");
  const old = await fetch(`${BASE}/index.html`, { redirect: "manual" });
  check(old.status === 301 && old.headers.get("location") === "/support", "GET /index.html -> 301 /support (old URL kept working, D92)");
  const cfg = (await (await fetch(`${BASE}/config`)).json()) as Row;
  const allowed = new Set(["vapiPublicKey", "vapiAssistantId", "loginRequired", "staffDashboard", "supabaseUrl", "supabasePublishableKey"]);
  check(cfg["vapiPublicKey"] === process.env["VAPI_PUBLIC_KEY"] && cfg["vapiAssistantId"] === process.env["VAPI_ASSISTANT_ID"] && Object.keys(cfg).every((k) => allowed.has(k)) && !JSON.stringify(cfg).includes(process.env["SUPABASE_SERVICE_ROLE_KEY"]!),
    "GET /config -> only public values (Vapi public key and assistant, flags, Supabase URL and publishable key), never the service key");
  check((await (await fetch(`${BASE}/health`)).text()) === '{"status":"ok"}', "GET /health -> ok only");

  console.log("\n== Fees question (KB-only)");
  const feesId = id("fees");
  const fees = await post(chat(), body(feesId, ["What fees does RelayPay charge for international payments?"]));
  const feesRow = await turnRow(db, feesId);
  console.log(`  spoken: ${JSON.stringify(fees.text)}`);
  check(fees.status === 200 && feesRow?.["answer_type"] === "answer" && feesRow?.["assistant_response"] === fees.text, "answer; stored response equals what was streamed");
  const { data: rlogs } = await db.from("retrieval_logs").select("chunk_ids").eq("conversation_id", feesId);
  const retrieved = new Set(((rlogs ?? []) as Array<{ chunk_ids: string[] }>).flatMap((r) => r.chunk_ids));
  check(((feesRow?.["kb_chunk_ids"] ?? []) as string[]).every((k) => retrieved.has(k)) && ((feesRow?.["kb_chunk_ids"] ?? []) as string[]).length > 0, "cited kb ids were retrieved for the turn");

  console.log("\n== Second turn, replay, concurrent join");
  const second = await post(chat(), body(feesId, ["What fees does RelayPay charge for international payments?", "And how long do international payouts take?"], [fees.text]));
  const secondRow = await turnRow(db, feesId, 1);
  check(second.status === 200 && secondRow?.["turn_index"] === 1 && secondRow?.["answer_type"] === "answer", "turn_index 1 from Vapi's messages");
  const replay = await post(chat(), body(feesId, ["What fees does RelayPay charge for international payments?"]));
  check(replay.source === "replay" && replay.text === fees.text, "identical retry of turn 0 -> replayed, same text");
  const joinId = id("join");
  const [c1, c2] = await Promise.all([post(chat(), body(joinId, ["How long do international payouts take?"])), post(chat(), body(joinId, ["How long do international payouts take?"]))]);
  await turnRow(db, joinId);
  const { data: joinAttempts } = await db.from("turn_attempts").select("status").eq("conversation_id", joinId);
  check(c1.text === c2.text && c1.text.length > 0 && (joinAttempts ?? []).length === 1, "two identical concurrent requests -> one attempt, same text", `${(joinAttempts ?? []).length} attempts; c1=${JSON.stringify(c1.text.slice(0, 120))} (${c1.source}); c2=${JSON.stringify(c2.text.slice(0, 120))} (${c2.source})`);

  console.log("\n== Speculative: partial A disconnects, fuller B answers");
  const specId = id("spec");
  await post(chat(), body(specId, ["What fees does"]), { abortAfterMs: 400 });
  const b = await post(chat(), body(specId, ["What fees does RelayPay charge for international payments?"]));
  await turnRow(db, specId);
  await new Promise((r) => setTimeout(r, 1500));
  const { data: specAttempts } = await db.from("turn_attempts").select("status").eq("conversation_id", specId).order("started_at");
  const st = ((specAttempts ?? []) as Row[]).map((a) => a["status"]);
  check(b.status === 200 && b.text.length > 0 && st.includes("completed") && st.filter((s) => s !== "completed").every((s) => s === "replaced" || s === "aborted"), "B answered; A replaced or aborted", st.join(","));

  console.log("\n== Social fast path");
  const thanks = await post(chat(), body(id("thanks"), ["All right, thank you."]));
  check(thanks.text === THANKS_LINE, `thanks line (${thanks.ms} ms client-observed, incl. network)`);

  console.log("\n== Webhook");
  const report = (callId: string, reason: string) => ({ message: { type: "end-of-call-report", endedReason: reason, startedAt: "2026-09-30T12:00:00.000Z", endedAt: "2026-09-30T12:01:30.000Z", cost: 0.1, call: { id: callId }, artifact: { transcript: "TRANSCRIPT-MARKER", performanceMetrics: { turnLatencies: [{ turnLatency: 1200 }], turnLatencyAverage: 1200 } } } });
  const w1 = await post(events(), report(feesId, "customer-ended-call"));
  let conv: Row | null = null;
  for (let i = 0; i < 40 && !conv?.["ended_reason"]; i++) {
    conv = ((await db.from("conversations").select("ended_reason, final_status, summary, vapi_metrics").eq("conversation_id", feesId).single()).data ?? null) as Row | null;
    if (!conv?.["ended_reason"]) await new Promise((r) => setTimeout(r, 250));
  }
  check(w1.status === 200 && conv?.["final_status"] === "completed" && String(conv?.["summary"]).startsWith("2 turns (answer 2).") && !JSON.stringify(conv).includes("TRANSCRIPT-MARKER"), `end-of-call recorded (${w1.ms} ms client-observed)`, JSON.stringify(conv).slice(0, 200));
  const w2 = await post(events(), report(feesId, "customer-ended-call"));
  await new Promise((r) => setTimeout(r, 1500));
  const conv2 = ((await db.from("conversations").select("ended_reason, final_status, summary, vapi_metrics").eq("conversation_id", feesId).single()).data ?? null) as Row | null;
  check(w2.status === 200 && JSON.stringify(conv2) === JSON.stringify(conv), "duplicate delivery -> identical row");
  check((await post(events(), { message: { type: "speech-update" } })).status === 200, "other message type -> 200");
  check((await post(`/v/wrong-${"y".repeat(40)}/vapi/events`, report(feesId, "x"))).status === 404, "wrong token on events -> 404");

  // ---- Latency, server-side.
  const runs: Array<{ kind: "kb" | "s4"; id: string; clientMs: number }> = [];
  console.log(`\n== Latency: ${KB_RUNS} KB-only (fees) and ${S4_RUNS} tool-backed (S4 TXN-9001) runs, interleaved; cap $${CAP}`);
  for (let i = 0; i < Math.max(KB_RUNS, S4_RUNS); i++) {
    if ((await spendOf(db)) >= CAP) { console.log("  cost cap reached; stopping the latency runs"); break; }
    if (i < KB_RUNS) { const cid = id(`lat-kb-${i}`); const r = await post(chat(), body(cid, ["What fees does RelayPay charge for international payments?"])); runs.push({ kind: "kb", id: cid, clientMs: r.ms }); }
    if (i < S4_RUNS) { const cid = id(`lat-s4-${i}`); const r = await post(chat(), body(cid, ["Can you check transaction TXN-9001?"])); runs.push({ kind: "s4", id: cid, clientMs: r.ms }); }
  }
  const logs = await railwayLogs(runs.map((r) => r.id));
  check(logs.length > 0 && runs.every((r) => logs.some((e) => e["event"] === "turn" && e["conversation_id"] === r.id)), `deployed turn log fetched for every run (${logs.length} lines)`);
  const table: Row[] = [];
  for (const r of runs) {
    const row = await turnRow(db, r.id);
    const turnLog = logs.find((e) => e["event"] === "turn" && e["conversation_id"] === r.id);
    const marks = (typeof turnLog?.["marks"] === "string" ? JSON.parse(turnLog["marks"] as string) : turnLog?.["marks"] ?? {}) as Record<string, number>;
    const { data: calls } = await db.from("tool_calls").select("tool_name, status").eq("conversation_id", r.id);
    table.push({
      kind: r.kind, answer_type: row?.["answer_type"], ms_retrieval: row?.["ms_retrieval"], init: marks["init"] ?? null, filler: marks["filler"] ?? null,
      first_answer_sentence: marks["first_spoken"] ?? null, ms_first_token: row?.["ms_first_token"], ms_total: row?.["ms_total"], client_ms: r.clientMs,
      tools: ((calls ?? []) as Row[]).map((c) => `${c["tool_name"]}:${c["status"]}`).join(","), cost: Number(row?.["cost_usd_estimate"] ?? 0),
    });
  }
  console.table(table);
  for (const kind of ["kb", "s4"] as const) {
    const t = table.filter((x) => x["kind"] === kind);
    const col = (k: string) => t.map((x) => Number(x[k] ?? NaN));
    console.log(`[${kind}] n=${t.length} errors=${t.filter((x) => x["answer_type"] === "error").length} | init p50=${pct(col("init"), 50)} | filler p50=${pct(col("filler"), 50)} | first answer sentence p50=${pct(col("first_answer_sentence"), 50)} p95=${pct(col("first_answer_sentence"), 95)} | first token p50=${pct(col("ms_first_token"), 50)} p95=${pct(col("ms_first_token"), 95)} | total p50=${pct(col("ms_total"), 50)} p95=${pct(col("ms_total"), 95)} | client p50=${pct(col("client_ms"), 50)} | cost mean=$${(col("cost").reduce((a, b) => a + b, 0) / Math.max(1, t.length)).toFixed(4)}`);
  }
  check(table.filter((x) => x["kind"] === "s4").every((x) => String(x["tools"]).includes("lookup_transaction:success")), "every S4 run called lookup_transaction successfully");

  console.log("\n== Deployed logs: no secrets, no unhandled rejections");
  const blob = JSON.stringify(logs);
  const leaked = ["ANTHROPIC_API_KEY", "SUPABASE_SERVICE_ROLE_KEY", "VAPI_LLM_SECRET", "VAPI_PUBLIC_KEY"].filter((k) => process.env[k] && blob.includes(process.env[k]!));
  check(leaked.length === 0 && !blob.includes(secret), `no secret value in ${logs.length} log lines`, leaked.join(","));
  check(!logs.some((e) => e["event"] === "unhandled_rejection" || e["event"] === "uncaught_exception"), "no unhandled rejection or uncaught exception");
  check(!blob.includes("TRANSCRIPT-MARKER"), "no transcript in the logs");
  check(statuses.every((s) => s < 500), `no response >= 500 (${statuses.length} responses)`);

  const spent = await spendOf(db);
  console.log(`\nspend (this run's conversations): $${spent.toFixed(4)}`);
  console.log(failures === 0 ? "TEST-DEPLOYED OK" : `TEST-DEPLOYED FAILED (${failures})`);
  return failures === 0 ? 0 : 1;
}

main().then((c) => process.exit(c), (e: unknown) => { console.error(e); process.exit(1); });
