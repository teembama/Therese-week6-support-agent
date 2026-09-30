// Launches the RelayPay MCP server for the MCP Inspector, with a fresh 'test-inspector-…'
// conversation and a real ACTIVE attempt, so the guarded write tools can be tried by hand.
// Secrets are read from .env inside this process, never passed on a command line.
//
//   npm run build
//   npx @modelcontextprotocol/inspector node scripts/inspector-server.mjs          (UI)
//   npx @modelcontextprotocol/inspector --cli node scripts/inspector-server.mjs --method tools/list
//
// stdout is the MCP channel: everything here writes to stderr.

import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
process.loadEnvFile(resolve(REPO, ".env"));
// The MCP server refuses to start with the Anthropic key present (D18), and needs no other secret.
for (const name of ["ANTHROPIC_API_KEY", "VAPI_LLM_SECRET"]) delete process.env[name];

const { createServiceClient, newAttemptId, transcriptHash } = await import(pathToFileURL(resolve(REPO, "shared", "dist", "index.js")).href);
const db = createServiceClient();
const conversationId = `test-inspector-${new Date().toISOString().replace(/[:.]/g, "-")}`;
const attemptId = newAttemptId();
const { error } = await db.rpc("begin_turn_attempt", {
  p_conversation_id: conversationId, p_channel: "test", p_caller: "scripts/inspector-server.mjs", p_turn_index: 0,
  p_attempt_id: attemptId, p_transcript_hash: transcriptHash("inspector session"), p_user_transcript: "inspector session",
});
if (error) {
  console.error(`[inspector-server] could not register the test attempt: ${error.message}`);
  process.exit(1);
}
process.env["CONVERSATION_ID"] = conversationId;
process.env["TURN_INDEX"] = "0";
process.env["ATTEMPT_ID"] = attemptId;
console.error(`[inspector-server] conversation ${conversationId}, attempt ${attemptId}`);
await import(pathToFileURL(resolve(REPO, "mcp-server", "dist", "main.js")).href);
