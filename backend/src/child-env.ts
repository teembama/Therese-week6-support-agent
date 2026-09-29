// Environments for the two child processes of a turn. Each gets an explicit allowlist, never
// the backend's full process.env (which also holds the Supabase secret and VAPI_LLM_SECRET).
//
// - Claude Code CLI (spawned by the Agent SDK): OS basics + ANTHROPIC_API_KEY. The SDK's
//   `env` option REPLACES the subprocess environment, so this is the whole of it.
// - RelayPay MCP server: OS basics + SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
//   CONVERSATION_ID, TURN_INDEX, ATTEMPT_ID (D9, D28). Never the Anthropic key (D13).

import type { LogContext } from "@relaypay/shared";

// OS variables a Node child needs to run on Windows/macOS/Linux (DNS, TLS, temp, home).
const OS_BASICS = [
  "PATH", "PATHEXT", "SYSTEMROOT", "SystemRoot", "WINDIR", "COMSPEC", "SYSTEMDRIVE",
  "TEMP", "TMP", "TMPDIR", "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "PROGRAMDATA",
  "HOMEDRIVE", "HOMEPATH", "USERNAME", "USER", "LOGNAME", "SHELL", "LANG", "LC_ALL", "TZ",
  "PROCESSOR_ARCHITECTURE", "PROGRAMFILES", "PROGRAMFILES(X86)", "PROGRAMW6432",
] as const;

function osBasics(source: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of OS_BASICS) {
    const value = source[name];
    if (value !== undefined) out[name] = value;
  }
  return out;
}

function required(source: NodeJS.ProcessEnv, name: string): string {
  const value = source[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

export function cliEnv(source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  return {
    ...osBasics(source),
    ANTHROPIC_API_KEY: required(source, "ANTHROPIC_API_KEY"),
    CLAUDE_AGENT_SDK_CLIENT_APP: "relaypay-support/0.1.0",
    // Documented (code.claude.com/docs/en/env-vars) to skip the background small/fast-model
    // request that generates a session title. A/B-measured: p50 first token 2855 -> 1960ms and
    // cost per turn halved (docs/latency.md, D25).
    CLAUDE_CODE_DISABLE_TERMINAL_TITLE: "1",
  };
}

export function mcpEnv(ctx: LogContext, source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  return {
    ...osBasics(source),
    SUPABASE_URL: required(source, "SUPABASE_URL"),
    SUPABASE_SERVICE_ROLE_KEY: required(source, "SUPABASE_SERVICE_ROLE_KEY"),
    CONVERSATION_ID: ctx.conversationId,
    TURN_INDEX: String(ctx.turnIndex),
    ATTEMPT_ID: required({ ATTEMPT_ID: ctx.attemptId }, "ATTEMPT_ID"),
  };
}
