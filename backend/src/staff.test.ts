// Staff dashboard API (L2, D87): staff-only (401/403), the two filters, test-channel exclusion,
// whitelisted fields (no notes, no amounts), rate limiting. The database is an in-memory fake.

import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, it } from "node:test";
import type { Db } from "@relaypay/shared";
import { handleStaffRecords, parseStaffQuery, readStaffRecords } from "./staff.js";

type Row = Record<string, unknown>;
const conv = (channel: string) => ({ conversations: { channel } });
const TABLES: Record<string, Row[]> = {
  support_tickets: [
    { ticket_id: "TKT-OLD", category: "payout", priority: "normal", status: "open", customer_id: "CUS-1002", summary: "Payout delayed", created_at: "2026-10-01T10:00:00Z", support_notes: "INTERNAL NOTE", amount: 5000, ...conv("voice") },
    { ticket_id: "TKT-NEW", category: "payment", priority: "high", status: "open", customer_id: null, summary: "Refund of $1,250.00 missing", created_at: "2026-10-02T10:00:00Z", ...conv("voice") },
    { ticket_id: "TKT-ESC", category: "account", priority: "high", status: "open", customer_id: "CUS-1001", summary: "Escalation", created_at: "2026-10-02T11:00:00Z", ...conv("voice") },
    { ticket_id: "TKT-TEST", category: "invoice", priority: "normal", status: "open", customer_id: null, summary: "test ticket", created_at: "2026-10-02T12:00:00Z", ...conv("test") },
  ],
  escalations: [
    { escalation_id: "ESC-1", ticket_id: "TKT-ESC", category: "account", customer_id: "CUS-1001", user_name: "Amara", user_email: "amara@lagosledger.example", preferred_time_text: "Monday at 10 AM", callback_slot: "2026-10-05T09:00:00+00:00", status: "open", reason: "Restricted; 300 USD held", call_booked: true, created_at: "2026-10-02T11:00:00Z", ...conv("voice") },
    { escalation_id: "ESC-2", ticket_id: "TKT-X", category: "dispute", customer_id: null, user_name: "Kofi", user_email: "kofi@example.com", preferred_time_text: null, callback_slot: null, status: "open", reason: "No time given", call_booked: false, created_at: "2026-10-02T12:00:00Z", ...conv("voice") },
    // A legacy row (before 009): call_booked true but no slot -> not a scheduled callback.
    { escalation_id: "ESC-L", ticket_id: "TKT-L", category: "account", customer_id: null, user_name: "Ama", user_email: "ama@example.com", preferred_time_text: "tomorrow morning", callback_slot: null, status: "open", reason: "legacy", call_booked: true, created_at: "2026-10-02T12:30:00Z", ...conv("voice") },
    { escalation_id: "ESC-T", ticket_id: "TKT-Y", category: "account", customer_id: null, user_name: "Efua", user_email: "efua@accrastack.example", preferred_time_text: "Friday at 2pm", callback_slot: "2026-10-09T13:00:00+00:00", status: "open", reason: "eval", call_booked: true, created_at: "2026-10-02T13:00:00Z", ...conv("test") },
  ],
};

function fakeDb(user: unknown = { id: "staff-1", app_metadata: { role: "staff" } }): Db {
  const from = (table: string) => {
    const filters: Array<(r: Row) => boolean> = [];
    let desc = false;
    let orderKey = "created_at";
    let limit = Infinity;
    const get = (r: Row, k: string) => (k === "conversations.channel" ? (r["conversations"] as { channel: string }).channel : r[k]);
    const b: Record<string, unknown> = {
      select: () => b,
      eq: (k: string, v: unknown) => { filters.push((r) => get(r, k) === v); return b; },
      neq: (k: string, v: unknown) => { filters.push((r) => get(r, k) !== v); return b; },
      in: (k: string, v: unknown[]) => { filters.push((r) => v.includes(get(r, k))); return b; },
      not: (k: string, op: string, v: unknown) => { if (op === "is" && v === null) filters.push((r) => get(r, k) !== null && get(r, k) !== undefined); return b; },
      order: (k: string, o: { ascending: boolean }) => { orderKey = k; desc = !o.ascending; return b; },
      limit: (n: number) => { limit = n; return b; },
      then: (res: (v: unknown) => unknown) => {
        let rows = (TABLES[table] ?? []).filter((r) => filters.every((f) => f(r)));
        rows = rows.sort((a, c) => String(a[orderKey]).localeCompare(String(c[orderKey])) * (desc ? -1 : 1)).slice(0, limit);
        return Promise.resolve({ data: rows, error: null }).then(res);
      },
    };
    return b;
  };
  return {
    from,
    auth: { getUser: async (t: string) => (t === "t".repeat(40) && user ? { data: { user }, error: null } : { data: { user: null }, error: { status: 401 } }) },
  } as unknown as Db;
}

