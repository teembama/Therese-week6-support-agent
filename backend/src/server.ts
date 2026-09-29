// HTTP server: the single route POST /v/:token/chat/completions (Vapi Custom LLM, D4, D26).
// Vapi's base URL is https://<host>/v/<token>; Vapi appends /chat/completions. A wrong or
// missing token is a 404 like any unknown path, and logged paths are always redacted.
//
// Idempotency per (conversation_id, turn_index, transcript hash) (D28). Vapi sends several
// model requests per caller turn, speculative ones on partial transcripts among them:
// - same transcript, attempt in flight IN THIS PROCESS -> join it (genuine retry, one run);
// - same transcript, stored turn that SPOKE -> replayed by begin_turn_attempt (turn.ts);
// - same transcript, but the earlier attempt ended with nothing spoken -> run fresh; never
//   replay or join "nothing";
// - different transcript -> the in-flight attempt is replaced (aborted, CLI tree killed,
//   recorded as 'replaced') and a fresh attempt runs.
// Single-instance limitation: the in-flight map is per process; across instances the database
// still records attempts and replacements, but identical concurrent retries could both run.

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServiceClient, newAttemptId, transcriptHash, type Db, type LogContext } from "@relaypay/shared";
import { FALLBACK_LINE, MAX_BODY_BYTES } from "./config.js";
import { debugDetails, shapeOf } from "./debug-shape.js";
import { sentences } from "./gate.js";
import { SseStream } from "./sse.js";
import { runTurn, type TurnHandle, type TurnResult } from "./turn.js";
import { matchRoute, MIN_TOKEN_LENGTH, redactPath, sha256 } from "./routing.js";
import { parseVapiBody } from "./vapi.js";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

function log(event: Record<string, unknown>): void {
  console.log(JSON.stringify({ ts: new Date().toISOString(), ...event }));
}

// TEMPORARY (live Vapi test): log request structure only (see debug-shape.ts).
const DEBUG_REQUEST_SHAPE = process.env["RELAYPAY_DEBUG_REQUEST_SHAPE"] === "1";

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

interface InflightEntry {
  hash: string;
  handle: TurnHandle;
  /** Set once the attempt's spoken outcome is decided. */
  outcome: TurnResult | null;
}

const inflight = new Map<string, InflightEntry>();

/** An entry a genuine retry may join: same transcript, and not already ended silently. */
function joinable(entry: InflightEntry | undefined, hash: string): boolean {
  return Boolean(entry && entry.hash === hash && !(entry.outcome && entry.outcome.spoken === null));
}

const settle = <T>(p: Promise<T>, capMs: number) => Promise.race([p.then(() => undefined, () => undefined), new Promise<void>((r) => setTimeout(r, capMs))]);

