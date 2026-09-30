// Supersession guard (D28, D29): the write and the attempt check are one database call.
// A replaced attempt cannot write; the database's P0001 ATTEMPT_NOT_ACTIVE becomes 'denied'.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { guardedRpc, type Db } from "@relaypay/shared";
import { withToolLogging, withWriteToolLogging, type ToolDeps } from "./tool-logging.js";

interface Stub {
  db: Db;
  logged: Array<Record<string, unknown>>;
  rpcCalls: Array<{ fn: string; params: Record<string, unknown> }>;
  writes: string[];
}

/**
 * Stub database: rpc() plays the role of a guarded Postgres write function. It "writes" only if
 * the attempt is active (checked INSIDE the same call, like require_active_attempt + INSERT in one
 * transaction); otherwise it returns the error Postgres would raise. Log inserts are recorded.
 */
function stubDb(activeAttempts: Set<string>): Stub {
  const stub: Stub = { db: undefined as unknown as Db, logged: [], rpcCalls: [], writes: [] };
  stub.db = {
    from: () => ({ insert: async (row: Record<string, unknown>) => (stub.logged.push(row), { error: null }) }),
    rpc: async (fn: string, params: Record<string, unknown>) => {
      stub.rpcCalls.push({ fn, params });
      if (!activeAttempts.has(String(params["p_attempt_id"]))) {
        return { data: null, error: { code: "P0001", message: `ATTEMPT_NOT_ACTIVE: attempt ${params["p_attempt_id"]} is not active` } };
      }
      stub.writes.push(fn);
      return { data: { ticket_id: "TKT-1" }, error: null };
    },
  } as unknown as Db;
  return stub;
}

// A write tool built the only allowed way: withWriteToolLogging + guardedRpc.
const createTicket = withWriteToolLogging("create_support_ticket", "test", async (args, { db, ctx }) => {
  const data = await guardedRpc<{ ticket_id: string }>(db, "create_support_ticket_guarded", { p_summary: String((args as { summary?: string }).summary) }, ctx.attemptId);
  return { status: "success", result: { ticket_id: data.ticket_id } };
});

describe("withWriteToolLogging + guardedRpc (supersession guard, single transaction)", () => {
  it("a replaced attempt cannot write: one call, database refuses, status denied, refusal logged", async () => {
    const s = stubDb(new Set(["ATT-NEW"])); // ATT-OLD was replaced by ATT-NEW
    const r = await createTicket({ summary: "x" }, { db: s.db, ctx: { conversationId: "c", turnIndex: 0, attemptId: "ATT-OLD" } } as ToolDeps);
    assert.equal(s.writes.length, 0);
    assert.equal(s.rpcCalls.length, 1, "exactly one database call: no separate pre-check");
    assert.equal(s.rpcCalls[0]!.params["p_attempt_id"], "ATT-OLD");
    assert.equal(r.structuredContent["status"], "denied");
    assert.equal(s.logged[0]!["status"], "denied");
    assert.equal(s.logged[0]!["attempt_id"], "ATT-OLD");
  });

  it("the active attempt writes, in one call that carries p_attempt_id", async () => {
    const s = stubDb(new Set(["ATT-NEW"]));
    const r = await createTicket({ summary: "x" }, { db: s.db, ctx: { conversationId: "c", turnIndex: 0, attemptId: "ATT-NEW" } } as ToolDeps);
    assert.deepEqual(s.writes, ["create_support_ticket_guarded"]);
    assert.equal(s.rpcCalls.length, 1);
    assert.equal(r.structuredContent["status"], "success");
  });

  it("no attempt id: denied without calling the database", async () => {
    const s = stubDb(new Set(["ATT-NEW"]));
    const r = await createTicket({ summary: "x" }, { db: s.db, ctx: { conversationId: "c", turnIndex: 0 } } as ToolDeps);
    assert.equal(s.rpcCalls.length, 0);
    assert.equal(r.structuredContent["status"], "denied");
  });

  it("other database errors are 'error', not 'denied'", async () => {
    const s = stubDb(new Set(["ATT-NEW"]));
    (s.db as unknown as { rpc: unknown }).rpc = async () => ({ data: null, error: { code: "23505", message: "duplicate key" } });
    const r = await createTicket({ summary: "x" }, { db: s.db, ctx: { conversationId: "c", turnIndex: 0, attemptId: "ATT-NEW" } } as ToolDeps);
    assert.equal(r.structuredContent["status"], "error");
  });
});

describe("reserved result key", () => {
  it("a result that uses 'status' becomes a logged error instead of hiding the tool status", async () => {
    const s = stubDb(new Set(["ATT-NEW"]));
    const tool = withToolLogging("clash", "test", async () => ({ status: "success", result: { status: "processing" } }));
    const r = await tool({}, { db: s.db, ctx: { conversationId: "c", turnIndex: 0, attemptId: "ATT-NEW" } } as ToolDeps);
    assert.equal(r.structuredContent["status"], "error");
    assert.equal(s.logged[0]?.["status"], "error");
    assert.match(String(s.logged[0]?.["error_message"]), /reserved key "status"/);
  });
});