describe("staff records: reading (D87)", () => {
  it("raised tickets: not linked to an escalation, newest first, test conversations excluded", async () => {
    const r = await readStaffRecords(fakeDb(), "tickets", false);
    assert.deepEqual(r.map((t) => (t as { ticket_id: string }).ticket_id), ["TKT-NEW", "TKT-OLD"]);
  });
  it("include_test=1 adds test conversations", async () => {
    const r = await readStaffRecords(fakeDb(), "tickets", true);
    assert.deepEqual(r.map((t) => (t as { ticket_id: string }).ticket_id), ["TKT-TEST", "TKT-NEW", "TKT-OLD"]);
  });
  it("scheduled callbacks: booked slots only (D97), sorted by slot time, with the slot, email and reason", async () => {
    const r = await readStaffRecords(fakeDb(), "callbacks", false);
    assert.deepEqual(r, [{
      escalation_id: "ESC-1", ticket_id: "TKT-ESC", category: "account", customer_id: "CUS-1001", user_name: "Amara",
      user_email: "amara@lagosledger.example", preferred_time_text: "Monday at 10 AM", callback_slot: "2026-10-05T09:00:00+00:00", status: "open", reason: "Restricted; [amount] held",
      created_at: "2026-10-02T11:00:00Z", channel: "voice",
    }]);
    // The legacy row (call_booked, no slot) is not listed; the test row's later slot sorts after.
    assert.deepEqual((await readStaffRecords(fakeDb(), "callbacks", true)).map((c) => (c as { escalation_id: string }).escalation_id), ["ESC-1", "ESC-T"]);
  });
  it("whitelisted fields only: no support notes, no amounts", async () => {
    const json = JSON.stringify(await readStaffRecords(fakeDb(), "tickets", false));
    for (const bad of ["support_notes", "INTERNAL NOTE", "\"amount\"", "5000", "1,250"]) assert.ok(!json.includes(bad), bad);
    assert.ok(json.includes("Refund of [amount] missing"));
  });
  it("query parsing", () => {
    assert.deepEqual(parseStaffQuery("/staff/records?type=tickets"), { type: "tickets", includeTest: false });
    assert.deepEqual(parseStaffQuery("/staff/records?type=callbacks&include_test=1"), { type: "callbacks", includeTest: true });
    assert.equal(parseStaffQuery("/staff/records?type=all").type, null);
  });
});

describe("staff records: HTTP (D87)", () => {
  async function serve(db: Db, allow = () => true): Promise<{ server: Server; base: string; logs: Row[] }> {
    const logs: Row[] = [];
    const server = createServer((req, res) => void handleStaffRecords(req, res, db, { allow, log: (e) => logs.push(e), headers: {} }));
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    return { server, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, logs };
  }
  const auth = { Authorization: `Bearer ${"t".repeat(40)}` };
  it("staff token: 200 no-store; logs carry a user hash, never the ID or token", async () => {
    const { server, base, logs } = await serve(fakeDb());
    try {
      const r = await fetch(`${base}/staff/records?type=callbacks`, { headers: auth });
      assert.equal(r.status, 200);
      assert.equal(r.headers.get("cache-control"), "no-store");
      const body = (await r.json()) as { type: string; records: unknown[] };
      assert.deepEqual([body.type, body.records.length], ["callbacks", 1]);
      assert.ok(!JSON.stringify(logs).includes("staff-1") && !JSON.stringify(logs).includes("t".repeat(40)));
    } finally {
      server.close();
    }
  });
  it("no token / invalid token: 401; customer role: 403; bad type: 400; rate-limited: 429", async () => {
    const staff = await serve(fakeDb());
    const customer = await serve(fakeDb({ id: "c1", app_metadata: { role: "customer", customer_id: "CUS-1001" } }));
    const limited = await serve(fakeDb(), () => false);
    try {
      assert.equal((await fetch(`${staff.base}/staff/records?type=tickets`)).status, 401);
      assert.equal((await fetch(`${staff.base}/staff/records?type=tickets`, { headers: { Authorization: `Bearer ${"x".repeat(40)}` } })).status, 401);
      assert.equal((await fetch(`${customer.base}/staff/records?type=tickets`, { headers: auth })).status, 403);
      assert.equal((await fetch(`${staff.base}/staff/records?type=everything`, { headers: auth })).status, 400);
      assert.equal((await fetch(`${limited.base}/staff/records?type=tickets`, { headers: auth })).status, 429);
    } finally {
      staff.server.close();
      customer.server.close();
      limited.server.close();
    }
  });
});

