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

/** Server-side Supabase client using the service-role/secret key. Never use in a browser. */
export function createServiceClient(env: ServiceEnv = process.env): Db {
  const url = env.SUPABASE_URL;
  const key = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url) throw new Error("SUPABASE_URL is not set");
  if (!key) throw new Error("SUPABASE_SERVICE_ROLE_KEY is not set");
  assertServiceKey(key);
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
