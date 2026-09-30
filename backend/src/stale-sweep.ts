// Stale cleanup (Batch 2D step 2, D51): abandon_stale_conversations() (migration 005) on startup
// and every STALE_SWEEP_INTERVAL_MS. A sweep never overlaps the previous one; each run logs its
// count (or its error). The timer is unref'd, so it never keeps the process alive.

import type { Db } from "@relaypay/shared";

export interface StaleSweeper {
  /** Runs one sweep now unless one is already running; resolves with the count, or null if skipped/failed. */
  runOnce(): Promise<number | null>;
  stop(): void;
}

export function startStaleSweeper(db: Db, intervalMs: number, log: (event: Record<string, unknown>) => void): StaleSweeper {
  let running = false;
  const runOnce = async (): Promise<number | null> => {
    if (running) {
      log({ event: "stale_sweep_skipped", reason: "previous sweep still running" });
      return null;
    }
    running = true;
    const t0 = performance.now();
    try {
      const { data, error } = await db.rpc("abandon_stale_conversations");
      if (error) throw new Error(`${error.code ?? ""} ${error.message}`);
      const abandoned = Number(data ?? 0);
      log({ event: "stale_sweep", abandoned, ms: Math.round(performance.now() - t0) });
      return abandoned;
    } catch (err) {
      log({ event: "stale_sweep_failed", message: err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200) });
      return null;
    } finally {
      running = false;
    }
  };
  void runOnce();
  const timer = setInterval(() => void runOnce(), intervalMs);
  timer.unref();
  return { runOnce, stop: () => clearInterval(timer) };
}
