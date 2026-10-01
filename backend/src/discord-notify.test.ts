// Discord sender (D83): message content, claim-before-send, retry and 429, test-row skipping,
// the off switch. The database is an in-memory notification_outbox behind a minimal query builder.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Db } from "@relaypay/shared";
import {
  createDiscordNotifier, formatMessage, isDiscordWebhookUrl, maskAmounts, postToDiscord, retryAfterMs, scrubSecrets,
  SKIPPED_TEST_NOTE, type OutboxKind, type SendResult,
} from "./discord-notify.js";

const URL_OK = "https://discord.com/api/webhooks/123456789/abcDEF_ghi-jkl";

interface Row {
  id: number; kind: OutboxKind; ref_id: string; payload: Record<string, unknown>; status: string; attempts: number;
  last_error: string | null; sent_at: string | null; created_at: string; channel: string;
}

function fakeDb(rows: Row[]): Db {
  const from = () => {
    const filters: Array<(r: Row) => boolean> = [];
    let patch: Partial<Row> | null = null;
    let limit = Infinity;
    const run = () => {
      const hit = rows.filter((r) => filters.every((f) => f(r))).slice(0, patch ? Infinity : limit);
      if (patch) for (const r of hit) Object.assign(r, patch);
      return { data: hit.map((r) => ({ ...r, conversations: { channel: r.channel } })), error: null };
    };
    const b: Record<string, unknown> = {
      select: () => b,
      update: (p: Partial<Row>) => { patch = p; return b; },
      eq: (k: keyof Row, v: unknown) => { filters.push((r) => r[k] === v); return b; },
      gt: (k: keyof Row, v: number) => { filters.push((r) => (r[k] as number) > v); return b; },
      lt: (k: keyof Row, v: string) => { filters.push((r) => String(r[k]) < v); return b; },
      in: (k: keyof Row, v: unknown[]) => { filters.push((r) => v.includes(r[k])); return b; },
      order: () => b,
      limit: (n: number) => { limit = n; return b; },
      then: (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => Promise.resolve(run()).then(res, rej),
    };
    return b;
  };
  return { from } as unknown as Db;
}

const now = new Date().toISOString();
const row = (id: number, over: Partial<Row> = {}): Row => ({
  id, kind: "escalation_created", ref_id: `ESC-${id}`, status: "pending", attempts: 0, last_error: null, sent_at: null,
  created_at: now, channel: "voice",
  payload: { escalation_id: `ESC-${id}`, ticket_id: `TKT-${id}`, category: "account", priority: "high", customer_id: "CUS-1",
    reason: "Account restricted", user_email: "efua@accrastack.example", preferred_time_text: "Tomorrow morning", call_booked: true },
  ...over,
});
const quiet = () => undefined;
const noSleep = async () => undefined;

describe("discord message content", () => {
  it("ticket_created: ID, category, priority, customer, summary", () => {
    const m = formatMessage({ kind: "ticket_created", ref_id: "TKT-1", payload: { ticket_id: "TKT-1", category: "payout", priority: "high", customer_id: "CUS-9", summary: "Payout failed", transaction_id: "TX-1" } });
    for (const s of ["TKT-1", "payout", "high", "CUS-9", "Payout failed"]) assert.ok(m.content.includes(s), s);
    assert.deepEqual(m.allowed_mentions, { parse: [] });
  });
  it("escalation_created / _updated: ID, ticket, category, customer, reason, time, call booked, email", () => {
    const m = formatMessage(row(1));
    for (const s of ["ESC-1", "**Linked ticket:** TKT-1", "**Category:** account", "**Reason:** Account restricted", "**Caller email:** efua@accrastack.example"]) assert.ok(m.content.includes(s), s);
    const u = formatMessage({ ...row(2), kind: "escalation_updated" });
    assert.match(u.content, /ESC-2 updated/);
  });
  it("callback requested: Callback / Caller's preference (verbatim, said <weekday date, time> WAT) / Action lines", () => {
    const m = formatMessage({ ...row(1), created_at: "2026-10-01T23:21:00Z" });
    const lines = m.content.split("\n");
    assert.deepEqual(lines.slice(5, 8), [
      "**Callback:** requested",
      `**Caller's preference:** "Tomorrow morning" (said Friday 2 October, 00:21 WAT)`,
      "**Action:** contact the customer to agree an exact time.",
    ]);
    assert.ok(!/Preferred time|Call booked/.test(m.content), m.content);
  });
  it("no time given: only 'Callback: not requested' (no preference or action lines)", () => {
    const m = formatMessage({ ...row(1), payload: { ...row(1).payload, preferred_time_text: null, call_booked: false } });
    assert.ok(m.content.includes("**Callback:** not requested"));
    assert.ok(!/preference|Action/.test(m.content), m.content);
  });
  it("customer line: verified -> '<ID> (verified on call)'; unverified -> the verify-first instruction", () => {
    assert.ok(formatMessage(row(1)).content.includes("**Customer:** CUS-1 (verified on call)"));
    const t = formatMessage({ kind: "ticket_created", ref_id: "T", payload: { ticket_id: "T", category: "payout", priority: "normal", customer_id: null, summary: "x" } });
    assert.ok(t.content.includes("**Customer:** Not verified on this call. Verify identity before discussing the account."), t.content);
  });
  it("every field is on its own line with a bold label; markdown in a value is shown literally", () => {
    const m = formatMessage({ ...row(1), payload: { ...row(1).payload, reason: "*urgent* _now_" } });
    for (const line of m.content.split("\n").slice(1)) assert.match(line, /^\*\*[^*]+:\*\* \S/, line);
    assert.ok(m.content.includes("\\*urgent\\* \\_now\\_"), m.content);
  });
  it("never includes non-whitelisted fields (amounts, notes) and masks amounts in free text", () => {
    const m = formatMessage({ kind: "ticket_created", ref_id: "T", payload: { ticket_id: "T", summary: "Refund of $1,250.00 and 300 USD pending", amount: 999, support_notes: "SECRET NOTE" } });
    assert.ok(!m.content.includes("999") && !m.content.includes("SECRET NOTE") && !m.content.includes("1,250") && !m.content.includes("300"), m.content);
    assert.equal(maskAmounts("GHS 50 and €20 and 7 dollars; ticket TKT-12"), "[amount] and [amount] and [amount]; ticket TKT-12");
  });
  it("scrubs webhook URLs from errors; validates the URL shape; parses retry_after", () => {
    assert.equal(scrubSecrets(`failed ${URL_OK}?wait=true`, URL_OK), "failed [webhook]?wait=true");
    assert.ok(!scrubSecrets(`x https://discord.com/api/webhooks/1/zzz`).includes("zzz"));
    assert.ok(isDiscordWebhookUrl(URL_OK));
    assert.ok(!isDiscordWebhookUrl("https://evil.example/api/webhooks/1/x"));
    assert.equal(retryAfterMs('{"retry_after": 1.5}', null), 1500);
    assert.equal(retryAfterMs("", "2"), 2000);
  });
  it("postToDiscord: 2xx ok; 429 carries retryAfterMs; network error never leaks the URL", async () => {
    const ok = await postToDiscord(URL_OK, {}, (async () => new Response("{}", { status: 200 })) as typeof fetch);
    assert.equal(ok.ok, true);
    const rl = await postToDiscord(URL_OK, {}, (async () => new Response('{"retry_after":0.25}', { status: 429 })) as typeof fetch);
    assert.deepEqual([rl.ok, rl.retryAfterMs], [false, 250]);
    const ne = await postToDiscord(URL_OK, {}, (async () => { throw new Error(`connect failed to ${URL_OK}`); }) as typeof fetch);
    assert.ok(!ne.ok && !ne.error!.includes("abcDEF"), ne.error);
  });
});

describe("discord sender", () => {
  it("off without DISCORD_WEBHOOK_URL: logs once, sends nothing, rows stay pending", async () => {
    const rows = [row(1)];
    const logs: Array<Record<string, unknown>> = [];
    const n = createDiscordNotifier({ db: fakeDb(rows), webhookUrl: undefined, log: (e) => logs.push(e) });
    n.kick();
    assert.deepEqual(await n.runOnce(), { sent: 0, failed: 0, skipped: 0 });
    assert.equal(n.enabled, false);
    assert.equal(logs.length, 1);
    assert.equal(rows[0]!.status, "pending");
  });
  it("2xx: marked sent with sent_at, one post per row", async () => {
    const rows = [row(1), row(2, { kind: "ticket_created" })];
    const posts: unknown[] = [];
    const n = createDiscordNotifier({ db: fakeDb(rows), webhookUrl: URL_OK, log: quiet, send: async (b) => { posts.push(b); return { ok: true, status: 200 }; } });
    assert.deepEqual(await n.runOnce(), { sent: 2, failed: 0, skipped: 0 });
    assert.equal(posts.length, 2);
    for (const r of rows) assert.ok(r.status === "sent" && r.sent_at && r.attempts === 1 && r.last_error === null);
  });
  it("one retry after a failure, then failed with last_error", async () => {
    const rows = [row(1)];
    let calls = 0;
    const n = createDiscordNotifier({ db: fakeDb(rows), webhookUrl: URL_OK, log: quiet, sleep: noSleep, send: async () => { calls++; return { ok: false, status: 500, error: "HTTP 500: boom" }; } });
    assert.deepEqual(await n.runOnce(), { sent: 0, failed: 1, skipped: 0 });
    assert.equal(calls, 2);
    assert.deepEqual([rows[0]!.status, rows[0]!.attempts, rows[0]!.last_error, rows[0]!.sent_at], ["failed", 2, "HTTP 500: boom", null]);
  });
  it("429: waits retry_after (capped) before the retry, which can succeed", async () => {
    const rows = [row(1)];
    const waits: number[] = [];
    const results: SendResult[] = [{ ok: false, status: 429, retryAfterMs: 1500, error: "HTTP 429" }, { ok: true, status: 200 }];
    const n = createDiscordNotifier({ db: fakeDb(rows), webhookUrl: URL_OK, log: quiet, sleep: async (ms) => { waits.push(ms); }, send: async () => results.shift()! });
    assert.deepEqual(await n.runOnce(), { sent: 1, failed: 0, skipped: 0 });
    assert.deepEqual(waits, [1500]);
    const rows2 = [row(2)];
    const waits2: number[] = [];
    const n2 = createDiscordNotifier({ db: fakeDb(rows2), webhookUrl: URL_OK, log: quiet, sleep: async (ms) => { waits2.push(ms); }, send: async () => ({ ok: false, status: 429, retryAfterMs: 600_000 }) });
    await n2.runOnce();
    assert.deepEqual(waits2, [30_000]);
  });
  it("never double-sends: concurrent sweeps and two notifiers on one table post each row once", async () => {
    const rows = [row(1), row(2), row(3)];
    const db = fakeDb(rows);
    const posted: string[] = [];
    const send = async (b: unknown) => { posted.push((b as { content: string }).content.split("\n")[0]!); await new Promise((r) => setTimeout(r, 5)); return { ok: true, status: 200 }; };
    const a = createDiscordNotifier({ db, webhookUrl: URL_OK, log: quiet, send });
    const b = createDiscordNotifier({ db, webhookUrl: URL_OK, log: quiet, send });
    await Promise.all([a.runOnce(), a.runOnce(), b.runOnce(), b.runOnce()]);
    assert.equal(posted.length, 3, posted.join(" | "));
    assert.ok(rows.every((r) => r.status === "sent"));
  });
  it("a row already claimed (attempts > 0) is not resent; one stuck past 10 min is marked failed", async () => {
    const old = new Date(Date.now() - 11 * 60_000).toISOString();
    const rows = [row(1, { attempts: 1 }), row(2, { attempts: 1, created_at: old })];
    let posts = 0;
    const n = createDiscordNotifier({ db: fakeDb(rows), webhookUrl: URL_OK, log: quiet, send: async () => { posts++; return { ok: true, status: 200 }; } });
    await n.runOnce();
    assert.equal(posts, 0);
    assert.equal(rows[0]!.status, "pending");
    assert.equal(rows[1]!.status, "failed");
  });
  it("test-channel rows are not posted: marked sent with the skip note (unless includeTest)", async () => {
    const rows = [row(1, { channel: "test" }), row(2)];
    let posts = 0;
    const n = createDiscordNotifier({ db: fakeDb(rows), webhookUrl: URL_OK, log: quiet, send: async () => { posts++; return { ok: true, status: 200 }; } });
    assert.deepEqual(await n.runOnce(), { sent: 1, failed: 0, skipped: 1 });
    assert.equal(posts, 1);
    assert.deepEqual([rows[0]!.status, rows[0]!.last_error], ["sent", SKIPPED_TEST_NOTE]);
    const rows2 = [row(3, { channel: "test" }), row(4, { channel: "test" })];
    const n2 = createDiscordNotifier({ db: fakeDb(rows2), webhookUrl: URL_OK, log: quiet, includeTest: true, onlyIds: [3], send: async () => ({ ok: true, status: 200 }) });
    assert.deepEqual(await n2.runOnce(), { sent: 1, failed: 0, skipped: 0 });
    assert.equal(rows2[1]!.status, "pending");
  });
  it("a database error never throws out of kick/runOnce", async () => {
    const db = { from: () => { throw new Error("db down"); } } as unknown as Db;
    const logs: Array<Record<string, unknown>> = [];
    const n = createDiscordNotifier({ db, webhookUrl: URL_OK, log: (e) => logs.push(e) });
    n.kick();
    assert.deepEqual(await n.runOnce(), { sent: 0, failed: 0, skipped: 0 });
    assert.ok(logs.some((l) => l["event"] === "discord_sweep_failed"));
  });
});
