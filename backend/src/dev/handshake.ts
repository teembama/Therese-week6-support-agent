// Task 4 step 1: bare Agent SDK -> RelayPay MCP handshake, with timings and usage.
// Run: npm run handshake -w @relaypay/backend   (after `npm run build`)

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { query, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { createServiceClient } from "@relaypay/shared";
import { cliEnv, mcpEnv } from "../child-env.js";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const MCP_ENTRY = resolve(REPO, "mcp-server", "dist", "main.js");
const ALLOWED = ["mcp__relaypay__search_knowledge_base"];

async function main(): Promise<void> {
  process.loadEnvFile(resolve(REPO, ".env"));
  const db = createServiceClient();
  const conversationId = `test-handshake-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  const { error } = await db.from("conversations").insert({ conversation_id: conversationId, channel: "test", caller: "backend/src/dev/handshake.ts" });
  if (error) throw new Error(`test conversation: ${error.message}`);
  console.log(`conversation: ${conversationId}`);
  console.log(`node: ${process.execPath} (${process.version})`);

  const cliStderr: string[] = [];
  const t0 = performance.now();
  console.log(`query() called at ${new Date().toISOString()}`);
  const ms = () => Math.round(performance.now() - t0);
  const marks: Record<string, number> = {};

  const q = query({
    prompt: "What fees does RelayPay charge for international payments? Look it up with your search tool, then answer in one sentence.",
    options: {
      model: "claude-haiku-4-5",
      systemPrompt: "You are RelayPay's support agent. Use the search_knowledge_base tool to look up policy before answering.",
      tools: [],
      allowedTools: ALLOWED,
      permissionMode: "dontAsk",
      settingSources: [],
      strictMcpConfig: true,
      persistSession: false,
      maxTurns: Number(process.env["HANDSHAKE_MAX_TURNS"] || 2),
      includePartialMessages: true,
      env: cliEnv(),
      stderr: (d) => cliStderr.push(d),
      mcpServers: {
        relaypay: {
          type: "stdio",
          command: process.execPath,
          // HANDSHAKE_MCP_WRAPPER="<wrapper.mjs> <logfile>" runs the server through a diagnostic
          // wrapper (dev only), e.g. to see what env the CLI actually hands the MCP server.
          args: process.env["HANDSHAKE_MCP_WRAPPER"]
            ? [...process.env["HANDSHAKE_MCP_WRAPPER"].split(" "), MCP_ENTRY]
            : [MCP_ENTRY],
          env: mcpEnv({ conversationId, turnIndex: 0 }),
          alwaysLoad: true,
        },
      },
    },
  });

  let text = "";
  for await (const m of q as AsyncIterable<SDKMessage>) {
    if (m.type === "system" && m.subtype === "init") {
      marks["init"] ??= ms();
      console.log(`\n[${ms()}ms] system/init`);
      console.log(`  claude_code_version: ${m.claude_code_version}`);
      console.log(`  model: ${m.model}  permissionMode: ${m.permissionMode}  apiKeySource: ${m.apiKeySource}`);
      console.log(`  mcp_servers: ${JSON.stringify(m.mcp_servers)}`);
      console.log(`  tools (${m.tools.length}): ${JSON.stringify(m.tools)}`);
      console.log(`  tools == allowlist: ${JSON.stringify([...m.tools].sort()) === JSON.stringify([...ALLOWED].sort())}`);
      console.log(`  skills: ${JSON.stringify(m.skills)}  agents: ${JSON.stringify(m.agents ?? [])}  plugins: ${JSON.stringify(m.plugins)}`);
      console.log(`  slash_commands (${m.slash_commands.length}): ${JSON.stringify(m.slash_commands).slice(0, 300)}`);
    } else if (m.type === "stream_event") {
      const e = m.event;
      if (e.type === "content_block_delta" && e.delta.type === "text_delta") {
        marks["firstText"] ??= ms();
        text += e.delta.text;
      } else if (e.type === "content_block_start" && e.content_block.type === "tool_use") {
        marks["firstToolUse"] ??= ms();
        console.log(`[${ms()}ms] tool_use start: ${e.content_block.name}`);
      }
    } else if (m.type === "assistant") {
      for (const b of m.message.content) {
        if (b.type === "text") console.log(`[${ms()}ms] assistant text block: ${JSON.stringify(b.text)}`);
        if (b.type === "tool_use") console.log(`[${ms()}ms] assistant tool_use: ${b.name} ${JSON.stringify(b.input)}`);
      }
    } else if (m.type === "user") {
      const content = m.message.content;
      if (Array.isArray(content)) {
        for (const b of content) {
          if (typeof b === "object" && b && "type" in b && b.type === "tool_result") {
            marks["toolResult"] ??= ms();
            console.log(`[${ms()}ms] tool_result (is_error=${"is_error" in b ? b.is_error : false}): ${JSON.stringify(b.content).slice(0, 200)}…`);
          }
        }
      }
    } else if (m.type === "result") {
      marks["result"] = ms();
      console.log(`\n[${ms()}ms] result`);
      console.log(`  subtype: ${m.subtype}  is_error: ${m.is_error}  num_turns: ${m.num_turns}  stop_reason: ${m.stop_reason}`);
      console.log(`  duration_ms: ${m.duration_ms}  duration_api_ms: ${m.duration_api_ms}`);
      console.log(`  total_cost_usd (estimate): ${m.total_cost_usd}`);
      console.log(`  usage: ${JSON.stringify(m.usage)}`);
      console.log(`  modelUsage: ${JSON.stringify(m.modelUsage)}`);
      if (m.subtype === "success") console.log(`  result: ${JSON.stringify(m.result)}`);
      else console.log(`  errors: ${JSON.stringify(m.errors)}`);
    }
  }

  console.log(`\nstreamed text: ${JSON.stringify(text)}`);
  console.log(`timings (ms from query() call): ${JSON.stringify(marks)}`);
  const { data: calls } = await db.from("tool_calls").select("tool_name, status, duration_ms, input_summary").eq("conversation_id", conversationId);
  console.log(`tool_calls rows for this conversation: ${JSON.stringify(calls)}`);
  const mcpLines = cliStderr.join("").split("\n").filter((l) => /relaypay|mcp/i.test(l));
  if (mcpLines.length) console.log(`CLI stderr (mcp-related):\n  ${mcpLines.slice(0, 20).join("\n  ")}`);
}

main().catch((err: unknown) => {
  console.error(`HANDSHAKE ERROR: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
  process.exit(1);
});