async function handleChat(req: IncomingMessage, res: ServerResponse, db: Db, tReceivedMs: number, loggedPath: string): Promise<void> {
  const tReceivedIso = new Date().toISOString();
  const raw = await readBody(req);
  if (raw === null) return sendJson(res, 413, { error: "request body too large" });
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return sendJson(res, 400, { error: "invalid JSON" });
  }
  if (DEBUG_REQUEST_SHAPE) {
    log({ event: "debug_request_shape", method: req.method, path: loggedPath, token_ok: true, header_names: Object.keys(req.headers).sort(), ...debugDetails(json, req.headers), body_shape: shapeOf(json) });
  }
  const parsed = parseVapiBody(json);
  if (!parsed.ok) return sendJson(res, 400, { error: parsed.error });
  const turn = parsed.turn;
  const key = `${turn.callId}#${turn.turnIndex}`;
  const hash = transcriptHash(turn.userText);
  let sse: SseStream | null = null;
  let afterPrevious: Promise<void> | undefined;

  // Genuine retry of an attempt in flight in this process: join it. Everything up to the
  // inflight.set() below is synchronous, so two concurrent duplicates can never both run.
  const existing = inflight.get(key);
  if (existing && joinable(existing, hash)) {
    sse = new SseStream(res, turn.model, "inflight");
    const outcome = await existing.handle.decided;
    if (outcome.spoken !== null) {
      log({ event: "turn_inflight_joined", conversation_id: turn.callId, turn_index: turn.turnIndex, answer_type: outcome.answerType });
      for (const sentence of sentences(outcome.spoken)) sse.content(sentence);
      return sse.finish();
    }
    // The joined attempt ended with nothing spoken (e.g. its client disconnected): run fresh on
    // this request's already-open stream, after that attempt's record is written.
    log({ event: "turn_inflight_join_ended_silently", conversation_id: turn.callId, turn_index: turn.turnIndex });
    afterPrevious = settle(existing.handle.persisted, 3_000);
    const newer = inflight.get(key);
    if (newer && newer !== existing && joinable(newer, hash)) {
      const o = await newer.handle.decided;
      for (const sentence of sentences(o.spoken ?? FALLBACK_LINE)) sse.content(sentence);
      return sse.finish();
    }
  } else if (existing && existing.hash !== hash) {
    // A different (usually fuller) transcript for the same turn: replace the in-flight attempt.
    existing.handle.replace();
    afterPrevious = settle(existing.handle.begun, 3_000);
    log({ event: "turn_attempt_replaced_in_flight", conversation_id: turn.callId, turn_index: turn.turnIndex, replaced_attempt_id: existing.handle.attemptId });
  } else if (existing) {
    // Same transcript, but the earlier attempt already ended with nothing spoken: run fresh.
    afterPrevious = settle(existing.handle.persisted, 3_000);
  }

  const ctx: LogContext = { conversationId: turn.callId, turnIndex: turn.turnIndex, attemptId: newAttemptId() };
  const openSse = sse as SseStream | null;
  let turnSse: SseStream | null = openSse;
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
      transcriptHash: hash,
      ...(afterPrevious ? { afterPrevious } : {}),
    },
    {
      // Reuse a stream already opened by a join that fell through.
      begin: (source) => (turnSse ??= new SseStream(res, turn.model, source)),
      speak: (text) => turnSse?.content(text),
      end: () => turnSse?.finish(),
      onClose: (listener) => res.on("close", () => {
        if (!turnSse || !turnSse.isEnded || !res.writableFinished) listener();
      }),
    },
  );
  const entry: InflightEntry = { hash, handle, outcome: null };
  inflight.set(key, entry);
  void handle.decided.then((o) => (entry.outcome = o));
  const release = () => {
    if (inflight.get(key) === entry) inflight.delete(key);
  };
  // Keep the entry until the turn is persisted, so a retry that arrives before then joins this
  // run; once the row exists, retries are replayed from the database.
  void handle.persisted.then(release);
  await handle.done.finally(release);
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
  const secret = process.env["VAPI_LLM_SECRET"]!;
  if (secret.length < MIN_TOKEN_LENGTH || !/^[A-Za-z0-9._~-]+$/.test(secret)) {
    console.error(`[relaypay] refusing to start: VAPI_LLM_SECRET must be at least ${MIN_TOKEN_LENGTH} URL-safe characters ([A-Za-z0-9._~-])`);
    process.exit(1);
  }
  const secretDigest = sha256(secret);
  const db = createServiceClient();
  const port = Number(process.env["PORT"] || 8787);

  const server = createServer((req, res) => {
    const tReceivedMs = performance.now();
    let pathname = "/";
    try {
      pathname = new URL(req.url ?? "/", "http://localhost").pathname;
    } catch {
      /* malformed request target: treat as unknown path */
    }
    const loggedPath = redactPath(pathname, secret);
    const route = matchRoute(req.method, pathname, secretDigest);
    if (route.kind === "not_found") {
      // Same 404 for unknown paths and for a wrong/missing token; the path is redacted.
      log({ event: "not_found", method: req.method, path: loggedPath });
      if (DEBUG_REQUEST_SHAPE && route.tokenChecked) {
        log({ event: "debug_request_shape", method: req.method, path: loggedPath, token_ok: false, header_names: Object.keys(req.headers).sort(), x_stainless_retry_count: req.headers["x-stainless-retry-count"] ?? null });
      }
      req.resume();
      return sendJson(res, 404, { error: "not found" });
    }
    handleChat(req, res, db, tReceivedMs, loggedPath).catch((err: unknown) => {
      log({ event: "request_error", message: err instanceof Error ? err.message : String(err) });
      if (!res.headersSent) sendJson(res, 500, { error: "internal error" });
      else if (!res.writableEnded) res.end();
    });
  });
  server.listen(port, () => log({ event: "listening", port, node: process.version }));
}

main();
