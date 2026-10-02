// HTTP server. Token routes: POST /v/:token/chat/completions (Vapi Custom LLM, D4, D26) and
// POST /v/:token/vapi/events (Vapi server messages, D50).
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

import { AsyncLocalStorage } from "node:async_hooks";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServiceClient, newAttemptId, summarize, transcriptHash, type Db, type LogContext } from "@relaypay/shared";
import { channelFor, EVENTS_MAX_BODY_BYTES, FALLBACK_LINE, FAULT_INJECT, MAX_BODY_BYTES, MAX_CONCURRENT_TURNS, SHUTDOWN_GRACE_MS, STALE_SWEEP_INTERVAL_MS, DISCORD_SWEEP_INTERVAL_MS } from "./config.js";
import { Admission } from "./admission.js";
import { startStaleSweeper } from "./stale-sweep.js";
import { createDiscordNotifier, type Notifier } from "./discord-notify.js";
import { createRateLimiter, handleRecords, matchRecordsRoute, RECORDS_RATE_LIMIT_PER_MINUTE } from "./records.js";
import { sentences } from "./gate.js";
import { SseStream } from "./sse.js";
import { runTurn, type TurnHandle, type TurnResult } from "./turn.js";
import { matchRoute, MIN_TOKEN_LENGTH, redactPath, sha256 } from "./routing.js";
import { parseVapiBody } from "./vapi.js";
import { classifyEvent, recordEndOfCall } from "./vapi-events.js";
import { retryOnce } from "./bounded.js";
import { handleCspReport, handlePublic, isPublicRoute, SECURITY_HEADERS } from "./web.js";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

function log(event: Record<string, unknown>): void {
  console.log(JSON.stringify({ ts: new Date().toISOString(), ...event }));
}

// ---- Never a 500 (D34) ------------------------------------------------------------------
// Once the route and token have matched, every failure still answers 200 with an SSE stream that
// speaks the fallback line: a 500 makes Vapi end the whole call, a fallback keeps the caller on
// the line. Wrong token / unknown path stay 404 (security). Errors are logged with message and
// stack frames only (redacted; never content or the token).

interface RequestContext {
  res: ServerResponse;
  model: string;
}
/** The request an asynchronous failure belongs to (visible to process-level handlers, Node 22). */
const requestContext = new AsyncLocalStorage<RequestContext>();

function errorDetails(err: unknown): { message: string; stack: string[] } {
  const e = err instanceof Error ? err : new Error(String(err));
  const frames = (e.stack ?? "").split("\n").slice(1, 5).map((l) => l.trim().replace(/\(.*[\\/](backend|shared|mcp-server)[\\/]/, "($1/"));
  return { message: summarize(`${e.name}: ${e.message}`, 300), stack: frames };
}

/** Last resort: make sure this response ends as a valid SSE stream, speaking the fallback if nothing was said. */
function speakFallback(res: ServerResponse, model: string): void {
  const open = SseStream.of(res);
  if (!res.headersSent) {
    const sse = new SseStream(res, model, "fallback");
    sse.content(FALLBACK_LINE);
    sse.finish();
  } else if (open && !open.isEnded) {
    if (!open.hasContent) open.content(FALLBACK_LINE);
    open.finish();
  } else if (!res.writableEnded) {
    res.end();
  }
}

function sendJson(res: ServerResponse, status: number, body: Record<string, unknown>): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage, maxBytes: number = MAX_BODY_BYTES): Promise<string | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > maxBytes) return null;
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

/** Agent-turn slots for this process (D59); drained on SIGTERM (D60). */
const admission = new Admission(MAX_CONCURRENT_TURNS);

/** Every turn started in this process that hasn't fully finished (row, totals): what a shutdown waits for. */
const unfinished = new Set<Promise<void>>();
/** Discord sender (D83); off until the server is listening (and when no webhook URL is set). */
let notifier: Pick<Notifier, "kick"> = { kick: () => undefined };

/** An entry a genuine retry may join: same transcript, and not already ended silently. */
function joinable(entry: InflightEntry | undefined, hash: string): boolean {
  return Boolean(entry && entry.hash === hash && !(entry.outcome && entry.outcome.spoken === null));
}

const settle = <T>(p: Promise<T>, capMs: number) => Promise.race([p.then(() => undefined, () => undefined), new Promise<void>((r) => setTimeout(r, capMs))]);

