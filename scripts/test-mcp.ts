// End-to-end test of the stdio MCP server through the real MCP client, spawned the way the
// backend will spawn it: process.execPath (same pinned Node, D12) and an explicit env with
// only the Supabase URL/key, CONVERSATION_ID and TURN_INDEX (D9), no Anthropic key.
//
// 1. Start with CONVERSATION_ID missing -> must refuse (non-zero exit, clear stderr).
// 2. tools/list.
// 3. search_knowledge_base with the fees question -> success.
// 4. search_knowledge_base with an empty query -> invalid_input.
// 5. search_knowledge_base with a model-supplied conversation_id -> ignored; logged under ours.
// Then prints the tool_calls and retrieval_logs rows for the test conversation.
// Requires migration 002 and a built mcp-server (npm run build).

import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { createServiceClient, newAttemptId, transcriptHash } from "@relaypay/shared";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SERVER = resolve(REPO, "mcp-server", "dist", "main.js");

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set in .env`);
  return value;
}

async function main(): Promise<number> {
  process.loadEnvFile(resolve(REPO, ".env"));
  const db = createServiceClient();
  const conversationId = `test-mcp-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  const attemptId = newAttemptId();
  const serverEnv = {
    ...getDefaultEnvironment(),
    SUPABASE_URL: requireEnv("SUPABASE_URL"),
    SUPABASE_SERVICE_ROLE_KEY: requireEnv("SUPABASE_SERVICE_ROLE_KEY"),
    CONVERSATION_ID: conversationId,
    TURN_INDEX: "0",
    ATTEMPT_ID: attemptId,
  };
  let failures = 0;
  const check = (ok: boolean, label: string) => {
    console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
    if (!ok) failures++;
  };

  console.log("== 1. start with CONVERSATION_ID missing");
  const { CONVERSATION_ID: _omit, ...envWithout } = serverEnv;
  const refused = spawnSync(process.execPath, [SERVER], { env: envWithout, input: "", encoding: "utf8", timeout: 15_000 });
  console.log(`exit code: ${refused.status}`);
  console.log(`stderr: ${refused.stderr.trim()}`);
  check(refused.status !== 0 && refused.stderr.includes("CONVERSATION_ID is not set"), "server refuses to start without CONVERSATION_ID");

  console.log("\n== 1b. start with ATTEMPT_ID missing");
  const { ATTEMPT_ID: _noAttempt, ...envNoAttempt } = serverEnv;
  const refusedAttempt = spawnSync(process.execPath, [SERVER], { env: envNoAttempt, input: "", encoding: "utf8", timeout: 15_000 });
  check(refusedAttempt.status !== 0 && refusedAttempt.stderr.includes("ATTEMPT_ID is not set"), "server refuses to start without ATTEMPT_ID");

  console.log("\n== 1c. ANTHROPIC_API_KEY scrubbed before the server loads (D13), for main.js AND the bundle the backend spawns");
  for (const entry of [SERVER, resolve(REPO, "mcp-server", "dist", "bundle", "server.mjs")]) {
    const r = spawnSync(process.execPath, [entry], { env: { ...serverEnv, ANTHROPIC_API_KEY: "sk-ant-test-not-a-real-key" }, input: "", encoding: "utf8", timeout: 15_000 });
    const label = entry.endsWith("server.mjs") ? "bundle" : "main.js";
    check(r.stderr.includes("ANTHROPIC_API_KEY was present") && r.stderr.includes("ANTHROPIC_API_KEY in env: false"), `${label}: key removed before startup, server saw none`);
  }

  // Register the attempt the MCP server acts for (migration 003); this also creates the conversation.
  const { error: beginError } = await db.rpc("begin_turn_attempt", {
    p_conversation_id: conversationId, p_channel: "test", p_caller: "scripts/test-mcp.ts", p_turn_index: 0,
    p_attempt_id: attemptId, p_transcript_hash: transcriptHash("mcp test"), p_user_transcript: "mcp test",
  });
  if (beginError) throw new Error(`could not register test attempt: ${beginError.message}`);
  console.log(`\ntest conversation: ${conversationId} (channel=test), attempt ${attemptId}`);

  const client = new Client({ name: "relaypay-test-mcp", version: "0.1.0" });
  const transport = new StdioClientTransport({ command: process.execPath, args: [SERVER], env: serverEnv, stderr: "pipe" });
  transport.stderr?.on("data", (d: Buffer) => process.stderr.write(`  [server stderr] ${d}`));
  await client.connect(transport);

  try {
    console.log("\n== 2. tools/list");
    const { tools } = await client.listTools();
    for (const t of tools) console.log(`${t.name}: inputSchema=${JSON.stringify(t.inputSchema)}`);
    // Batch 2B added the six support tools (the agent's allowlist is unchanged until 2C).
    const expected = ["create_escalation", "create_support_ticket", "log_conversation_event", "lookup_customer", "lookup_payout", "lookup_transaction", "search_knowledge_base"];
    check(JSON.stringify(tools.map((t) => t.name).sort()) === JSON.stringify(expected), `exactly the 7 tools: ${expected.join(", ")}`);

    console.log("\n== 2b. MCP_TOOLSET=agent (how the backend spawns it)");
    const agentClient = new Client({ name: "relaypay-test-mcp-agent", version: "0.1.0" });
    await agentClient.connect(new StdioClientTransport({ command: process.execPath, args: [SERVER], env: { ...serverEnv, MCP_TOOLSET: "agent" }, stderr: "pipe" }));
    try {
      const agentTools = (await agentClient.listTools()).tools.map((t) => t.name).sort();
      console.log(`agent toolset: ${agentTools.join(", ")}`);
      check(JSON.stringify(agentTools) === JSON.stringify(expected.filter((n) => n !== "search_knowledge_base")), "agent toolset: the 6 support tools, no search_knowledge_base");
      const hidden = (await agentClient.callTool({ name: "search_knowledge_base", arguments: { query: "fees" } })).structuredContent as Record<string, unknown>;
      check((hidden["error"] as Record<string, unknown> | undefined)?.["code"] === "unknown_tool", "agent toolset: calling search_knowledge_base -> unknown_tool");
    } finally {
      await agentClient.close();
    }

    const call = async (label: string, args: Record<string, unknown>) => {
      console.log(`\n== ${label}\narguments: ${JSON.stringify(args)}`);
      const result = await client.callTool({ name: "search_knowledge_base", arguments: args });
      const structured = result.structuredContent as Record<string, unknown> | undefined;
      console.log(`isError: ${result.isError ?? false}`);
      console.log(`structuredContent: ${JSON.stringify(structured).slice(0, 900)}`);
      return { result, structured };
    };

    const fees = await call("3. fees question", { query: "What fees does RelayPay charge for international payments?" });
    const feeChunks = (fees.structured?.["chunks"] ?? []) as Array<{ chunk_id: string }>;
    check(fees.structured?.["status"] === "success" && fees.result.isError !== true, "fees question: status success");
    check(feeChunks.some((c) => c.chunk_id === "frequently-asked-questions--how-does-relaypay-charge-fees"),
      "fees question: fee FAQ chunk returned");

    const empty = await call("4. empty query", { query: "" });
    check(empty.structured?.["status"] === "invalid_input" && empty.result.isError === true, "empty query: invalid_input, isError");

    const injected = await call("5. model-supplied conversation_id", { query: "how long do payouts take", conversation_id: "attacker-chosen-id" });
    check(injected.structured?.["status"] === "success", "extra conversation_id key: call still succeeds");
  } finally {
    await client.close();
  }

  console.log("\n== 6. log write fails (conversation row does not exist) -> tool still returns");
  const orphanClient = new Client({ name: "relaypay-test-mcp-orphan", version: "0.1.0" });
  const orphanTransport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER],
    env: { ...serverEnv, CONVERSATION_ID: `${conversationId}-missing-row` },
    stderr: "pipe",
  });
  let orphanStderr = "";
  orphanTransport.stderr?.on("data", (d: Buffer) => (orphanStderr += d.toString()));
  await orphanClient.connect(orphanTransport);
  try {
    const r = await orphanClient.callTool({ name: "search_knowledge_base", arguments: { query: "" } });
    const s = r.structuredContent as Record<string, unknown> | undefined;
    console.log(`structuredContent: ${JSON.stringify(s)}`);
    await new Promise((done) => setTimeout(done, 200)); // let stderr flush
    console.log(`server stderr: ${orphanStderr.trim().split("\n").filter((l) => l.includes("log write")).join(" | ")}`);
    check(s?.["status"] === "invalid_input", "tool result still returned when the log write fails");
    check(orphanStderr.includes("log write to tool_calls failed"), "log failure reported on stderr");
  } finally {
    await orphanClient.close();
  }

  // Log writes happen before each tool returns, so the rows are already there.
  console.log(`\n== tool_calls for ${conversationId}`);
  const { data: calls, error: callsError } = await db
    .from("tool_calls")
    .select("id, conversation_id, turn_index, attempt_id, tool_name, status, input_summary, result_summary, error_message, duration_ms")
    .eq("conversation_id", conversationId)
    .order("id");
  if (callsError) throw new Error(callsError.message);
  console.table(calls);
  check(calls?.length === 4, "4 tool_calls rows (hidden search_knowledge_base, fees, empty, injected)");
  check((calls ?? []).every((c) => c.attempt_id === attemptId), "tool_calls rows carry the spawning attempt_id");
  check((calls ?? []).map((c) => c.status).join(",") === "invalid_input,success,invalid_input,success", "statuses: invalid_input (hidden tool), success, invalid_input, success");

  console.log(`\n== retrieval_logs for ${conversationId}`);
  const { data: logs, error: logsError } = await db
    .from("retrieval_logs")
    .select("id, conversation_id, turn_index, query, chunk_ids, insufficient_knowledge, source_summary")
    .eq("conversation_id", conversationId)
    .order("id");
  if (logsError) throw new Error(logsError.message);
  for (const l of logs ?? []) console.log(JSON.stringify(l, null, 1));
  check(logs?.length === 2, "2 retrieval_logs rows (empty query never reaches retrieval)");

  const { count: leaked } = await db
    .from("tool_calls")
    .select("*", { count: "exact", head: true })
    .eq("conversation_id", "attacker-chosen-id");
  check(leaked === 0, "nothing logged under the model-supplied conversation_id");

  await db.rpc("finish_turn_attempt", { p_attempt_id: attemptId, p_status: "failed", p_status_reason: "mcp test harness (no agent)", p_metrics: {}, p_turn: null });
  await db.from("conversations").update({ ended_at: new Date().toISOString(), final_status: "completed", summary: "MCP server test run" }).eq("conversation_id", conversationId);
  console.log(`\n${failures === 0 ? "TEST-MCP OK" : `TEST-MCP FAILED (${failures})`}`);
  return failures === 0 ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    console.error(`TEST-MCP ERROR: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  },
);
