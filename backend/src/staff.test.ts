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
