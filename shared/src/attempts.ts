// Turn attempts (migration 003, D28): transcript hashing and the guarded write path (D29).

import { createHash, randomBytes } from "node:crypto";
import type { Db } from "./supabase.js";

/** Hash of the latest caller message; whitespace-normalised so only real changes differ. */
export function transcriptHash(text: string): string {
  return createHash("sha256").update(text.trim().replace(/\s+/g, " "), "utf8").digest("hex").slice(0, 32);
}

export function newAttemptId(): string {
  return `ATT-${randomBytes(8).toString("hex").toUpperCase()}`;
}

/** The attempt is no longer active (replaced/aborted/completed/unknown): nothing was written. */
export class AttemptNotActiveError extends Error {
  constructor(readonly attemptId: string | undefined, detail: string) {
    super(`ATTEMPT_NOT_ACTIVE: ${detail}`);
    this.name = "AttemptNotActiveError";
  }
}

/**
 * The ONLY way a write tool may write (D29). Calls a Postgres write function with
 * p_attempt_id added; that function must call require_active_attempt(p_attempt_id) and then
 * write, in one transaction, so the check and the write cannot be separated by a replacement.
 * Throws AttemptNotActiveError when the database reports P0001 ATTEMPT_NOT_ACTIVE (or when
 * there is no attempt id to pass). There is deliberately no standalone "is it active?" helper:
 * a separate check followed by a separate write leaves a race window.
 */
export async function guardedRpc<T = unknown>(
  db: Db,
  fn: string,
  params: Record<string, unknown>,
  attemptId: string | undefined,
): Promise<T> {
  if (!attemptId) throw new AttemptNotActiveError(attemptId, "no attempt id for this write");
  const { data, error } = await db.rpc(fn, { ...params, p_attempt_id: attemptId });
  if (error) {
    if (error.code === "P0001" && error.message.startsWith("ATTEMPT_NOT_ACTIVE")) {
      throw new AttemptNotActiveError(attemptId, error.message.replace(/^ATTEMPT_NOT_ACTIVE:\s*/, ""));
    }
    throw new Error(`${fn} failed (${error.code}): ${error.message}`);
  }
  return data as T;
}
