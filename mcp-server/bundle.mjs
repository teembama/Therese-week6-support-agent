// Bundles the compiled MCP server (dist/main.js and everything it imports) into one file,
// dist/bundle/server.mjs. The backend spawns this per turn: one file loads ~300 ms faster than
// resolving hundreds of modules (D41, measured). The dynamic import in main.ts stays lazy in the
// bundle, so the ANTHROPIC_API_KEY scrub still runs before any server code (D13; checked by
// scripts/test-mcp.ts against the bundle).

import { build } from "esbuild";

await build({
  entryPoints: ["dist/main.js"],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  outfile: "dist/bundle/server.mjs",
  // Some dependencies still call require(); give the ESM bundle one.
  banner: { js: "import { createRequire as __relaypayCreateRequire } from 'node:module'; const require = __relaypayCreateRequire(import.meta.url);" },
  logLevel: "warning",
});
