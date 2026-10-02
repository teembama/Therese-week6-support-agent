// Customer login for calls (L1, D86): pass extraction, the access checker, POST /calls/pass, and
// the denied turn (fixed login line, recorded as answer_type error, no agent run).

import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, it } from "node:test";
import type { Db } from "@relaypay/shared";
import { bearerToken, callerFromUser, createAccessChecker, extractCallPass, handleCallPass, LOGIN_LINE, sha256Hex } from "./login.js";
import { runTurn } from "./turn.js";

const PASS = "Abcdefghijklmnopqrstuvwxyz0123456789_-ABCDEF";
const vapiBody = (variableValues?: Record<string, unknown>) => ({
  messages: [{ role: "user", content: "hi" }],
  call: { id: "call-1", ...(variableValues ? { assistantOverrides: { clientMessages: [], variableValues } } : {}) },
});

describe("call pass extraction (D86)", () => {
  it("reads call.assistantOverrides.variableValues.callPass and reports where", () => {
    assert.deepEqual(extractCallPass(vapiBody({ callPass: PASS })), { pass: PASS, source: "call.assistantOverrides.variableValues.callPass" });
  });
  it("missing: null with the reason; malformed: '' (fails as invalid, never trusted)", () => {
    assert.equal(extractCallPass(vapiBody()).pass, null);
    assert.match(extractCallPass(vapiBody()).source, /no assistantOverrides/);
    assert.match(extractCallPass(vapiBody({})).source, /no callPass/);
    assert.equal(extractCallPass(vapiBody({ callPass: "short" })).pass, "");
    assert.equal(extractCallPass(vapiBody({ callPass: { x: 1 } })).pass, "");
    assert.equal(extractCallPass(null).pass, null);
  });
  it("roles come only from app_metadata: customer or staff; customer_id must look like CUS-NNNN", () => {
    assert.deepEqual(callerFromUser({ id: "u1", app_metadata: { role: "customer" } }), { userId: "u1", role: "customer", customerId: null });
    assert.deepEqual(callerFromUser({ id: "u2", app_metadata: { role: "customer", customer_id: "CUS-1001" } }), { userId: "u2", role: "customer", customerId: "CUS-1001" });
    assert.deepEqual(callerFromUser({ id: "u3", app_metadata: { role: "staff", customer_id: "nope" } }), { userId: "u3", role: "staff", customerId: null });
    assert.equal(callerFromUser({ id: "u4", app_metadata: { role: "admin" } }), null);
    assert.equal(callerFromUser({ id: "u5", app_metadata: {} }), null);
    assert.equal(callerFromUser(null), null);
  });
  it("bearer token parsing", () => {
    const req = (h?: string) => ({ headers: h ? { authorization: h } : {} }) as never;
    assert.equal(bearerToken(req(`Bearer ${"a".repeat(30)}`)), "a".repeat(30));
    assert.equal(bearerToken(req("Basic abc")), null);
    assert.equal(bearerToken(req()), null);
  });
});

function rpcDb(results: Record<string, { status: string; user_id?: string; role?: string; customer_id?: string | null }>, calls: unknown[]): Db {
  return {
    rpc: async (fn: string, args: { p_conversation_id: string; p_pass_hash: string | null }) => {
      calls.push([fn, args]);
      const key = args.p_pass_hash ?? "null";
      return { data: [results[key] ?? { status: "invalid" }], error: null };
    },
  } as unknown as Db;
}

describe("access checker (D86)", () => {
  it("sends only the SHA-256 of the pass; ok is cached (later turns skip the database)", async () => {
    const calls: unknown[] = [];
    const check = createAccessChecker(rpcDb({ [sha256Hex(PASS)]: { status: "ok", user_id: "u1", role: "customer", customer_id: null } }, calls));
    const first = await check("call-1", PASS);
    assert.deepEqual([first.status, first.cached, first.userId], ["ok", false, "u1"]);
    assert.ok(!JSON.stringify(calls).includes(PASS));
    const later = await check("call-1", null);
    assert.deepEqual([later.status, later.cached], ["ok", true]);
    assert.equal(calls.length, 1);
  });
  it("missing / invalid / reused / expired are not cached; a database error is 'error'", async () => {
    const calls: unknown[] = [];
    const check = createAccessChecker(rpcDb({ null: { status: "missing" }, [sha256Hex(PASS)]: { status: "reused" } }, calls));
    assert.equal((await check("c", null)).status, "missing");
    assert.equal((await check("c", PASS)).status, "reused");
    assert.equal((await check("c", "")).status, "invalid");
    assert.equal(calls.length, 3);
    const broken = createAccessChecker({ rpc: async () => ({ data: null, error: { code: "x" } }) } as unknown as Db);
    assert.equal((await broken("c", PASS)).status, "error");
  });
});

