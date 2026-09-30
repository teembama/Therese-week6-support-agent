# RelayPay voice support backend (Batch 2D step 4, D53). One image: the HTTP backend, which
# spawns the Claude Code CLI (native binary from the Agent SDK's optional platform package) and
# the relaypay MCP server (esbuild bundle) per turn.

# ---- build: full install (incl. optional platform binaries and dev tools), compile, bundle, prune
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY backend/package.json backend/
COPY mcp-server/package.json mcp-server/
COPY db/package.json db/
COPY scripts/package.json scripts/
# --include=optional keeps @anthropic-ai/claude-agent-sdk-linux-x64 (the CLI binary) and @esbuild/linux-x64.
RUN npm ci --include=optional --no-audit --no-fund
COPY tsconfig*.json ./
COPY shared shared
COPY backend backend
COPY mcp-server mcp-server
COPY db db
COPY scripts scripts
RUN npm run build && npm prune --omit=dev --include=optional --no-audit --no-fund

# ---- runtime: non-root, only what runs
FROM node:22-bookworm-slim
# The CLI binary makes its own TLS connections; give it the system CA store.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates \
 && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production \
    HOME=/home/node \
    CLAUDE_CODE_DISABLE_TERMINAL_TITLE=1 \
    CLAUDE_CODE_DISABLE_AUTO_MEMORY=1
WORKDIR /app
COPY --from=build --chown=node:node /app/package.json /app/package-lock.json ./
COPY --from=build --chown=node:node /app/node_modules node_modules
COPY --from=build --chown=node:node /app/shared/package.json shared/package.json
COPY --from=build --chown=node:node /app/shared/dist shared/dist
COPY --from=build --chown=node:node /app/backend/package.json backend/package.json
COPY --from=build --chown=node:node /app/backend/dist backend/dist
COPY --from=build --chown=node:node /app/backend/public backend/public
COPY --from=build --chown=node:node /app/mcp-server/package.json mcp-server/package.json
COPY --from=build --chown=node:node /app/mcp-server/dist mcp-server/dist
USER node
# Railway sets PORT; 8787 is the local default.
EXPOSE 8787
CMD ["node", "backend/dist/start.js"]
