// Startup environment for the stdio MCP server. The backend spawns one server per turn and
// passes exactly: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, CONVERSATION_ID, TURN_INDEX (D9).
// Anything missing or malformed means the spawn is wrong, so the server refuses to start.

import type { LogContext } from "@relaypay/shared";

export interface ServerEnv {
  supabaseUrl: string;
  supabaseKey: string;
  context: LogContext;
}

export class StartupError extends Error {}

export function loadServerEnv(env: NodeJS.ProcessEnv = process.env): ServerEnv {
  const problems: string[] = [];
  const conversationId = env["CONVERSATION_ID"]?.trim() ?? "";
  const turnIndexRaw = env["TURN_INDEX"]?.trim() ?? "";
  const supabaseUrl = env["SUPABASE_URL"] ?? "";
  const supabaseKey = env["SUPABASE_SERVICE_ROLE_KEY"] ?? "";

  if (!conversationId) problems.push("CONVERSATION_ID is not set");
  else if (conversationId.length > 200) problems.push("CONVERSATION_ID is longer than 200 characters");
  if (!turnIndexRaw) problems.push("TURN_INDEX is not set");
  else if (!/^\d{1,6}$/.test(turnIndexRaw)) problems.push("TURN_INDEX must be a non-negative integer");
  if (!supabaseUrl) problems.push("SUPABASE_URL is not set");
  if (!supabaseKey) problems.push("SUPABASE_SERVICE_ROLE_KEY is not set");
  // The MCP server never needs the Anthropic key; its presence means the spawn leaked it.
  if (env["ANTHROPIC_API_KEY"]) problems.push("ANTHROPIC_API_KEY must not be passed to the MCP server");

  if (problems.length > 0) {
    throw new StartupError(
      `refusing to start: ${problems.join("; ")}. ` +
        "The backend must spawn this server with SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, " +
        "CONVERSATION_ID and TURN_INDEX (docs/decisions.md D9).",
    );
  }
  return { supabaseUrl, supabaseKey, context: { conversationId, turnIndex: Number(turnIndexRaw) } };
}
