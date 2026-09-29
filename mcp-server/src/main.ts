// Spawn entry point for the MCP server (docs/decisions.md D13, scrub-on-start).
//
// The Claude Code CLI merges its whole environment, ANTHROPIC_API_KEY included, into every
// MCP server it spawns, so the key cannot be kept out at spawn time. This file removes it
// before any other module is evaluated. It must have NO static imports: ESM hoists static
// imports and evaluates them before this module's first statement, so the server code is
// loaded only through the dynamic import below, after the delete.

if (process.env["ANTHROPIC_API_KEY"] !== undefined) {
  delete process.env["ANTHROPIC_API_KEY"];
  process.stderr.write(
    "[relaypay-mcp] warning: ANTHROPIC_API_KEY was present in the environment (inherited from the spawning process) and was removed before startup.\n",
  );
}

await import("./index.js");