describe("staff close (D98)", async () => {
  const { handleStaffClose } = await import("./staff.js");
  const { createServer } = await import("node:http");
  type R = Record<string, unknown>;
  function closeDb(user: unknown) {
    const rows: Record<string, R[]> = {
      escalations: [{ escalation_id: "ESC-1A2B3C4D", conversation_id: "c1", status: "open" }, { escalation_id: "ESC-00000000", conversation_id: "c2", status: "closed" }],
      support_tickets: [{ ticket_id: "TKT-1A2B3C4D", conversation_id: "c1", status: "in progress" }],
    };
    const events: R[] = [];
    const from = (table: string) => {
      const filters: Array<(r: R) => boolean> = [];
      let patch: R | null = null;
      const b: R = {
        select: () => b,
        eq: (k: string, v: unknown) => { filters.push((r) => r[k] === v); return b; },
        neq: (k: string, v: unknown) => { filters.push((r) => r[k] !== v); return b; },
        update: (p: R) => { patch = p; return b; },
        insert: async (row: R) => { events.push(row); return { error: null }; },
        maybeSingle: async () => ({ data: (rows[table] ?? []).find((r) => filters.every((f) => f(r))) ?? null, error: null }),
        then: (res: (v: unknown) => unknown) => {
          const hit = (rows[table] ?? []).filter((r) => filters.every((f) => f(r)));
          if (patch) for (const r of hit) Object.assign(r, patch);
          return Promise.resolve({ data: hit, error: null }).then(res);
        },
      };
      return b;
    };
    const db = { from, auth: { getUser: async (t: string) => (t === "t".repeat(40) && user ? { data: { user }, error: null } : { data: { user: null }, error: { status: 401 } }) } } as unknown as Db;
    return { db, rows, events };
  }
  async function post(db: Db, body: unknown, token?: string) {
    const server = createServer((req, res) => void handleStaffClose(req, res, db, { allow: () => true, log: () => {}, headers: {} }));
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as { port: number }).port;
    try {
      const r = await fetch(`http://127.0.0.1:${port}/staff/records/close`, { method: "POST", headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
      return { status: r.status, body: (await r.json()) as R };
    } finally {
      server.close();
    }
  }
  const STAFF = { id: "u-staff", email: "care@relaypay.example", app_metadata: { role: "staff" } };
  it("staff: closes an escalation (frees its slot), records who and when as an event", async () => {
    const { db, rows, events } = closeDb(STAFF);
    const r = await post(db, { type: "escalation", id: "ESC-1A2B3C4D" }, "t".repeat(40));
    assert.equal(r.status, 200);
    assert.equal(r.body["closed"], true);
    assert.equal(rows["escalations"]![0]!["status"], "closed");
    assert.equal(events.length, 1);
    const meta = events[0]!["metadata"] as R;
    assert.deepEqual([events[0]!["event_type"], meta["action"], meta["closed_by"], typeof meta["closed_at"]], ["other", "closed", "care@relaypay.example", "string"]);
  });
  it("staff: closes an 'in progress' ticket; an already closed item is idempotent; unknown -> 404; bad input -> 400", async () => {
    const { db, rows, events } = closeDb(STAFF);
    assert.equal((await post(db, { type: "ticket", id: "TKT-1A2B3C4D" }, "t".repeat(40))).status, 200);
    assert.equal(rows["support_tickets"]![0]!["status"], "closed");
    const again = await post(db, { type: "escalation", id: "ESC-00000000" }, "t".repeat(40));
    assert.deepEqual([again.status, again.body["closed"]], [200, false]);
    assert.equal((await post(db, { type: "escalation", id: "ESC-FFFFFFFF" }, "t".repeat(40))).status, 404);
    assert.equal((await post(db, { type: "ticket", id: "ESC-1A2B3C4D" }, "t".repeat(40))).status, 400);
    assert.equal(events.length, 1);
  });
  it("unauthorised: no token -> 401; a customer -> 403; nothing changes", async () => {
    const anon = closeDb(STAFF);
    assert.equal((await post(anon.db, { type: "escalation", id: "ESC-1A2B3C4D" })).status, 401);
    const cust = closeDb({ id: "u-c", email: "amara@lagosledger.example", app_metadata: { role: "customer" } });
    assert.equal((await post(cust.db, { type: "escalation", id: "ESC-1A2B3C4D" }, "t".repeat(40))).status, 403);
    assert.equal(anon.rows["escalations"]![0]!["status"], "open");
    assert.equal(cust.rows["escalations"]![0]!["status"], "open");
    assert.equal(anon.events.length + cust.events.length, 0);
  });
});
