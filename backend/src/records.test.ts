// GET /calls/:callId/records (D84): scoping to one call, unknown/malformed call IDs, no sensitive
// fields, rate limiting, logging without the ID. The database is an in-memory fake.

import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, it } from "node:test";
import type { Db } from "@relaypay/shared";
import { callHash, createRateLimiter, FOLLOW_UP_LINE, handleRecords, matchRecordsRoute, readCallRecords } from "./records.js";

const CALL_A = "6f1c2a9e-1b2c-4d3e-8f90-0a1b2c3d4e5f";
const CALL_B = "0d9e8f7a-6b5c-4d3e-9f21-abcdefabcdef";

// Rows carry every sensitive column the real tables have, to prove the output is whitelisted.
const TABLES: Record<string, Array<Record<string, unknown>>> = {
  support_tickets: [
    { ticket_id: "TKT-A1", conversation_id: CALL_A, category: "payout", customer_id: "CUS-1001", summary: "Payout of $5,000 failed", priority: "high", status: "open", created_at: "1" },
    { ticket_id: "TKT-A2", conversation_id: CALL_A, category: "account", customer_id: "CUS-1001", summary: "Escalated", priority: "high", status: "open", created_at: "2" },
    { ticket_id: "TKT-B1", conversation_id: CALL_B, category: "payment", customer_id: "CUS-2002", summary: "Other caller", priority: "normal", status: "open", created_at: "1" },
  ],
  tool_calls: [
    { id: 1, conversation_id: CALL_A, tool_name: "lookup_customer", result_summary: "verified CUS-1001" },
    { id: 2, conversation_id: CALL_B, tool_name: "search_knowledge_base", result_summary: "x" },
  ],
  escalations: [
    { escalation_id: "ESC-A1", conversation_id: CALL_A, ticket_id: "TKT-A2", preferred_time_text: "tomorrow morning", user_email: "efua@accrastack.example", user_name: "Efua", reason: "Restricted", call_booked: true, customer_id: "CUS-1001", status: "open", created_at: "3" },
  ],
};

function fakeDb(calls: string[] = []): Db {
  return {
    from: (table: string) => {
      const filters: Array<[string, unknown]> = [];
      const b: Record<string, unknown> = {
        select: () => b,
        eq: (k: string, v: unknown) => { filters.push([k, v]); calls.push(`${table}.${k}=${String(v)}`); return b; },
        order: () => b,
        then: (res: (v: unknown) => unknown) => {
          const data = (TABLES[table] ?? []).filter((r) => filters.every(([k, v]) => r[k] === v));
          return Promise.resolve({ data, error: null, count: data.length }).then(res);
        },
      };
      return b;
    },
  } as unknown as Db;
}

