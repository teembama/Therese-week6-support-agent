// Lever 4 evidence: the exact Agent SDK stream-event sequence the gate sees.
//   case A: a real no-tool turn (our system prompt, pre-turn chunks): how the header arrives.
//   case B: an agent WITH a tool, told to speak before calling it: can tool_use follow text
//           in the same message, and in what order do the events arrive?
// Run: node backend/dist/dev/trace-events.js

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { createServiceClient, rankKnowledge } from "@relaypay/shared";
import { cliEnv, mcpEnv } from "../child-env.js";
import { AGENT_MODEL } from "../config.js";
import { upsertConversation } from "../persistence.js";
import { buildTurnPrompt, SYSTEM_PROMPT } from "../prompt.js";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const MCP_ENTRY = resolve(REPO, "mcp-server", "dist", "main.js");

async function trace(label: string, prompt: string, systemPrompt: string, withTool: boolean, conversationId: string) {
  console.log(`\n=== ${label}`);
  const t0 = performance.now();
  const ms = () => String(Math.round(performance.now() - t0)).padStart(5);
  let text = "";
  const q = query({
    prompt,
    options: {
      model: AGENT_MODEL,
      systemPrompt,
      tools: [],
      allowedTools: withTool ? ["mcp__relaypay__search_knowledge_base"] : [],
      permissionMode: "dontAsk",
      settingSources: [],
      strictMcpConfig: true,
      persistSession: false,
      maxTurns: 3,
      thinking: { type: "disabled" },
      includePartialMessages: true,
      env: cliEnv(),
      mcpServers: withTool
        ? { relaypay: { type: "stdio", command: process.execPath, args: [MCP_ENTRY], env: mcpEnv({ conversationId, turnIndex: 0 }), alwaysLoad: true } }
        : {},
    },
  });
  for await (const m of q) {
    if (m.type === "stream_event" && m.parent_tool_use_id === null) {
      const e = m.event;
      if (e.type === "message_start") console.log(`${ms()}  message_start`);
      else if (e.type === "content_block_start") console.log(`${ms()}  content_block_start index=${e.index} type=${e.content_block.type}${e.content_block.type === "tool_use" ? ` name=${e.content_block.name}` : ""}`);
      else if (e.type === "content_block_delta" && e.delta.type === "text_delta") {
        text += e.delta.text;
        console.log(`${ms()}    text_delta +${String(e.delta.text.length).padStart(3)} chars  ${JSON.stringify(e.delta.text)}`);
      } else if (e.type === "content_block_delta" && e.delta.type === "input_json_delta") console.log(`${ms()}    input_json_delta ${JSON.stringify(e.delta.partial_json)}`);
      else if (e.type === "content_block_stop") console.log(`${ms()}  content_block_stop index=${e.index}`);
      else if (e.type === "message_delta") console.log(`${ms()}  message_delta stop_reason=${e.delta.stop_reason}`);
      else if (e.type === "message_stop") console.log(`${ms()}  message_stop`);
    } else if (m.type === "assistant") {
      console.log(`${ms()}  [assistant message: ${m.message.content.map((b) => b.type).join(", ")}]`);
    } else if (m.type === "user") {
      console.log(`${ms()}  [user message: tool_result]`);
    } else if (m.type === "result") {
      console.log(`${ms()}  [result ${m.subtype}]`);
    }
  }
  console.log(`full text: ${JSON.stringify(text)}`);
}

async function main(): Promise<void> {
  process.loadEnvFile(resolve(REPO, ".env"));
  const db = createServiceClient();
  const conversationId = `test-trace-events-${Date.now()}`;
  await upsertConversation(db, conversationId, "test", "trace-events");

  const q = "What fees does RelayPay charge for international payments?";
  const chunks = await rankKnowledge(db, q);
  await trace("A: real no-tool turn (header arrival)", buildTurnPrompt([], q, chunks), SYSTEM_PROMPT, false, conversationId);

  await trace(
    "B: tool available, told to speak first",
    "Before doing anything else, say exactly: 'One moment while I check that for you.' Then, in the same reply, call search_knowledge_base with query 'fees'. After the tool result, answer in one sentence.",
    "You are a test assistant. Follow the user's instructions about ordering exactly.",
    true,
    conversationId,
  );
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.stack : String(err));
  process.exit(1);
});