async function handleChat(req: IncomingMessage, res: ServerResponse, db: Db, tReceivedMs: number, loggedPath: string): Promise<void> {
  const tReceivedIso = new Date().toISOString();
  const raw = await readBody(req);
  const badRequest = (reason: string) => {
    log({ event: "bad_request", reason, path: loggedPath });
    speakFallback(res, "relaypay-agent");
  };
  if (raw === null) return badRequest("request body too large");
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return badRequest("invalid JSON");
  }
  const parsed = parseVapiBody(json);
  if (!parsed.ok) return badRequest(parsed.error);
  const turn = parsed.turn;
  const store = requestContext.getStore();
  if (store) store.model = turn.model;
  if (FAULT_INJECT === "throw_in_handler") throw new Error("injected fault: throw_in_handler");
  if (FAULT_INJECT === "uncaught_exception") setImmediate(() => {
    throw new Error("injected fault: uncaught_exception");
  });
  const key = `${turn.callId}#${turn.turnIndex}`;
  const hash = transcriptHash(turn.userText);
  let sse: SseStream | null = null;
  let afterPrevious: Promise<void> | undefined;

  // Genuine retry of an attempt in flight in this process: join it. Everything up to the
  // inflight.set() below is synchronous, so two concurrent duplicates can never both run.
  const existing = inflight.get(key);
  if (existing && joinable(existing, hash)) {
    sse = new SseStream(res, turn.model, "inflight");
    let outcome: TurnResult;
    try {
      outcome = await existing.handle.decided;
    } catch (err) {
      log({ event: "request_error", stage: "inflight_join", ...errorDetails(err) });
      return speakFallback(res, turn.model);
    }
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
      channel: channelFor(ctx.conversationId),
      caller: turn.caller,
      userText: turn.userText,
      history: turn.history,
      tReceivedMs,
      tReceivedIso,
      transcriptHash: hash,
      ...(afterPrevious ? { afterPrevious } : {}),
      admit: () => admission.tryAcquire(key),
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
  const tracked = handle.done.catch(() => undefined);
  unfinished.add(tracked);
  void tracked.finally(() => unfinished.delete(tracked));
  const entry: InflightEntry = { hash, handle, outcome: null };
  inflight.set(key, entry);
  void handle.decided.then((o) => (entry.outcome = o));
  const release = () => {
    if (inflight.get(key) === entry) inflight.delete(key);
  };
  // Keep the entry until the turn is persisted, so a retry that arrives before then joins this
  // run; once the row exists, retries are replayed from the database.
  void handle.persisted.then(release);
  // Team notifications (D83): the turn's tool writes have committed; post any new outbox rows.
  void handle.persisted.then(() => notifier.kick(), () => notifier.kick());
  await handle.done.finally(release);
}

/**
 * Vapi server messages (D50). Always 200 once the token matched, and fast: the report is
 * acknowledged first and recorded afterwards (Vapi doesn't retry by default, and the call is
 * already over, so nobody waits on the write). Logs carry the type, call id and outcome only:
 * never the transcript, messages, customer details or the token.
 */