describe("records endpoint: reading (D84)", () => {
  it("returns only this call's references, scoped by conversation_id", async () => {
    const calls: string[] = [];
    const r = await readCallRecords(fakeDb(calls), CALL_A);
    assert.deepEqual(calls.sort(), [`escalations.conversation_id=${CALL_A}`, `support_tickets.conversation_id=${CALL_A}`, `tool_calls.conversation_id=${CALL_A}`, "tool_calls.tool_name=lookup_customer"]);
    assert.deepEqual(r, {
      tickets: [{ reference: "TKT-A1", category: "Payout", follow_up: FOLLOW_UP_LINE }],
      escalations: [{ reference: "ESC-A1", linked_ticket: "TKT-A2", callback_preference: "tomorrow morning" }],
      identity_checked: true,
    });
    const b = await readCallRecords(fakeDb(), CALL_B);
    assert.deepEqual(b.tickets.map((t) => t.reference), ["TKT-B1"]);
    assert.equal(b.escalations.length, 0);
    assert.equal(b.identity_checked, false, "identity_checked: only a lookup_customer call on THIS call counts (L1b)");
  });
  it("an escalation's own ticket is its linked ticket, not a separate entry", async () => {
    const r = await readCallRecords(fakeDb(), CALL_A);
    assert.ok(!r.tickets.some((t) => t.reference === "TKT-A2"));
  });
  it("no sensitive fields: no customer, email, name, amount, summary, reason, status or priority", async () => {
    const json = JSON.stringify(await readCallRecords(fakeDb(), CALL_A));
    for (const bad of ["CUS-", "efua", "Efua", "5,000", "$", "summary", "Restricted", "status", "priority", "call_booked", "customer"]) assert.ok(!json.includes(bad), bad);
  });
  it("unknown call: the same empty shape; malformed ID: empty without touching the database", async () => {
    assert.deepEqual(await readCallRecords(fakeDb(), "11111111-2222-4333-8444-555555555555"), { tickets: [], escalations: [], identity_checked: false });
    const calls: string[] = [];
    for (const id of ["eval-2026-10-01T23-23-06-674Z-after5-s7-r1", "test-tools-x", "", "' or 1=1 --"]) {
      assert.deepEqual(await readCallRecords(fakeDb(calls), id), { tickets: [], escalations: [], identity_checked: false });
    }
    assert.deepEqual(calls, []);
  });
  it("route matching: GET only, one path segment", () => {
    assert.equal(matchRecordsRoute("GET", `/calls/${CALL_A}/records`), CALL_A);
    assert.equal(matchRecordsRoute("POST", `/calls/${CALL_A}/records`), null);
    assert.equal(matchRecordsRoute("GET", `/calls/a/b/records`), null);
    assert.equal(matchRecordsRoute("GET", `/calls/%E0%A4%A/records`), "");
  });
  it("rate limiter: N per window per key, then refused; resets with the window", () => {
    let t = 0;
    const allow = createRateLimiter(3, 60_000, () => t);
    assert.deepEqual([allow("ip"), allow("ip"), allow("ip"), allow("ip"), allow("other")], [true, true, true, false, true]);
    t = 60_000;
    assert.equal(allow("ip"), true);
  });
});

describe("records endpoint: HTTP (D84)", () => {
  async function serve(allow: (k: string) => boolean, logs: Array<Record<string, unknown>>): Promise<{ server: Server; base: string }> {
    const server = createServer((req, res) => {
      const id = matchRecordsRoute(req.method, new URL(req.url!, "http://x").pathname);
      void handleRecords(req, res, fakeDb(), id ?? "", { allow, log: (e) => logs.push(e), headers: { "X-Content-Type-Options": "nosniff" } });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    return { server, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
  }
  it("200 with no-store; the same shape for a known and an unknown call; the log has a hash, never the ID", async () => {
    const logs: Array<Record<string, unknown>> = [];
    const { server, base } = await serve(() => true, logs);
    try {
      const known = await fetch(`${base}/calls/${CALL_A}/records`);
      assert.equal(known.status, 200);
      assert.equal(known.headers.get("cache-control"), "no-store");
      assert.deepEqual(Object.keys(await known.json() as object), ["tickets", "escalations", "identity_checked"]);
      const unknown = await fetch(`${base}/calls/11111111-2222-4333-8444-555555555555/records`);
      assert.equal(unknown.status, 200);
      assert.deepEqual(await unknown.json(), { tickets: [], escalations: [], identity_checked: false });
      assert.ok(!JSON.stringify(logs).includes(CALL_A));
      assert.equal(logs[0]?.["call"], callHash(CALL_A));
    } finally {
      server.close();
    }
  });
  it("429 when rate-limited, without reading the database", async () => {
    const logs: Array<Record<string, unknown>> = [];
    const { server, base } = await serve(() => false, logs);
    try {
      const r = await fetch(`${base}/calls/${CALL_A}/records`);
      assert.equal(r.status, 429);
      assert.equal(logs[0]?.["event"], "records_rate_limited");
    } finally {
      server.close();
    }
  });
});
