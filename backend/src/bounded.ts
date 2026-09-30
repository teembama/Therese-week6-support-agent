// Bounded waiting (D34): nothing on a caller's path may wait on the database without a limit.

export class TimeoutError extends Error {
  constructor(label: string, ms: number) {
    super(`${label} timed out after ${ms}ms`);
    this.name = "TimeoutError";
  }
}

/** Resolves/rejects like `p`, or rejects with TimeoutError after `ms`. `p` keeps running. */
export function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout;
  return Promise.race([
    p,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new TimeoutError(label, ms)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

/** One try plus ONE retry, each bounded by `ms`. Throws the last error. Background use only. */
export async function retryOnce<T>(fn: () => Promise<T>, ms: number, label: string, delayMs = 300): Promise<T> {
  try {
    return await withTimeout(fn(), ms, label);
  } catch {
    await new Promise((r) => setTimeout(r, delayMs));
    return withTimeout(fn(), ms, `${label} (retry)`);
  }
}
