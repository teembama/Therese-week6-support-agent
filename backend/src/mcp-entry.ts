// Which file the backend spawns as the MCP server (D41).
//
// The bundle (mcp-server/dist/bundle/server.mjs, built by `npm run build`) starts ~300 ms faster
// than dist/main.js, and the CLI only starts the MCP server after its own boot, so that time is
// on every tool-enabled turn's critical path. A bundle OLDER than any compiled file it was built
// from would run stale code, so it is used only when it is newer than every .js file under
// mcp-server/dist and shared/dist; otherwise main.js is used and the reason is logged.

import { existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

function newestJsMtime(dir: string, skip: string): number {
  let newest = 0;
  if (!existsSync(dir)) return newest;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (path !== skip) newest = Math.max(newest, newestJsMtime(path, skip));
    } else if (entry.name.endsWith(".js")) {
      newest = Math.max(newest, statSync(path).mtimeMs);
    }
  }
  return newest;
}

export interface McpEntry {
  path: string;
  kind: "override" | "bundle" | "main";
  reason?: string;
}

export function pickMcpEntry(env: NodeJS.ProcessEnv = process.env, repo: string = REPO): McpEntry {
  const override = env["RELAYPAY_MCP_ENTRY"];
  if (override) return { path: override, kind: "override" };
  const dist = join(repo, "mcp-server", "dist");
  const bundleDir = join(dist, "bundle");
  const bundle = join(bundleDir, "server.mjs");
  const main = join(dist, "main.js");
  if (!existsSync(bundle)) return { path: main, kind: "main", reason: "no bundle (run npm run build)" };
  const sources = Math.max(newestJsMtime(dist, bundleDir), newestJsMtime(join(repo, "shared", "dist"), ""));
  if (statSync(bundle).mtimeMs < sources) return { path: main, kind: "main", reason: "bundle is older than the compiled sources (run npm run build)" };
  return { path: bundle, kind: "bundle" };
}