describe("POST /calls/pass (D86)", () => {
  async function serve(db: Db, allow = () => true): Promise<{ server: Server; base: string; logs: Array<Record<string, unknown>> }> {
    const logs: Array<Record<string, unknown>> = [];
    const server = createServer((req, res) => void handleCallPass(req, res, db, { allow, log: (e) => logs.push(e), headers: {} }));
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    return { server, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, logs };
  }
  const TOKEN = "t".repeat(40);
  function authDb(user: unknown, inserted: unknown[]): Db {
    return {
      auth: { getUser: async (t: string) => (t === TOKEN && user ? { data: { user }, error: null } : { data: { user: null }, error: { status: 401 } }) },
      from: () => ({ insert: async (row: unknown) => { inserted.push(row); return { error: null }; } }),
    } as unknown as Db;
  }
  it("valid customer token: 200 with a one-time pass; only its hash is stored; logs carry no token or pass", async () => {
    const inserted: Array<Record<string, unknown>> = [];
    const { server, base, logs } = await serve(authDb({ id: "u1", app_metadata: { role: "customer", customer_id: "CUS-1001" } }, inserted));
    try {
      const r = await fetch(`${base}/calls/pass`, { method: "POST", headers: { Authorization: `Bearer ${TOKEN}` } });
      assert.equal(r.status, 200);
      assert.equal(r.headers.get("cache-control"), "no-store");
      const body = (await r.json()) as { pass: string; expiresInSeconds: number };
      assert.match(body.pass, /^[A-Za-z0-9_-]{43}$/);
      assert.equal(body.expiresInSeconds, 300);
      assert.deepEqual(inserted, [{ pass_hash: sha256Hex(body.pass), source: "login", user_id: "u1", role: "customer", customer_id: "CUS-1001" }]);
      const logText = JSON.stringify(logs);
      assert.ok(!logText.includes(body.pass) && !logText.includes(TOKEN) && !logText.includes("u1"), logText);
    } finally {
      server.close();
    }
  });
  it("no token / invalid or expired token: 401; role not allowed: 403; rate-limited: 429; nothing stored", async () => {
    const inserted: unknown[] = [];
    const a = await serve(authDb({ id: "u9", app_metadata: {} }, inserted));
    const b = await serve(authDb(null, inserted), () => false);
    try {
      assert.equal((await fetch(`${a.base}/calls/pass`, { method: "POST" })).status, 401);
      assert.equal((await fetch(`${a.base}/calls/pass`, { method: "POST", headers: { Authorization: `Bearer ${"x".repeat(40)}` } })).status, 401);
      assert.equal((await fetch(`${a.base}/calls/pass`, { method: "POST", headers: { Authorization: `Bearer ${TOKEN}` } })).status, 403);
      assert.equal((await fetch(`${b.base}/calls/pass`, { method: "POST", headers: { Authorization: `Bearer ${TOKEN}` } })).status, 429);
      assert.equal(inserted.length, 0);
    } finally {
      a.server.close();
      b.server.close();
    }
  });
});

describe("denied turn (D86)", () => {
  it("speaks the login line at once, records answer_type error / login_required, runs no agent", async () => {
    const rpcs: Array<[string, Record<string, unknown>]> = [];
    const db = {
      rpc: async (fn: string, args: Record<string, unknown>) => {
        rpcs.push([fn, args]);
        if (fn === "begin_turn_attempt") return { data: [{ action: "run", replaced_attempt_ids: [] }], error: null };
        return { data: "completed", error: null };
      },
    } as unknown as Db;
    const spoken: string[] = [];
    let admitted = false;
    const handle = runTurn(
      {
        db, ctx: { conversationId: "call-x", turnIndex: 0, attemptId: "ATT-1" }, channel: "voice", caller: null,
        userText: "hello", history: [], tReceivedMs: performance.now(), tReceivedIso: new Date().toISOString(), transcriptHash: "h",
        admit: () => { admitted = true; return "busy"; },
        denied: { line: LOGIN_LINE, statusReason: "login_required", note: "login_required: pass missing" },
      },
      { begin: () => undefined, speak: (t) => spoken.push(t), end: () => undefined, onClose: () => undefined },
    );
    const result = await handle.decided;
    await handle.done;
    assert.equal(spoken.join(" "), LOGIN_LINE);
    assert.deepEqual([result.answerType, admitted], ["error", false]);
    const finish = rpcs.find(([fn]) => fn === "finish_turn_attempt")![1];
    assert.equal(finish["p_status_reason"], "login_required");
    assert.equal((finish["p_turn"] as Record<string, unknown>)["answer_type"], "error");
    assert.equal((finish["p_turn"] as Record<string, unknown>)["assistant_response"], LOGIN_LINE);
    assert.equal((finish["p_metrics"] as Record<string, unknown>)["model"], null);
  });
});