async function handleEvents(req: IncomingMessage, res: ServerResponse, db: Db, loggedPath: string): Promise<void> {
  const raw = await readBody(req, EVENTS_MAX_BODY_BYTES);
  let json: unknown = null;
  try {
    json = raw === null ? null : JSON.parse(raw);
  } catch {
    json = null;
  }
  const event = classifyEvent(json);
  sendJson(res, 200, { ok: true });
  if (event.kind === "ignored") {
    log({ event: "vapi_event_ignored", type: raw === null ? "(body too large)" : event.type, path: loggedPath });
    return;
  }
  const t0 = performance.now();
  try {
    const r = await retryOnce(() => recordEndOfCall(db, event.conversationId, event.message), 10_000, "record end-of-call-report");
    log({ event: "vapi_end_of_call", conversation_id: event.conversationId, final_status: r.finalStatus, row_created: r.created, ms: Math.round(performance.now() - t0) });
  } catch (err) {
    log({ event: "vapi_end_of_call_failed", conversation_id: event.conversationId, ...errorDetails(err) });
  }
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

  // unhandledRejection is always a bug (the suite asserts zero): log it and fail only the
  // request it belongs to, via the fallback path, when that request can be identified.
  process.on("unhandledRejection", (reason) => {
    const store = requestContext.getStore();
    log({ event: "unhandled_rejection", request_identified: Boolean(store), ...errorDetails(reason) });
    if (store) speakFallback(store.res, store.model);
  });
  // After an uncaught exception process state can't be trusted: log and exit(1), relying on the
  // host's automatic restart (Railway restarts on failure, railway.json; locally, restart by hand).
  process.on("uncaughtException", (err) => {
    log({ event: "uncaught_exception", request_identified: Boolean(requestContext.getStore()), ...errorDetails(err) });
    process.exit(1);
  });
  const db = createServiceClient();
  const recordsAllow = createRateLimiter(RECORDS_RATE_LIMIT_PER_MINUTE);
  const port = Number(process.env["PORT"] || 8787);

  const server = createServer((req, res) => {
    const tReceivedMs = performance.now();
    let pathname = "/";
    try {
      pathname = new URL(req.url ?? "/", "http://localhost").pathname;
    } catch {
      /* malformed request target: treat as unknown path */
    }
    // The page's "Your references" panel (D84): read-only, scoped to one call, rate-limited.
    const recordsCallId = matchRecordsRoute(req.method, pathname);
    if (recordsCallId !== null) {
      handleRecords(req, res, db, recordsCallId, { allow: recordsAllow, log, headers: SECURITY_HEADERS }).catch(() => {
        if (!res.headersSent) sendJson(res, 503, { error: "records unavailable" });
      });
      return;
    }
    // Public routes (D52): the voice page, its assets, /config (public Vapi IDs) and /health.
    if (isPublicRoute(req.method, pathname)) {
      if (req.method === "POST") {
        handleCspReport(req, res, log).catch(() => { if (!res.headersSent) { res.writeHead(204); res.end(); } });
        return;
      }
      req.resume();
      try {
        return handlePublic(req, res, pathname);
      } catch (err) {
        log({ event: "request_error", stage: "public", path: pathname, ...errorDetails(err) });
        if (!res.headersSent) return sendJson(res, 500, { error: "internal error" });
        return;
      }
    }
    const loggedPath = redactPath(pathname, secret);
    const route = matchRoute(req.method, pathname, secretDigest);
    if (route.kind === "not_found") {
      // Same 404 for unknown paths and for a wrong/missing token; the path is redacted.
      log({ event: "not_found", method: req.method, path: loggedPath });
      req.resume();
      return sendJson(res, 404, { error: "not found" });
    }
    if (route.kind === "events") {
      handleEvents(req, res, db, loggedPath).catch((err: unknown) => {
        log({ event: "request_error", stage: "events", path: loggedPath, ...errorDetails(err) });
        if (!res.headersSent) sendJson(res, 200, { ok: true });
      });
      return;
    }
    const context: RequestContext = { res, model: "relaypay-agent" };
    requestContext.run(context, () => {
      handleChat(req, res, db, tReceivedMs, loggedPath).catch((err: unknown) => {
        log({ event: "request_error", stage: "handler", path: loggedPath, ...errorDetails(err) });
        speakFallback(res, context.model);
      });
    });
  });
  // Graceful shutdown (D60): Railway sends SIGTERM before replacing or stopping the container.
  // New agent turns get BUSY_LINE (the social fast path still answers), turns in flight get up
  // to SHUTDOWN_GRACE_MS to finish and be recorded, then the process exits. The IPC message is
  // a local-test hook only (Windows can't deliver SIGTERM to a Node child); it exists only when
  // a parent spawned this process with an IPC channel, which Railway never does.
  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    admission.drain();
    const t0 = performance.now();
    log({ event: "shutdown_started", signal, turns_in_flight: unfinished.size, grace_ms: SHUTDOWN_GRACE_MS });
    while (unfinished.size > 0 && performance.now() - t0 < SHUTDOWN_GRACE_MS) await new Promise((r) => setTimeout(r, 50));
    log({ event: "shutdown_complete", signal, turns_unfinished: unfinished.size, ms: Math.round(performance.now() - t0) });
    server.close();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
  if (process.send) process.on("message", (m: unknown) => {
    if ((m as { type?: string } | null)?.type === "shutdown") void shutdown("ipc");
  });

  server.listen(port, () => {
    log({ event: "listening", port, node: process.version, max_concurrent_turns: MAX_CONCURRENT_TURNS });
    startStaleSweeper(db, STALE_SWEEP_INTERVAL_MS, log);
    notifier = createDiscordNotifier({ db, webhookUrl: process.env["DISCORD_WEBHOOK_URL"], log, intervalMs: DISCORD_SWEEP_INTERVAL_MS, timer: true });
  });
}

main();
