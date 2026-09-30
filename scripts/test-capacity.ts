// Capacity tests (Batch 3A): the per-process agent-turn cap (D59) against a local backend
// (real Agent SDK, real MCP server, real Supabase; channel='test' conversations).
//
// Cap (server on 8790 with RELAYPAY_MAX_CONCURRENT_TURNS=1):
//   1. an agent turn A is running;
//   2. a second conversation's agent turn B gets BUSY_LINE fast, no CLI spawned, recorded as
//      answer_type=error with a busy note;
//   3. a social turn during A still gets its fixed line (fast path exempt);
//   4. once A has finished, a new agent turn is admitted.
// Model spend: two short KB turns (about $0.015).
//
// Usage: npm run test:capacity   (after npm run build; needs .env)

import { spawn, type ChildProcess } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServiceClient, type Db } from "@relaypay/shared";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SERVER = resolve(REPO, "backend", "dist", "server.js");
const RUN = new Date().toISOString().replace(/[:.]/g, "-");
const BUSY = "We're getting a lot of calls right now. Please try again in a moment.";
const THANKS_LINE = "You're welcome. Is there anything else I can help you with?";

let failures = 0;
const check = (ok: boolean, label: string, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail && !ok ? `  -> ${detail}` : ""}`);
  if (!ok) failures++;
};

interface Server { proc: ChildProcess; logs: string[]; exitCode: number | null; exited: Promise<number | null> }

async function startServer(port: number, extraEnv: Record<string, string>, ipc = false): Promise<Server> {
  const proc = spawn(process.execPath, [SERVER], {
    env: { ...process.env, PORT: String(port), ...extraEnv },
    stdio: ipc ? ["ignore", "pipe", "pipe", "ipc"] : ["ignore", "pipe", "pipe"],
  });
  const logs: string[] = [];
  proc.stdout!.on("data", (d: Buffer) => logs.push(...d.toString().split("\n").filter(Boolean)));
  proc.stderr!.on("data", (d: Buffer) => logs.push(...d.toString().split("\n").filter(Boolean)));
  const server: Server = { proc, logs, exitCode: null, exited: new Promise((r) => proc.on("exit", (code) => { server.exitCode = code; r(code); })) };
  for (let i = 0; i < 100; i++) {
    if (logs.some((l) => l.includes('"event":"listening"'))) return server;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`server on ${port} did not start: ${logs.join(" | ")}`);
}

interface Reply { status: number; text: string; ms: number }

async function post(port: number, callId: string, userText: string): Promise<Reply> {
  const t0 = performance.now();
  try {
    const res = await fetch(`http://localhost:${port}/v/${process.env["VAPI_LLM_SECRET"]}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "relaypay-agent", stream: true, call: { id: callId }, messages: [{ role: "user", content: userText }] }),
    });
    const raw = await res.text();
    const text = raw.split("\n").filter((l) => l.startsWith("data: ") && l !== "data: [DONE]")
      .map((l) => (JSON.parse(l.slice(6)) as { choices: Array<{ delta: { content?: string } }> }).choices[0]?.delta.content ?? "")
      .join(" ").replace(/\s+/g, " ").trim();
    return { status: res.status, text, ms: Math.round(performance.now() - t0) };
  } catch (err) {
    return { status: -1, text: String(err), ms: Math.round(performance.now() - t0) };
  }
}

async function turnRow(db: Db, conversationId: string, waitMs = 15_000): Promise<Record<string, unknown> | null> {
  for (let waited = 0; waited <= waitMs; waited += 250) {
    const { data } = await db.from("conversation_turns").select("*").eq("conversation_id", conversationId).eq("turn_index", 0).maybeSingle();
    if (data) return data as Record<string, unknown>;
    await new Promise((r) => setTimeout(r, 250));
  }
  return null;
}

const turnLogs = (s: Server, conversationId: string) =>
  s.logs.filter((l) => l.includes('"event":"turn"') && l.includes(`"conversation_id":"${conversationId}"`));

async function capTest(db: Db): Promise<void> {
  console.log("\n== Concurrency cap (RELAYPAY_MAX_CONCURRENT_TURNS=1)");
  const s = await startServer(8790, { RELAYPAY_MAX_CONCURRENT_TURNS: "1" });
  try {
    check(s.logs.some((l) => l.includes('"max_concurrent_turns":1')), "startup log shows max_concurrent_turns=1");
    const a = `test-cap-a-${RUN}`, b = `test-cap-b-${RUN}`, c = `test-cap-c-${RUN}`, d = `test-cap-d-${RUN}`;
    const pa = post(8790, a, "What fees does RelayPay charge for international payments?");
    await new Promise((r) => setTimeout(r, 300)); // A has its slot and is spawning
    const [rb, rc] = await Promise.all([post(8790, b, "How long do payouts to Kenya take?"), post(8790, c, "Thank you.")]);
    check(rb.status === 200 && rb.text === BUSY, "second conversation's agent turn -> BUSY_LINE", rb.text);
    check(rb.ms < 1_000, `busy reply is immediate (${rb.ms} ms < 1000 ms: no CLI spawned or model called)`);
    check(rc.text === THANKS_LINE, "social turn during the busy period -> its fixed line (fast path exempt)", rc.text);
    const ra = await pa;
    check(ra.status === 200 && ra.text !== BUSY && ra.text.length > 0, "the running agent turn A answered normally", ra.text.slice(0, 80));

    const rowB = await turnRow(db, b);
    check(rowB?.["answer_type"] === "error" && String(rowB?.["confidence_note"]).startsWith("busy: concurrency cap 1"), "busy turn recorded: answer_type=error, note 'busy: concurrency cap 1 reached'", JSON.stringify(rowB));
    check(rowB?.["assistant_response"] === BUSY && rowB?.["model"] === null, "busy turn row: the busy line, no model", JSON.stringify({ r: rowB?.["assistant_response"], m: rowB?.["model"] }));
    const { data: attB } = await db.from("turn_attempts").select("status, status_reason").eq("conversation_id", b);
    check(JSON.stringify(attB) === JSON.stringify([{ status: "completed", status_reason: "busy" }]), "busy attempt: completed, status_reason busy", JSON.stringify(attB));
    await turnRow(db, a);
    const logB = turnLogs(s, b).join("\n");
    check(logB.includes('"busy":"busy"') && !logB.includes('"marks"'), "busy turn log line: busy=busy, no agent timing marks (nothing spawned)", logB.slice(0, 300));

    // A is finished (its turn row exists, so its slot has been released): a new turn is admitted.
    for (let i = 0; i < 40 && turnLogs(s, a).length === 0; i++) await new Promise((r) => setTimeout(r, 250));
    const rd = await post(8790, d, "What fees does RelayPay charge for international payments?");
    check(rd.text !== BUSY && rd.text.length > 0, "after A finished, a new agent turn is admitted", rd.text.slice(0, 80));
  } finally {
    s.proc.kill();
  }
}

async function main(): Promise<number> {
  process.loadEnvFile(resolve(REPO, ".env"));
  const db = createServiceClient();
  await capTest(db);
  console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILED`}`);
  return failures ? 1 : 0;
}

main().then((code) => process.exit(code), (err) => {
  console.error(err);
  process.exit(1);
});
