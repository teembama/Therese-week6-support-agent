// RelayPay support MCP server (stdio). Spawned by the backend once per turn.
//
// Uses the SDK's low-level Server rather than McpServer.registerTool: registerTool rejects
// schema-invalid arguments before any handler runs, which would leave invalid calls unlogged.
// Here every tools/call, valid or not, goes through withToolLogging.
// stdout is the JSON-RPC channel; all diagnostics go to stderr.

import { Server } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { createServiceClient, logToolCall } from "@relaypay/shared";
import * as z from "zod";
import { loadServerEnv, StartupError } from "./env.js";
import { toToolResult, type LoggedTool, type ToolDeps } from "./tool-logging.js";
import * as createEscalation from "./tools/create-escalation.js";
import * as createSupportTicket from "./tools/create-support-ticket.js";
import * as logConversationEvent from "./tools/log-conversation-event.js";
import * as lookupCustomer from "./tools/lookup-customer.js";
import * as lookupPayout from "./tools/lookup-payout.js";
import * as lookupTransaction from "./tools/lookup-transaction.js";
import * as searchKnowledgeBase from "./tools/search-knowledge-base.js";

interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: z.ZodType;
  handler: LoggedTool;
}

const ALL_TOOLS: readonly ToolDefinition[] = [
  searchKnowledgeBase,
  lookupCustomer,
  lookupTransaction,
  lookupPayout,
  createSupportTicket,
  createEscalation,
  logConversationEvent,
];

/** Hidden from the agent (MCP_TOOLSET=agent): retrieval is a backend-owned pre-turn step (D20). */
const NOT_FOR_AGENT = new Set(["search_knowledge_base"]);

function jsonSchemaFor(schema: z.ZodType): { type: "object"; [key: string]: unknown } {
  const { $schema: _ignored, ...json } = z.toJSONSchema(schema, { io: "input" }) as Record<string, unknown>;
  return { ...json, type: "object" };
}

function buildServer(deps: ToolDeps, TOOLS: readonly ToolDefinition[]): Server {
  const server = new Server({ name: "relaypay-support", version: "0.1.0" }, { capabilities: { tools: {} } });

  server.setRequestHandler("tools/list", async () => ({
    tools: TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: jsonSchemaFor(t.inputSchema) })),
  }));

  server.setRequestHandler("tools/call", async (request) => {
    const tool = TOOLS.find((t) => t.name === request.params.name);
    if (!tool) {
      const outcome = {
        status: "invalid_input" as const,
        result: { error: { code: "unknown_tool", message: `No tool named ${request.params.name}.` } },
      };
      await logToolCall(deps.db, deps.ctx, {
        toolName: request.params.name,
        purpose: "unknown tool requested",
        input: request.params.arguments ?? {},
        resultSummary: "unknown_tool",
        status: outcome.status,
        durationMs: 0,
      });
      return toToolResult(outcome);
    }
    return tool.handler(request.params.arguments ?? {}, deps);
  });

  return server;
}

function main(): void {
  let env;
  try {
    env = loadServerEnv();
  } catch (err) {
    console.error(`[relaypay-mcp] ${err instanceof StartupError ? err.message : String(err)}`);
    process.exit(1);
  }
  const deps: ToolDeps = {
    db: createServiceClient({ SUPABASE_URL: env.supabaseUrl, SUPABASE_SERVICE_ROLE_KEY: env.supabaseKey }),
    ctx: env.context,
  };
  const tools = env.toolset === "agent" ? ALL_TOOLS.filter((t) => !NOT_FOR_AGENT.has(t.name)) : ALL_TOOLS;
  const handle = serveStdio(() => buildServer(deps, tools));
  const shutdown = () => void handle.close();
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  console.error(
    `[relaypay-mcp] serving ${tools.length} tool(s) (toolset ${env.toolset}) on stdio for conversation ${env.context.conversationId}, ` +
      `turn ${env.context.turnIndex}; ANTHROPIC_API_KEY in env: ${"ANTHROPIC_API_KEY" in process.env}`,
  );
}

main();
