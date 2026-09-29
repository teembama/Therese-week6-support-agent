import { createClient, type SupabaseClient } from "@supabase/supabase-js";

export type Db = SupabaseClient;

export interface ServiceEnv {
  SUPABASE_URL?: string | undefined;
  SUPABASE_SERVICE_ROLE_KEY?: string | undefined;
}

/**
 * Refuses keys that would silently hit RLS (publishable/anon) instead of failing loudly.
 * Legacy JWT keys must carry role=service_role; sb_secret_ keys are accepted as-is.
 */
export function assertServiceKey(key: string): void {
  if (key.startsWith("sb_publishable_")) {
    throw new Error("SUPABASE_SERVICE_ROLE_KEY is a publishable key; a secret/service-role key is required");
  }
  if (key.startsWith("eyJ")) {
    let role: unknown;
    try {
      const payload: unknown = JSON.parse(Buffer.from(key.split(".")[1] ?? "", "base64url").toString("utf8"));
      role = (payload as { role?: unknown }).role;
    } catch {
      throw new Error("SUPABASE_SERVICE_ROLE_KEY is not a valid JWT");
    }
    if (role !== "service_role") {
      throw new Error(`SUPABASE_SERVICE_ROLE_KEY has role "${String(role)}", expected "service_role"`);
    }
  }
}

interface FetchCause {
  code?: string;
  name?: string;
  message?: string;
  errors?: Array<{ code?: string; message?: string }>;
}

/**
 * Network failures that happen BEFORE a request reaches Supabase (DNS, refused or timed-out
 * connect), so retrying cannot duplicate a write. Observed live: EAI_AGAIN from a phone
 * hotspot resolver that intermittently SERVFAILs Supabase project hostnames (D28).
 */
const PRE_CONNECT_CODES = new Set(["EAI_AGAIN", "ECONNREFUSED", "UND_ERR_CONNECT_TIMEOUT", "ETIMEDOUT"]);

/** Only retry if the failed attempt was quick, so the retry stays inside a turn's time budget. */
const RETRY_IF_FAILED_WITHIN_MS = 2_000;
const RETRY_DELAY_MS = 150;

function causeOf(err: unknown): FetchCause | undefined {
  return (err as { cause?: FetchCause }).cause;
}

function isPreConnectFailure(err: unknown): boolean {
  const cause = causeOf(err);
  if (cause?.code && PRE_CONNECT_CODES.has(cause.code)) return true;
  return Boolean(cause?.errors?.length && cause.errors.every((e) => e.code && PRE_CONNECT_CODES.has(e.code)));
}

function describeFailure(input: Parameters<typeof fetch>[0], init: RequestInit | undefined, err: unknown): string {
  const rawUrl = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  let path = "?";
  try {
    path = new URL(rawUrl).pathname;
  } catch {
    /* keep "?" */
  }
  const cause = causeOf(err);
  const inner = cause?.errors?.map((e) => e.code ?? e.message).join(",");
  return (
    `${init?.method ?? "GET"} ${path} | ${err instanceof Error ? err.message : String(err)}` +
    ` | cause: ${cause?.name ?? ""} ${cause?.code ?? ""} ${cause?.message ?? ""}${inner ? ` [${inner}]` : ""}`
  );
}

/**
 * fetch wrapper for the Supabase client:
 * - reports the underlying cause of network failures on stderr ("fetch failed" alone is
 *   undiagnosable): method, path without query string, cause code/message. Never headers,
 *   keys or bodies.
 * - retries ONCE on a pre-connect failure for non-GET/HEAD requests. supabase-js already
 *   retries GET/HEAD itself (observed: 4 attempts), so retrying those here would multiply.
 */
const diagnosticFetch: typeof fetch = async (input, init) => {
  const method = (init?.method ?? "GET").toUpperCase();
  const started = performance.now();
  try {
    return await fetch(input, init);
  } catch (err) {
    console.error(`[relaypay] supabase fetch failed: ${describeFailure(input, init, err)}`);
    const quick = performance.now() - started <= RETRY_IF_FAILED_WITHIN_MS;
    if (method === "GET" || method === "HEAD" || !isPreConnectFailure(err) || !quick || init?.signal?.aborted) throw err;
    await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
    try {
      const res = await fetch(input, init);
      console.error(`[relaypay] supabase fetch retry succeeded: ${method}`);
      return res;
    } catch (retryErr) {
      console.error(`[relaypay] supabase fetch retry failed: ${describeFailure(input, init, retryErr)}`);
      throw retryErr;
    }
  }
};

/** Exposed for unit tests only. */
export const __test = { isPreConnectFailure, diagnosticFetch };

/** Server-side Supabase client using the service-role/secret key. Never use in a browser. */
export function createServiceClient(env: ServiceEnv = process.env): Db {
  const url = env.SUPABASE_URL;
  const key = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url) throw new Error("SUPABASE_URL is not set");
  if (!key) throw new Error("SUPABASE_SERVICE_ROLE_KEY is not set");
  assertServiceKey(key);
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: diagnosticFetch },
  });
}
