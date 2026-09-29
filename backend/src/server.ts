// HTTP server: the single route POST /chat/completions (Vapi Custom LLM, D4).
//
// Idempotency per (conversation_id, turn_index):
// - a persisted turn row is replayed as the stream without running the agent again;
// - a turn already in flight IN THIS PROCESS is awaited and its spoken text streamed (one run).
// Single-instance limitation: the in-flight map is per process. Two instances receiving the
// same retry at the same moment would both run the agent; the unique (conversation_id,
// turn_index) constraint then keeps only the first row (docs/decisions.md D19).

import { createHash, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServiceClient, type Db, type LogContext } from "@relaypay/shared";
import { FALLBACK_LINE, MAX_BODY_BYTES } from "./config.js";
import { sentences } from "./gate.js";
import { SseStream } from "./sse.js";
import { runTurn, type TurnResult } from "./turn.js";
import { parseVapiBody } from "./vapi.js";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

function log(event: Record<string, unknown>): void {
  console.log(JSON.stringify({ ts: new Date().toISOString(), ...event }));
}

function sha256(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

/** Constant-time check of "Authorization: Bearer <secret>". Never logs the header. */
function authorized(header: string | undefined, secretDigest: Buffer): boolean {
  const presented = header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
  // Hashing first gives equal-length buffers, so timingSafeEqual never throws on length.
  return timingSafeEqual(sha256(presented), secretDigest) && presented.length > 0;
}

function sendJson(res: ServerResponse, status: number, body: Record<string, unknown>): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<string | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) return null;
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

const inflight = new Map<string, Promise<TurnResult>>();

async function handleChat(req: IncomingMessage, res: ServerResponse, db: Db, tReceivedMs: number): Promise<void> {
  const tReceivedIso = new Date().toISOString();
  const raw = await readBody(req);
  if (raw === null) return sendJson(res, 413, { error: "request body too large" });
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return sendJson(res, 400, { error: "invalid JSON" });
  }
  const parsed = parseVapiBody(json);
  if (!parsed.ok) return sendJson(res, 400, { error: parsed.error });
  const turn = parsed.turn;
  const ctx: LogContext = { conversationId: turn.callId, turnIndex: turn.turnIndex };
  const key = `${ctx.conversationId}#${ctx.turnIndex}`;

  // Join a run already in flight in this process. Checked and claimed below with no `await`
  // in between, so two concurrent duplicates can never both start an agent run.
  const running = inflight.get(key);
  if (running) {
    const sse = new SseStream(res, turn.model, "inflight");
    const outcome = await running;
    log({ event: "turn_inflight_joined", conversation_id: ctx.conversationId, turn_index: ctx.turnIndex, answer_type: outcome.answerType });
    for (const s of sentences(outcome.spoken ?? FALLBACK_LINE)) sse.content(s);
    return sse.finish();
  }
  // The turn itself decides replay vs agent run (after its parallel DB work), so the SSE
  // stream is opened lazily once the source is known.
  let sse: SseStream | null = null;
  const handle = runTurn(
    {
      db,
      ctx,
      channel: ctx.conversationId.startsWith("test-") ? "test" : "voice",
      caller: turn.caller,
      userText: turn.userText,
      history: turn.history,
      tReceivedMs,
      tReceivedIso,
    },
    {
      begin: (source) => (sse = new SseStream(res, turn.model, source)),
      speak: (text) => sse?.content(text),
      end: () => sse?.finish(),
      onClose: (listener) => res.on("close", () => {
        if (!sse || !sse.isEnded || !res.writableFinished) listener();
      }),
    },
  );
  inflight.set(key, handle.decided);
  // Keep the entry until the turn row exists, so a retry that arrives before then joins this
  // run; once the row exists, retries replay it from the database.
  void handle.persisted.then(() => inflight.delete(key));
  await handle.done.finally(() => inflight.delete(key));
}

function main(): void {
  const envFile = resolve(REPO, ".env");
  if (existsSync(envFile)) process.loadEnvFile(envFile);
  for (const name of ["VAPI_LLM_SECRET", "ANTHROPIC_API_KEY", "SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"]) {
    if (!process.env[name]) {
      console.error(`[relaypay] refusing to start: ${name} is not set`);
      process.exit(1);
    }
  }
  const secretDigest = sha256(process.env["VAPI_LLM_SECRET"]!);
  const db = createServiceClient();
  const port = Number(process.env["PORT"] ?? 8787);

  const server = createServer((req, res) => {
    const tReceivedMs = performance.now();
    const path = new URL(req.url ?? "/", "http://localhost").pathname;
    if (req.method !== "POST" || path !== "/chat/completions") {
      log({ event: "not_found", method: req.method, path });
      return sendJson(res, 404, { error: "not found" });
    }
    if (!authorized(req.headers.authorization, secretDigest)) {
      log({ event: "unauthorized", path });
      return sendJson(res, 401, { error: "unauthorized" });
    }
    handleChat(req, res, db, tReceivedMs).catch((err: unknown) => {
      log({ event: "request_error", message: err instanceof Error ? err.message : String(err) });
      if (!res.headersSent) sendJson(res, 500, { error: "internal error" });
      else if (!res.writableEnded) res.end();
    });
  });
  server.listen(port, () => log({ event: "listening", port, node: process.version }));
}

main();
