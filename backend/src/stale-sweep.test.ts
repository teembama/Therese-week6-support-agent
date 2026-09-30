// Stale sweeper (D51): startup run, overlap guard, logged counts and errors.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Db } from "@relaypay/shared";
import { startStaleSweeper } from "./stale-sweep.js";

function stubDb(results: Array<{ data: unknown; error: unknown }>, delayMs = 0): { db: Db; calls: string[] } {
  const calls: string[] = [];
  const db = {
    rpc: async (fn: string) => {
      calls.push(fn);
      await new Promise((r) => setTimeout(r, delayMs));
      return results.shift() ?? { data: 0, error: null };
    },
  } as unknown as Db;
  return { db, calls };
}

describe("stale sweeper", () => {
  it("sweeps on startup and logs the count", async () => {
    const logs: Array<Record<string, unknown>> = [];
    const { db, calls } = stubDb([{ data: 3, error: null }], 10);
    const s = startStaleSweeper(db, 60_000, (e) => logs.push(e));
    await new Promise((r) => setTimeout(r, 50));
    s.stop();
    assert.deepEqual(calls, ["abandon_stale_conversations"]);
    assert.equal(logs[0]?.["event"], "stale_sweep");
    assert.equal(logs[0]?.["abandoned"], 3);
  });
  it("never overlaps: a sweep requested while one runs is skipped and logged", async () => {
    const logs: Array<Record<string, unknown>> = [];
    const { db, calls } = stubDb([{ data: 0, error: null }], 100);
    const s = startStaleSweeper(db, 60_000, (e) => logs.push(e)); // startup sweep in flight
    assert.equal(await s.runOnce(), null);
    await new Promise((r) => setTimeout(r, 150));
    s.stop();
    assert.equal(calls.length, 1);
    assert.ok(logs.some((e) => e["event"] === "stale_sweep_skipped"));
  });
  it("logs a failure and keeps going", async () => {
    const logs: Array<Record<string, unknown>> = [];
    const { db } = stubDb([{ data: null, error: { code: "PGRST000", message: "boom" } }, { data: 1, error: null }]);
    const s = startStaleSweeper(db, 60_000, (e) => logs.push(e));
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(await s.runOnce(), 1);
    s.stop();
    assert.deepEqual(logs.map((e) => e["event"]), ["stale_sweep_failed", "stale_sweep"]);
  });
});
