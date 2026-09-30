# Decision Log

Decisions and findings that the assets do not settle on their own. Where a decision is ours rather than the source documents', it says so.

## Architecture (locked)

- Vapi does speech only, in Custom LLM mode, and sends each turn to our backend at `POST {base}/chat/completions`.
- The backend runs the Claude Agent SDK, the only reasoning layer.
- All tools come from our custom MCP server (stdio).
- Supabase stores seed data and every runtime record.

## Decisions

### D1. Ticket and escalation enums (our extension; the spec doesn't define these)

- Ticket `category`: `payment`, `payout`, `invoice`, `account`, `compliance`, `dispute`, `other`.
- Ticket `priority`: `low`, `normal`, `high`. It is **computed in code and never chosen by the model**:
  - `high` if the linked transaction or payout is `failed` or `review required`, or if the ticket was created for an escalation;
  - `normal` otherwise.
- Ticket `status`: `open`, `in progress`, `closed`. These are exact strings; `in progress` has a space.
- Escalation `status` uses the same three values.
- Escalation `category` comes from `assets/escalation-rules.md`: `compliance`, `account`, `dispute`, `payment`, `other`.

### D2. Fee answers follow the knowledge base, not test scenario 1

The KB text, verbatim (FAQ, "How Does RelayPay Charge Fees?"):

> Fees vary based on transaction type, corridor, and payment method. RelayPay displays applicable fees before a transaction is confirmed.

- The agent may say fees depend on transaction type, corridor and payment method, and that fees are shown before confirmation.
- It must not add currency, recipient country or account setup; those come from scenario 1's wording only. It must not quote an exact fee.

### D3. Conversation history is stateless first

- Each turn is a new `query()`. History is rebuilt from the `messages[]` that Vapi sends.
- Vapi's system message is dropped, because the backend owns the prompt.
- A long-lived session (streaming-input `query()` per call) is adopted only if Task 4's latency measurements require it.

### D4. One canonical endpoint

- Only `POST /chat/completions` exists. There is no compatibility route.
- Vapi's `model.url` is set to the **base URL**, because Vapi appends the path. Any other path returns 404 and is logged.
- The first live Vapi request verifies the path. See documentation discrepancy X1.

### D5. Security: the agent gets only the allowlisted MCP tools (hard requirement, built in Task 4)

Agent SDK options:

- `tools: []` removes all built-in tools. `allowedTools` alone does **not** remove them; it only pre-approves.
- `allowedTools` lists the 7 RelayPay MCP tools by exact name, with no wildcard.
- `permissionMode: "dontAsk"`.
- `settingSources: []`.
- `systemPrompt` is a plain string, not the `claude_code` preset.

Startup check: read the tool list the SDK reports (the `system/init` message). If any tool other than our 7 is present, or an expected tool is missing, fail the turn and log the error.

### D6. Cost and usage are recorded from day one

- Per-turn usage fields (model, tokens, cache tokens, SDK duration, SDK turn count) are stored in `conversation_turns`. Totals are stored in `conversations`.
- The SDK's `total_cost_usd` is a **client-side estimate, not billing**. Columns and reports label it as such.

### D7. Vapi authentication

- `VAPI_LLM_SECRET` is the `apiKey` of a Vapi Custom LLM credential (`provider: "custom-llm"`). Vapi sends it in the `Authorization` header, and the backend checks `Authorization: Bearer <secret>`.
- `model.headers` cannot override `Authorization`, per Vapi's OpenAPI `CustomLLMModel.headers`.

### D8. Vapi must never execute tools

- Tools are not configured in the Vapi assistant's `model.tools` or `toolIds`.
- The backend never streams `tool_calls` or `function_call` chunks. Any `payload.tools` field Vapi sends is ignored.
- `metadataSendMode` stays at its default (`variable`), so `body.call.id` is present. `off` would drop the call ID.

### D9. Logging context comes from the backend, never from the model

- The `conversation_id` and `turn_index` that MCP tools use for logging come from the backend.
- The backend passes them as environment variables to the stdio MCP server it spawns for each turn.
- Any `conversation_id` or `turn_index` the model supplies in tool input is ignored.

### D10. Migrations are append-only

Once `001_schema.sql` is applied, all schema changes go in new numbered files (`002_…`, `003_…`). Never edit a migration that has been applied.

### D11. Escalations are created atomically through one database function

- The Supabase JS client can't run multi-statement transactions. So `create_escalation_with_ticket(...)`, a `SECURITY INVOKER` plpgsql function with `search_path = public`, inserts the ticket and the escalation in one transaction.
- It is idempotent on either idempotency key. It returns `ticket_id`, `escalation_id` and `created`.
- A failed escalation insert rolls back its ticket, so no orphan ticket is left.
- `EXECUTE` is revoked from `public`, `anon` and `authenticated`, and granted only to `service_role`. The MCP server calls it via `rpc`.
- **Key conflict is a hard error.** If the ticket key belongs to a ticket with no escalation, the function raises `P0001` with the message prefix `ESCALATION_KEY_CONFLICT:` and writes nothing.
  - This case can only come from a bug, so the code is deliberately distinct from `unique_violation`.
  - The MCP tool treats it as a hard error: it logs a `tool_calls` row with `status = 'error'` and never reports it as a duplicate or success.
  - A genuine duplicate is not an error. It returns the existing IDs with `created = false`.

### D12. One pinned Node 22 runtime everywhere (apply in Tasks 3 and 4)

- The repo requires Node 22: `engines.node` is `>=22`, and `.nvmrc` contains `22`.
  - Node 20 reached end-of-life in April 2026.
  - supabase-js 2.109 refuses to start on Node 20 because it lacks native WebSocket support.
- **The backend spawns the stdio MCP server with `process.execPath`, never `"node"` from PATH.** This keeps the backend and the MCP server on the same Node binary.
  - This machine has three Node installs, so the PATH lookup is ambiguous: nvm 22.23.3, nvm 20.19.0, and a standalone 24.15.0 in `C:\Program Files\nodejs`.
- The deployment host must also run Node 22.

### D13. The MCP server uses the SDK's low-level `Server`, not `McpServer.registerTool`

- MCP TypeScript SDK v2 (`@modelcontextprotocol/server` 2.2.0) validates `registerTool` input before the handler runs. An invalid call would therefore never reach `withToolLogging`, and no `tool_calls` row would be written.
- The low-level `Server` sends every `tools/call`, valid or not, through `withToolLogging`. It publishes each tool's JSON Schema generated from its strict Zod schema (`z.toJSONSchema`), so the model still sees the exact constraints.
- The low-level `Server` turns anything a handler throws into a protocol error. So the wrapper catches everything and returns a structured `error` result instead.
- Result mapping:
  - `isError: true` for `invalid_input` and `error`, which the model should treat as a failed call;
  - `isError: false` for `success`, `not_found` and `denied`, which are deliberate outcomes the model reads and follows.
- The server also refuses to start if `ANTHROPIC_API_KEY` is present in its environment.
- **Planned fallback, decided but not built.** If Task 4 shows the Agent SDK/CLI passes its full environment to MCP servers, the protection stays and changes to scrub-on-start:
  - The server deletes `ANTHROPIC_API_KEY` from `process.env` before any other module can read it, and logs a warning to stderr without the value.
  - ESM static imports are hoisted and run before a module's first line. So this needs a tiny separate entry file that does the `delete` and only then dynamically imports the server (`await import("./index.js")`).
- **Protocol compatibility check.** The first check in Task 4 is a bare Agent SDK → MCP handshake that must list `search_knowledge_base`. SDK v2 implements the 2026-07-28 spec. If the Agent SDK can't connect, the fallback is to pin the stable v1 `@modelcontextprotocol/sdk`.

### D14. Shared code lives in the `@relaypay/shared` workspace, built with project references

- `shared/` holds the Supabase client factory (which refuses publishable/anon keys), the retrieval function, the log writers and the redaction.
- The backend, the MCP server, `db` and `scripts` depend on it. `tsc -b` builds it first; the root `build`/`typecheck` scripts and every `db:*` script run `tsc -b`.
- **Known, accepted duplication.** `db/seed.ts` and `scripts/verify-seed.ts` predate `shared/` and build their own Supabase client and CSV parsing. They are one-off tooling, not runtime code, so this is left as is by decision. Runtime code (backend, MCP server) must use `@relaypay/shared`.

### D15. Retrieval: OR query of informative lexemes, ranked by `ts_rank_cd`

- `search_kb` (migration 002) normalizes the query with the index's `english` config, which drops stopwords and stems words.
- It removes `KB_EXCLUDED_WORDS`, ORs the remaining lexemes, and ranks with `ts_rank_cd(..., KB_RANK_NORMALIZATION = 32)`. That normalization gives ranks between 0 and 1.
- It returns at most `KB_MATCH_COUNT` chunks with rank `>= KB_MIN_RANK`. If none qualifies, `insufficient_knowledge = true`.
- The constants live in `shared/src/config.ts`. Normalization, threshold and exclusions are parameters of `search_kb`, so tuning them needs no new migration.
- **Tuned 2026-09-29, evidence in `docs/retrieval-eval.md`:**
  - normalization changed from 32 to **34** (2|32);
  - `KB_MATCH_COUNT` changed from 4 to **6**;
  - `KB_MIN_RANK` = **0.04**. It was 0.05 first; it was lowered for margin, recall-first, and the lowest correct chunk (S2, .0526) now has .0126 headroom.
- `KB_QUERY_SYNONYMS` is applied in app code before `search_kb`, with no migration and no prefix matching.
  - It appends a synonym when a key appears as a whole word.
  - Each entry must name the failing eval case that justified it. Speculative entries are not allowed.
  - Current entry: `crypto → cryptocurrency`, justified by case X1.

### D16. Retrieval optimises for recall; the agent and the grounding gate handle precision

- **The rank threshold is a noise floor only, not a detector for unsupported questions.** The evaluation showed no rank gap between correct chunks and chunks that merely share a word ("support").
- `insufficient_knowledge` means exactly one thing: zero chunks above the floor.
- Deciding that retrieved chunks don't actually answer the question is the agent's job. The agent then answers with `type = decline`.
- **Known limit:** the grounding gate verifies that an answer cites retrieved chunks, not that those chunks are relevant to the question. The Task 6 evals check relevance.

### D17. Known limitation: X1 ("do you support crypto wallets") doesn't retrieve its answer chunk

- **Evidence (`docs/retrieval-eval.md`, Runs 2–4):**
  - The answer is in "Product Features Overview > Feature Availability And Limitations": "RelayPay does not support: Cryptocurrency payments".
  - With the `crypto → cryptocurrency` synonym, that chunk now matches. Its rank doubles from .0104 to .0206, and it moves from #11 to **#8**.
  - It is still outside `KB_MATCH_COUNT = 6` and below the 0.04 floor. The query word "support" pulls in six short FAQ chunks with "Support" in their heading, which outrank the long limitations list.
- **Decision:** leave it to the agent. X1 gets support-contact chunks with `insufficient_knowledge = false`. None of them answers the question, so the agent must decline (`type = decline`). There is no retuning; excluding "support" would break "How do I contact support".
- **Fix, with more time:** when a synonym fires, run a supplementary `search_kb` on the synonym alone ("cryptocurrency" matches only the right chunk, at #1). Merge its top results into the main result set before the floor and match-count cut.

### D18. Agent SDK → MCP handshake findings (Task 4 step 1, 2026-09-29)

Environment: Agent SDK 0.3.284, Claude Code CLI 2.1.284, model `claude-haiku-4-5`, MCP server `@modelcontextprotocol/server` 2.2.0. Script: `backend/src/dev/handshake.ts`.

- **The CLI merges its whole environment into every MCP server it spawns.**
  - This includes `ANTHROPIC_API_KEY`, `CLAUDE_CODE_MESSAGING_TOKEN` and `CLAUDE_CODE_SESSION_ID`. The server's own `env` entries are added on top.
  - Our refusal fired, the server exited 1, `init` reported `relaypay: failed` with 0 tools, and the model **made up an answer** ("a 2% fee").
  - The planned fallback (D13) is now in place. `mcp-server/src/main.ts` is the spawn entry: it has no static imports, deletes the key, warns on stderr, then dynamically imports the server.
  - Verified inside the server process: the key is present on spawn and `ANTHROPIC_API_KEY in env: false` after the scrub.
  - `index.ts` still refuses if the key is somehow present, as defence in depth.
- **Protocol:** the CLI's MCP client sends `protocolVersion: "2025-11-25"`, and the v2 server negotiates it. The v1 fallback isn't needed.
- **Tool list:** with `tools: []`, `strictMcpConfig: true`, `settingSources: []` and `alwaysLoad: true`, `init.tools` is exactly `["mcp__relaypay__search_knowledge_base"]`.
  - `init` still lists bundled skills, agents and slash commands as metadata. Built-in tools are off, so the Skill and Task tools don't exist and none of these can be invoked.
  - `alwaysLoad` blocks startup until the server connects (up to 5s) and stops tool-search deferral.
- **`persistSession: false`:** no transcripts are written to `~/.claude/projects`. This matches D3 (stateless) and keeps caller speech off disk.
- **`maxTurns` behaviour:**
  - The limit is checked **after** tools run. With `maxTurns: 1`, the tool call still executed.
  - The result was `subtype: "error_max_turns"`, `is_error: true`, `num_turns: 2`, `stop_reason: "tool_use"`, with `errors: ["Reached maximum number of turns (1)"]`.
  - **The iterator then throws** after yielding the result. Callers must catch it.
  - Consequence for later tools: a side-effect tool can run even when the turn ends before the agent can confirm it to the caller.
- **Cost:** `total_cost_usd` for the fees query was $0.0053 (estimate). `modelUsage` has two entries every time:
  - the main `claude-haiku-4-5` loop;
  - an auxiliary `claude-haiku-4-5-20251001` call of about 918 input and 15 output tokens, ≈ $0.001, present even when no tool is used.
  - `usage` covers only the main loop, so persistence should take tokens from `modelUsage`.
- **Timings, warm, from the `query()` call:**

  | Event | ms |
  | --- | --- |
  | `init` | 1595 (2770 on the very first run) |
  | First `tool_use` | 2882 |
  | Tool result | 4054 (MCP tool itself: 644) |
  | First text | 5695 |
  | Result | 6057 |

  - The CLI's own `duration_ms` was 4513, so about 1.5s of each turn is CLI + MCP startup before the model is called.

### D19. `/chat/completions` endpoint and grounding gate (Task 4 steps 2–5)

- **HTTP:**
  - Only `POST /chat/completions` exists; anything else returns 404, logged with method and path only.
  - Auth is `Authorization: Bearer <VAPI_LLM_SECRET>`, compared in constant time over SHA-256 digests. The header is never logged.
  - A missing `call.id` returns 400. `turn_index` is the number of user messages minus 1.
  - Conversations are upserted with channel `test` for `test-` IDs and `voice` otherwise.
- **Idempotency:**
  - The in-flight slot is claimed **synchronously** after parsing, before any `await`, so concurrent duplicates can't both start a run.
  - A request for a turn already in flight joins it and streams the same text.
  - The slot is released as soon as the turn row is written; after that, requests replay the stored `assistant_response`.
  - **Single-instance limitation:** the in-flight map is per process. On multiple instances, simultaneous duplicates could each run the agent; the unique `(conversation_id, turn_index)` constraint keeps the first row, and the other run's row insert is skipped and logged.
  - Replaying a turn that was aborted before any speech (`assistant_response` NULL) speaks the fallback line.
- **Prompt:**
  - Caller history and the current message are XML-escaped. The current message sits in `<caller_message untrusted="true">`.
  - Chunks are passed as `<chunk id="...">`, and Vapi's system message is dropped.
  - The prompt never starts with `/`, so caller speech can't trigger a CLI slash command.
- **Gate:**
  - The reply must *start* with `[[type=answer|clarify|decline; kb=<ids|none>]]`, complete within 200 characters.
  - `type=answer` needs at least one cited ID in the turn's retrieved set, read from `retrieval_logs`. Unknown extra IDs are noted.
  - A failing reply speaks the safe decline line and is recorded as `answer_type = blocked` with the reason and the raw reply.
- **Multi-step turns:**
  - Each assistant API message is a segment. It can be spoken only after it **ends** with a terminal stop reason and contains **no** `tool_use` block.
  - Any segment with a tool call is thinking aloud and is discarded, even if it has a header. It is noted in `confidence_note`.
  - **Cost:** nothing streams while the final reply is being generated; it is released whole, split into sentences, at its `message_stop` (about 0.9s for a 2–3 sentence reply).
- **Agent:** `thinking: { type: "disabled" }` for voice latency (reversible), `maxTurns: 4`, `maxBudgetUsd: 0.05`.
- **Timeouts and cancellation:**
  - 8s without speech: the fallback line, `answer_type = error`, and the query is aborted.
  - 20s hard cap: the query is aborted.
  - Client disconnect before speech: the query is aborted and logged as `aborted: client disconnected`.
  - The tool-list guard compares `init.tools` and the MCP status against the allowlist on every query.
  - Test knobs, for tests only: `RELAYPAY_FIRST_TOKEN_TIMEOUT_MS`, `RELAYPAY_TURN_HARD_CAP_MS`, `RELAYPAY_MCP_ENTRY`. None of them can widen the allowlist or bypass the gate.
- **Persistence:**
  - Tokens are summed from `modelUsage`, which includes the auxiliary call (D18). Cost is `total_cost_usd` (estimate).
  - `ms_first_token` is receipt → first spoken text. `ms_total` is receipt → end of the SSE stream.
  - `ms_tools` is the sum of tool_use → tool_result intervals.
  - Conversation totals are recomputed from all turns after each turn.
- **Open item:** `VAPI_LLM_SECRET` is empty in `.env`. The endpoint tests use a random per-run secret. A real value must be set in `.env` and in Vapi's Custom LLM credential before connecting Vapi.

### D20. Retrieval moved from model discretion to a guaranteed pre-turn step (latency lever 1)

- **Before:** the model decided whether to call `search_knowledge_base`. It re-searched in 6 of 10 fees runs even though the pre-turn chunks already answered the question, which added about 2.3s and 75% more cost on those turns (`docs/latency.md`).
- **Now:**
  - The agent's MCP allowlist (`AGENT_MCP_TOOLS`) is empty, and `search_knowledge_base` is in `FORBIDDEN_AGENT_TOOLS`. The tool-list guard fails the turn if it is ever present; this is tested by force-attaching the MCP server.
  - While the allowlist is empty, the MCP server isn't attached to the agent at all, which also removes MCP start from every turn. The server keeps the tool for Inspector and manual testing.
  - Retrieval is backend-owned and runs before every turn. It is still logged to `retrieval_logs`.
  - The gate's retrieved set is the in-memory pre-turn result. The gate's database round trip is gone.
- **Follow-ups:** a latest caller message with fewer than 5 meaningful words is searched together with the previous caller message. The query actually used is what `retrieval_logs.query` records.
- **Measured (Task 4 lever-1 run, marks from the server turn log):**
  - `query()` → `init` fell from about 2.36s to about 0.54s.
  - `query()` → release fell from 4.28s (6s with a tool call) to a median of 2.95s.
  - Pre-agent database work (0.6–3.5s, outliers 11–14s) is now the largest and most variable phase.
- **For Task 5:** new side-effect tools must go on the agent allowlist while `search_knowledge_base` stays excluded. Options: filter the tools on the server via env, or use the SDK's `disallowedTools`. The guard keeps asserting that search is absent.

### D20b. Overlap CLI startup with the turn's DB work (latency lever 3)

- **Evidence first** (`backend/src/dev/trace-streaming.ts`, warm runs, ms from request):
  - In streaming-input mode the CLI is spawned at about 1ms and writes its first output at about 490ms, **before** the user message is yielded (620–850ms) and while the DB work runs.
  - `init` is only emitted after the message arrives. But yield → first model event is 1.1–1.2s, against 1.8–1.9s from `query()` to first model event in sequential mode, so about 0.7s of startup is hidden.
  - An event-loop heartbeat showed stalls of 20ms at most, so `query()` doesn't block the loop.
  - There is no MCP startup to overlap: the MCP server is no longer attached (D20).
- **Lifecycle:**
  1. Timers start at request receipt.
  2. `query()` starts immediately with an async-generator prompt.
  3. Conversation upsert, existing-turn check and pre-turn ranking run in parallel.
  4. For an existing turn row, the generator ends without yielding, the query is aborted, and the stored reply is replayed.
  5. Otherwise the `retrieval_logs` write runs concurrently, and the prompt is yielded.
- **Bug fixed along the way:** before, the upsert and turn check ran *before* the turn's timers started. A Supabase stall of 5–12s therefore meant 12s of silence despite the 8s rule. Now the first-token timeout covers all DB work.
- **Measured (10 fees runs):** p50 `ms_first_token` fell from 5792 to **2453ms**. p95 is 8001ms, caused by one 10.4s Supabase stall that correctly hit the 8s fallback.

### D23. Streaming gate: sentences are released once a valid header is parsed (latency lever 4)

**Verified event sequence** (`backend/src/dev/trace-events.ts`):

- **(a) The header can be validated before any output.**
  - It arrives in the first few text deltas. In the trace it was complete at 2748ms, while the message ended at 2997ms.
  - The gate holds everything until `]]` and checks `type` and `kb` against the **in-memory** retrieved set. Only then does it release text.
- **(b) `tool_use` can follow text in the same message**, but only when the agent has a tool.
  - Trace case B showed a text block, then a `tool_use` block (index 1), in one message.
  - With the current config the agent has no tools (D20), so this cannot happen in production today.
- **(c) Events arrive strictly in order.** All text deltas and the text block's stop come before `content_block_start(tool_use)`. The backend stops output from that message at that event; text already sent can't be retracted.
- **(d) The header is never sent.** It is parsed out of the buffer, and only the text after it is streamed.

**Rules as implemented** (`StreamingGate`, with fixtures in `gate.test.ts`):

- No customer-facing text before a valid header at the very start of the message, complete within 200 chars.
- Text in a message without a valid header is never spoken. If that message ends the turn, the turn is blocked and the caller hears the safe decline line.
- Output is released as whole sentences, stripped of markdown. Stripping works correctly across delta boundaries.
- If a `tool_use` starts after a sentence was already spoken, further output from that message stops. The turn records a `gate_violation`, in `confidence_note` and as a log event, with exactly what had been sent.
- A headerless pre-tool message ("thinking aloud") is discarded silently.

**Measured:** the first sentence is spoken 0.2–0.5s (median ~0.33s) before the model finishes the reply.

### D24. Long-lived session deferred; deploy first, then decide

- **Hypothesis to test:** most of the p95 comes from the measurement environment:
  - a laptop in Lagos on home internet, far from Supabase's region and the Anthropic API;
  - fresh TLS connections on every turn, because the CLI (and, with tools, the MCP server) is spawned per turn.
- **Test:** deploy the backend near the Supabase region and measure the same 10-run fees benchmark server-side, before any redesign.
- **If a long-lived session is still needed afterwards:** the MCP server's turn context (`conversation_id`, `turn_index`) will come from a **backend-owned database row** that the server reads on each tool call. That keeps stdio and adds no new network surface. It will **not** come from an HTTP MCP server, and never from the model.

### D25. The CLI's background session-title model call is disabled

- **The setting is documented:** `CLAUDE_CODE_DISABLE_TERMINAL_TITLE=1`. Per https://code.claude.com/docs/en/env-vars, it "also skips the background small/fast-model request that generates a session title".
  - The costs page (https://code.claude.com/docs/en/costs, "Background token usage") lists the other background calls: `--resume` summarization, `/usage` status checks and prompt suggestions. None of them apply to our headless, non-resumed, one-shot sessions.
- **Verified:** with the variable set, the auxiliary `claude-haiku-4-5-20251001` entry (918 input, 15 output tokens, $0.000993) disappears from `modelUsage`, and the turn still succeeds.
- **A/B:** two servers took alternating requests, 10 each.
  - Default: p50 / p95 `ms_first_token` 2855 / 6651ms, $0.0032 per turn.
  - Disabled: **1960** / 7352ms, **$0.0016** per turn.
  - The p95 in both variants is one or two network outliers.
- **Result:** it is adopted permanently in `cliEnv()`. The full endpoint suite passes with it: all checks, and 10 fees runs at p50 2171 / p95 7160ms with 0 errors.
- **Not adopted:** `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`, the documented switch for telemetry, auto-update, error reporting and feature-flag fetching, is a separate decision. It wasn't asked for, and it disables feature-flag-dependent features.

### D26. Endpoint auth: secret token in the path (replaces the Bearer check from D7/D19)

- **Why:** in our shared Vapi account, the Custom LLM credential is **org-wide** (one unnamed slot), and the dashboard offers **no custom headers** for the assistant. Neither an `Authorization: Bearer` value nor a custom header could be scoped to this assistant.
- **Design:**
  - The only route is `POST /v/:token/chat/completions`. The Vapi base URL is `https://<host>/v/<token>`, and Vapi appends `/chat/completions`.
  - `:token` is URL-decoded and compared against `VAPI_LLM_SECRET` in constant time (SHA-256 digests, then `timingSafeEqual`).
  - A wrong, empty or missing token returns **404, not 401**, identical to any unknown path, so the route's existence isn't confirmed. Other methods and suffixes also return 404.
  - The server refuses to start unless `VAPI_LLM_SECRET` is at least 32 URL-safe characters (`[A-Za-z0-9._~-]`).
  - The Bearer check is removed.
- **Never logged:**
  - Every logged path goes through `redactPath()`. The segment after `/v/` becomes `[redacted]`, and any literal or percent-encoded occurrence of the secret anywhere in the path is replaced.
  - This covers 404 logging for unknown paths.
  - The endpoint suite scans every line of every test server's output for both the real and a wrong token, and requires zero.
- **Trade-off:** secrets in URLs are more likely to reach logs (proxy/CDN access logs, tunnel logs, error trackers, browser history) than header secrets.
  - **Mitigations:** redaction in our logs; the token is never written to files; a 404 for any wrong token.
  - **Residual risk:** infrastructure we don't control, such as Vapi's own logs or a tunnel or host access log, may record the full URL.
- **Rotation:** the token is rotated after the demo, by generating a new `VAPI_LLM_SECRET` and updating the Vapi base URL.

### D27. Vapi assistant settings (confirmed by the user in the dashboard, 2026-09-29)

- **Metadata Send Mode: Variable**, so `call.id` should be in the request body. The live-test debug log verifies the body's structure.
- **Custom LLM URL is labelled "base URL"**, so Vapi appends `/chat/completions` (consistent with D4 and D26).
- Request timeout is 20s, which matches our 20s hard cap (D19).
- Max tokens is 250, which our backend ignores; reply length is bounded by the prompt ("1 to 3 short spoken sentences").
- No Vapi tools and no Vapi knowledge base (D8).

### D28. Vapi sends speculative requests: turns are keyed on the transcript, and every attempt is recorded (migration 003)

**Evidence from live call `01a0eece-4b0b-7aaf-ba5b-f7affa9d639a` (2026-09-29).** Both caller turns spoke our fallback line, about 1.5–2s after the caller stopped speaking.

- **Turn 0:**
  - The first request carried a *partial* transcript ("We've come down the shuttle to."). Vapi closed the connection at 3107ms, before we spoke.
  - Two more requests for the same turn followed, at +3.9s and +4.3s. They joined the in-flight attempt, whose outcome was "nothing spoken", and so spoke the fallback.
- **Turn 1:**
  - The first request carried "What fees does." and was closed at 1568ms.
  - The next request found the stored turn row (`assistant_response` NULL) and replayed the fallback.
- **Request shape:**
  - `metadata.numModelRequestInTurn` exists, and the `x-stainless-*` headers show Vapi calls us through the OpenAI SDK, which also retries.
  - `call.id` is at `body.call.id`. Vapi also sends the full `call` and `assistant` objects plus `metadata`.
- **No Supabase or agent failure:** the call's log has zero Supabase fetch failures.

**Cause.** Vapi starts model requests on partial transcripts and cancels them when the caller keeps talking. Our idempotency key `(call.id, turn_index)` treated the fuller replacement request as a retry of the cancelled one, and reused its empty outcome.

**Decision:**

- **Key:** turns are keyed on `(call.id, turn_index, hash of the latest caller message)`.
  - **Same transcript** is a genuine retry: join the in-flight attempt, or replay the stored turn **only if it spoke something**.
  - **Different transcript** is a replacement: the in-flight attempt is aborted and marked `replaced`, a fresh attempt runs, and the old outcome is never reused.
- **Attempts:** every request that runs the agent is a row in `turn_attempts`, with status `active | completed | replaced | aborted | failed` and its own cost, tokens and latency.
  - The turn row is written only by a `completed` attempt, meaning one that spoke. If a later attempt with a different transcript completes, its answer becomes the turn, and the earlier attempt becomes `replaced`.
  - `retrieval_logs` and `tool_calls` carry `attempt_id`.
- **Totals:** `SUM(conversation_turns) + SUM(turn_attempts WHERE status <> 'completed')`. The replaced and aborted spend is counted, and nothing is counted twice.
- **Supersession guard (write tools):**
  - The MCP server receives `ATTEMPT_ID` at spawn, like `CONVERSATION_ID`.
  - Every write tool's write runs in a Postgres function that calls `require_active_attempt()` and then writes, in **one** transaction (D29). If the attempt is no longer `active`, the tool returns `denied` and writes nothing.
  - An earlier draft checked first and wrote in a separate call. It was replaced because it left a race window.
  - **Why:** Vapi fires speculative requests on partial transcripts, and abort isn't immediate (below). Without the guard, a replaced attempt could still create a wrong ticket or escalation from a half-heard sentence.
- **Abort is not immediate.**
  - On turn 0 the SDK's result arrived 4.8s after our abort (model cost $0.000967). The SDK's `signal` aborts the CLI only after stdin EOF plus about a 2s grace period (documented on `spawnClaudeCodeProcess`).
  - So the backend now spawns the CLI itself and, on abort, **terminates the whole process tree**, including the MCP server.
- **Considered and deferred: SSE keep-alive comments before the first sentence.** The evidence points to Vapi cancelling because the transcript changed, not because our connection was silent. Revisit if a cancellation occurs while the transcript is unchanged, which the extended debug log (role sequence, `numModelRequestInTurn`, transcript hash) will reveal.
- **Local network note:** the phone-hotspot resolver (`172.20.10.1`) intermittently returns SERVFAIL for the Supabase project hostname (`EAI_AGAIN`), while Cloudflare DNS-over-HTTPS resolves it. This explains the earlier intermittent "fetch failed" errors. The mitigation is one retry on pre-connect errors (fix 6), and deploying removes the cause.

### D29. The supersession check and the write happen in ONE database transaction (firm rule for Phase 2)

- **Rule:** a separate "is the attempt active?" call followed by a separate write leaves a race window, because the attempt can be replaced between the two.
  - So every **guarded write** goes through a Postgres function that first calls `require_active_attempt(p_attempt_id)`, which takes `FOR SHARE` on the attempt row, and then performs the write in the same transaction.
  - A concurrent replacement (`begin_turn_attempt`'s `UPDATE … SET status = 'replaced'`) waits for that lock, so the write and the replacement are strictly ordered.
- **In code:**
  - Write tools use `withWriteToolLogging`, which does **no** pre-check. It passes `ctx.attemptId` to the tool.
  - The tool calls its write RPC through `guardedRpc(db, fn, params, attemptId)`, which adds `p_attempt_id`.
  - `P0001 ATTEMPT_NOT_ACTIVE: …` from the database becomes tool status `denied`, and nothing is written.
  - The TypeScript `attemptIsActive()` pre-check was removed, so check-then-write can't be reintroduced. The SQL `attempt_is_active()` stays for diagnostics only; it is never a guard.
- **Phase 2:**
  - A new migration adds a `create_escalation_with_ticket` that takes `p_attempt_id` and calls `require_active_attempt` first.
  - The **old signature is dropped**, or at least `EXECUTE` is revoked from `service_role`, so it can't be used to bypass the guard.
  - Every other write tool (tickets and later ones) follows the same pattern.
- **Not guarded:** log writes to `tool_calls` and `retrieval_logs`. They record what happened, including denied calls.
- **Single-instance assumption, confirmed in code (`server.ts`):**
  - Two **identical** requests arriving at the same moment are joined in-process **before** `begin_turn_attempt` is called.
  - After parsing, the in-flight check and `inflight.set()` run synchronously, with no `await`. The second request finds the first's entry with the same hash and joins it, so only one attempt is ever registered.
  - Without this, `begin_turn_attempt` step 3 would mark the first request's active attempt `replaced` even though its transcript is identical.
  - **This holds only while one backend instance serves a call.** Across instances, identical concurrent retries could each register an attempt, the later replacing the earlier. Vapi calls must be routed to a single instance, or the in-flight map moved to shared state, before scaling out.

### D30. Observed failure pattern: claims not directly supported by the evidence (same as the Week 5 instructor feedback)

Live call `01a0ef14-d79b-7000-9a36-90b444cbecd9` (2026-09-29). Both answers passed the grounding gate: each cited a retrieved chunk. The gate checks citation, not support (D16's known limit). Both nonetheless contained claims the cited chunk doesn't support.

- **Turn 1 (Kenya).** The cited chunk says: "Local payouts typically take 1 to 2 business days. International payouts usually take 2 to 5 business days, depending on destination and banking partners."
  - *Unsupported specific:* "Kenya would fall within that range". The chunk names no country, and nothing says Kenya is a supported corridor or covered by that range.
  - *Invented attribution:* "depends on your specific banking partners there". The chunk says RelayPay's "banking partners" in general, not the caller's, and not partners "there".
  - *Implied certainty:* "the exact time" implies there is a knowable exact time.
- **Turn 0 (fees).** The cited chunk says: "Fees vary based on transaction type, corridor, and payment method. RelayPay displays applicable fees before a transaction is confirmed."
  - *Strengthened wording:* "the exact applicable fees" (the chunk says "applicable fees").
  - *Unsupported inference:* "so you'll know the cost up front". This goes beyond the chunk and conflicts with another KB statement: exchange rates "are not locked until processing".
- **Pattern:** a general policy was applied to a specific case, and the source wording was strengthened. This is the same failure the Week 5 instructor feedback named: claims not directly supported by evidence.
- **Proposed** (pending approval):
  - prompt rules against specifics, attributions and intensifiers absent from the chunk;
  - a Task 6 eval check with a deterministic lexical pass plus an LLM claim-support judge that must quote a supporting span.

**Also from this call:**

- Turn 2 ("All right. Thank you.") was **blocked by the gate, not declined by the model**. The model wrote `[[type=answer; kb=none]] You're welcome! …`, and `type=answer` requires a cited chunk.
  - **Proposed:** a `social` reply type in which the model only picks an intent and the backend speaks a fixed line.
- The extended debug log confirmed:
  - Vapi's first message is sent as an `assistant` message (roles `[system, assistant, user]`).
  - `x-stainless-timeout` is 600000 and every request had retry-count 0, while the transcript grew between requests. So the cancellations are speculative-request replacements, not timeouts, which supports D28's keep-alive deferral.

### D31. `social` reply type: the model picks the intent, the backend speaks a fixed line

- **Why:** in live call `01a0ef14…`, "All right. Thank you." was blocked, because the model labelled a pleasantry `type=answer; kb=none` (D30).
- **Header:** `[[type=social; intent=thanks|goodbye|greeting]]`, with no `kb` field. Any other form, unknown intent or extra field is a malformed header and is blocked.
- **The backend speaks a fixed line** from `SOCIAL_LINES` in `backend/src/config.ts`.
  - It is spoken as soon as the header is parsed.
  - Every model word after the header is discarded, never spoken or stored. So no free text is ever spoken ungrounded.
- **Rule (prompt):** use `social` only when the caller's **whole** message is thanks, a goodbye or a greeting. "Thanks, and what about fees?" is a question.
- **Storage:** stored as `answer_type = 'social'`, which migration 004 adds to the CHECK constraint. It is only this change; Phase 2 gets its own migration.

### D32. Grounding evaluation: deterministic checks flag, an LLM judge decides (judge built with the Task 6 evals)

- **Deterministic checks (built now):** `shared/src/grounding-check.ts` compares each spoken answer with the chunks it cited, and reports four kinds of flag:
  - **strengthening words:** "exact", "always", "guaranteed", "up front" and similar;
  - **dropped hedges:** numbers from a hedged chunk sentence stated without a hedge;
  - **unsupported specifics:** numbers, percentages or places not in the cited chunks, including places echoed from the caller;
  - **invented attribution:** "your …" when the chunks attribute nothing to the reader.
  - They **flag only** and never fail a case on their own.
  - The regression cases are the Kenya and fees answers from live call `01a0ef14…`, which must be flagged, plus cleaned versions, which must pass.
- **LLM judge (built Thursday with the Task 6 evals, not now):**
  - **Model: Sonnet.** It runs offline, so accuracy matters more than speed. It is also a different, stronger model than the Haiku agent, so the agent isn't grading its own output.
  - **The judge decides pass or fail.** Deterministic flags are passed to it as hints to examine; they don't decide.
  - **Evidence rule:** for every claim judged "supported", the judge must quote the supporting span. Code then checks that the quote appears **verbatim** (after whitespace normalisation) in a cited chunk. An unverifiable quote counts as **unsupported**, regardless of the judge's verdict.
  - Results go to the `evaluations` table.

### D33. Deployment: Railway Hobby, EU region (Amsterdam), next to Supabase `eu-central-1` (Batch 2D; revised 2026-09-30)

- **Revision (2026-09-30):** the original plan was Fly.io region `fra`. Fly.io no longer fits: its free trial is 2 hours of machine runtime or 7 days, and a card is required (https://docs.fly.io/about/free-trial/), while the budget allows $0 extra.
  - The user already pays for **Railway Hobby** ($5/month including $5 of usage), so the backend deploys there, in the EU region (Amsterdam, roughly 7–10 ms from Frankfurt).
  - **Usage budget:** the user sets a $5 hard usage limit and stops their Week 5 services, so this service must stay within about $5/month.
    - Size it at the minimum that fits the measured footprint: about 272 MB peak per turn without MCP (CLI 195 MB + backend 88 MB, measured 2026-09-30), plus an estimated 60–80 MB once the MCP server is attached, so ~350 MB per turn.
    - Report the expected monthly cost before deploying.
  - Nothing is created on Railway until after Batch 2B.
- *Original entry, kept for the record:*

- The Supabase project's region is **eu-central-1** (Frankfurt), per the user on 2026-09-29.
- *(superseded above)* The backend will be deployed to **Fly.io region `fra`** in Batch 2D, to test D24's hypothesis that most of the latency tail and the Supabase stalls come from running on a laptop far from the database.
- Laptop evidence for that hypothesis, from live call `01a0ef57-1c4e-7440-889d-332b7ea6d2dd`:
  - one turn's database phase took **42.6s**;
  - Supabase connect timeouts (`UND_ERR_CONNECT_TIMEOUT`, 10s per attempt) were seen from this network in the same hour.

### D21. Observed evidence: a dependency failure led to fabrication; the guard and gate make it an explicit failure

- **Observed in Task 4 step 1 (D18):** the MCP server failed to start because of the inherited API key, and the agent lost its only approved tool. It still answered, fabricating "RelayPay charges a 2% fee on international payments", which is plausible and wrong.
- **What prevents it now:**
  - The tool-list guard checks `init.tools` and the MCP status on every query. A mismatch fails the turn with `answer_type = error` and the fallback line.
  - The grounding gate blocks any `type=answer` that doesn't cite a chunk retrieved for the turn.
  - So a dependency failure becomes an explicit, logged failed turn instead of a confident fabricated answer.

### D22. `maxTurns` is not an idempotency mechanism

- Tools execute **before** the `maxTurns` check: with `maxTurns: 1`, a tool call still ran, then the query ended with `error_max_turns` (D18).
- A side-effect tool can therefore run even when the turn ends before the agent can confirm the action to the caller. It can also run again on a retried turn.
- Every side-effect tool must protect itself: idempotency keys, unique constraints and state guards. Examples: `create_escalation_with_ticket` takes idempotency keys, and `support_tickets.idempotency_key` is UNIQUE.

### D34. Never a 500: availability over correctness on the voice path

- **Rule:** once the path and token match, every response is HTTP 200 with a well-formed SSE stream.
  - A 500, a 4xx or a hung response makes Vapi end or stall the whole call. A spoken fallback ("Sorry, I'm having trouble checking that right now. Could you try again in a moment?") keeps the caller on the line.
  - Only a wrong token or an unknown path still gets a 404 (security; D26).
- **How:**
  - A top-level wrapper (`speakFallback`) opens a fallback stream if nothing was sent, finishes an open stream (adding the fallback if nothing was spoken), or ends the response.
  - Bad requests behind a valid token (invalid JSON, a body over 1 MB, a missing `call.id`) get 200 plus the fallback and a `bad_request` log line.
  - A duplicate that joined a failing in-flight turn finishes with the fallback.
- **Pre-turn database budget:**
  - Each database call has a 3.0s timeout.
  - The combined pre-turn work (begin attempt plus retrieval) has a 3.5s budget.
  - So the caller hears something within about 4s even when Supabase hangs. The suite measured 3.57s against a TCP blackhole.
  - The attempt then ends `failed` with the reason, recorded in the background once `begin` returns.
- **Background persistence is bounded:** one retry, each try with a timeout (`retryOnce`), never on the caller's critical path. If both tries fail, the backend writes an explicit stderr line ("left in an unknown state") and does not retry again.
- **Process-level handlers:**
  - `unhandledRejection` is always a bug. It is logged (message plus redacted stack frames, never content or the token). Only the request it belongs to fails, via the fallback, when AsyncLocalStorage identifies it. The suite asserts zero unhandled rejections on servers without injected faults.
  - `uncaughtException`: after one, process state can't be trusted, so the backend logs it the same way and calls `exit(1)`. It relies on the host's automatic restart (Fly.io restarts crashed machines; locally, restart by hand).
- **Trade-off, stated plainly:**
  - We choose availability over correctness of the record. When the database is down, the caller still gets a spoken reply.
  - That turn may be recorded late, recorded only as `failed`, or (if both tries fail) not recorded at all, with only a stderr line as evidence.
  - A database outage can therefore leave gaps in `conversation_turns` and `turn_attempts`. Anything reading those tables must not assume completeness during an incident.
  - The fallback line promises nothing and states no facts, so choosing availability never trades away grounding.
- **Tests:** fault injection via `RELAYPAY_FAULT_INJECT` (test-only) in `test:endpoint`:
  - Supabase unreachable → 200 plus fallback in 0.35s;
  - Supabase blackholed → 200 plus fallback in 3.57s;
  - the fast path still works with the database down;
  - a throw in the handler → 200 plus fallback;
  - a throw in the turn → 200 plus fallback, attempt `failed`;
  - an injected unhandled rejection → identified, fallback;
  - an injected uncaught exception → exit code 1, and the log has no content.
  - Across the suite: 45 responses, 0 with status ≥500.

### D35. Deterministic social fast path with context-aware goodbye

- **Why:**
  - In live call `01a0ef57…`, "All right, thank you." waited 42.6s on the database and got the fallback.
  - Thanks and goodbyes need no knowledge and no model. The fixed lines already exist (D31).
- **Matcher** (`backend/src/social-fast-path.ts`):
  - It works on the whole caller message: lowercased, punctuation stripped, fillers removed ("all right", "okay", "ok", "great", "perfect", "cool", "awesome").
  - The result is compared against small phrase lists:
    - thanks alone → thanks line;
    - "bye" / "goodbye" → goodbye;
    - "no, that's all" / "nothing else" with or without thanks → goodbye.
- **Context-aware decline:**
  - When the previous assistant line is the backend's own thanks line ("…anything else I can help you with?"), a whole-message short decline is a goodbye: "no", "nah", "nope", "I'm good", "no I'm good", "all good", "that's all", "not really", "no thanks", "nothing else", optionally with thanks.
  - A bare "no" counts **only** in that context.
- **Everything else goes to the model:**
  - "thanks, and what about fees?";
  - "no, actually, one more thing";
  - "oh well";
  - a bare "no" without context;
  - "all right".
- **Principle:** a false goodbye (hanging up on a caller who wasn't finished) is worse than asking again, so ambiguity goes to the model.
  - The prompt tells the model to choose goodbye when the caller declines further help after "anything else?", and not to choose goodbye when unsure.
- **Fast path behaviour:**
  - It speaks immediately with no database wait. The suite measured 2–5ms, and 20ms with the database blackholed.
  - It then records the attempt and turn in the background (bounded as in D34), as `answer_type = social` with `confidence_note = "fast_path; intent=…"`.
  - The turn log line carries `fast_path: true` and cost 0.
- **Unit tests:** 44 cases in `social-fast-path.test.ts`, including every listed decline after "anything else?" and the negatives above.

### D36. Vapi hangs up on the fixed goodbye line via `endCallPhrases`

- **Source:** Vapi assistant API, `endCallPhrases` (https://docs.vapi.ai/api-reference/assistants/create): "a list of phrases that, if spoken by the assistant, will trigger the call to be hung up"; case-insensitive.
  - The call then ends with reason `assistant-said-end-call-phrase` (https://docs.vapi.ai/calls/call-ended-reason).
- **Setting (the user sets it):** add `Thanks for calling RelayPay. Goodbye.` to the assistant's End Call Phrases.
  - We have not verified its location in the dashboard; it is probably under the assistant's Advanced settings.
- **Not documented:**
  - whether matching is exact or substring;
  - whether it applies to Custom LLM output before or after TTS.
  - Verify with a live call that says goodbye, and check that the call's ended reason is `assistant-said-end-call-phrase`.
  - Record the result here.
- We don't add a bare "Goodbye" phrase: if matching is substring-based, any model answer containing "goodbye" would hang up. The fixed line is the only thing that should end a call.

### D37. Evidence integrity moved from instruction to enforcement: runtime sentence filter

- **Why:**
  - The Kenya pattern (a general policy applied to a specific place, plus something invented about the caller) survived three prompt fixes: `ec44e7d`, the exact GOOD example with the ALSO BAD case, and the live answer "…without more details about your banking setup there".
  - This is the Week 5 feedback pattern (D30): instructions reduce unsupported claims but do not guarantee their absence. So the guarantee moves into code.
- **What:**
  - Every sentence of a `type=answer` message is checked before it is spoken, against the cited chunks (heading plus content) and everything the caller said in the call (`SentenceFilter` in `shared/src/grounding-check.ts`, used by `StreamingGate`).
  - Blocking checks, all high precision:
    - `invented_attribution`: "your X" when no cited chunk says "your" and the caller never said "my/our X";
    - `strengthening_word`: an intensifier absent from the chunks, unless negated;
    - `unsupported_specific`: a number, duration or percentage absent from both the chunks and the caller's words. Unlike the eval check, this applies inside "can't confirm" sentences too.
  - A flagged sentence is **not spoken**. The backend logs a `grounding_filtered` event with the check names and a redacted excerpt (digits masked, 80 characters). The turn's `confidence_note` records the check, the term and the sentence.
  - If every sentence of the answer is dropped, the turn is `blocked` and the caller hears `SAFE_DECLINE_LINE`.
  - Because we stream sentence by sentence, earlier clean sentences may already have been spoken. Only the flagged ones are dropped.
- **Eval-only (not blocking):**
  - `dropped_hedge` and places (`unsupported_specific` for place names). These are lower precision and would silence good sentences, such as "I can't confirm a specific timeline for Kenya."
  - `clarify` and `decline` messages cite no chunk, so there's nothing to compare against, and they are not filtered.
- **Prompt, kept as the first line of defence:** a "can't confirm" sentence ends at the place or case name, with no reason or "without knowing" clause after it.
- **Cost:**
  - About 0.1ms per sentence on average, with p99 ≤1.1ms (unit test, 500 samples, three runs).
  - The worst single sample was 9.3ms, once, under parallel test load (GC or scheduler), not steady-state cost.
  - The turn log records `filter.max_ms` per turn.
- **Known limits:**
  - Paraphrase that adds meaning without these markers (for example "in most cases they're lifted", S7 in run 4) passes the filter. That stays the judge's job (D32).
  - Durations written without digits or number words ("overnight", "a week") are not caught.
  - A sentence dropped mid-answer can leave the remaining answer less complete; the caller can ask again. We accept that: an omission is safer than an unsupported claim.
- **Tests:** `backend/src/sentence-filter.test.ts`, 9 cases:
  - live Kenya sentence dropped, range sentence spoken;
  - fees "exact … up front" dropped;
  - clean answer untouched;
  - all dropped → blocked;
  - a sentence split across deltas;
  - caller-said numbers, negations and echoed attributions allowed;
  - clarify and decline unfiltered;
  - no evidence → no filter;
  - cost.

### D38. Migration 005: choices the Batch 2B spec didn't cover

- **Attempt scope check (`check_attempt_scope`).**
  - Right after `require_active_attempt`, every guarded write also checks that the attempt belongs to the conversation being written. For events, it must also belong to the turn.
  - A mismatch raises `P0001 ATTEMPT_SCOPE_MISMATCH` and nothing is written.
  - The MCP server takes both values from the same spawn environment (D9), so a mismatch is a bug. This stops an active attempt from one call writing into another.
- **`log_conversation_event` is a guarded write.**
  - D29 exempts `tool_calls` and `retrieval_logs`, which are observability logs that must record denied calls too.
  - `conversation_events` records model-initiated actions and decisions ("ticket_created", "identity_verified"), so it follows the write rule: a superseded attempt records nothing there. Its denied call is still visible in `tool_calls`.
  - Written through `log_conversation_event_guarded(p_attempt_id, p_conversation_id, p_turn_index, p_event_type, p_summary, p_metadata)`.
- **`conversation_events` limits:**
  - `summary` is 1–500 characters;
  - `metadata` must be a JSON object of at most 4 KB (as text);
  - `attempt_id` is nullable, so the Batch 2D webhook can log events that no attempt made. Guarded writes always set it.
- **`set_verified_customer`:**
  - Re-verifying the same customer is a no-op.
  - A **different** customer than the one already verified is refused with `P0001 VERIFIED_CUSTOMER_CONFLICT`: one call acts for one customer. This keeps a second identity from silently unlocking another customer's amounts mid-call. (Since D40 no tool returns amounts; the rule still protects the customer projection and the customer recorded on tickets and escalations.)
- **Ticket priority** looks only at the transaction and payout passed in, and uses each one's own status.
  - The ticket function does not cross-check that they belong to the ticket's customer. Tickets are internal records and expose nothing to the caller.
  - On a duplicate key, the existing ticket's fields (including its priority) are returned unchanged.
- **Escalation v2** is 001's body unchanged, plus the guard and the scope check. `p_attempt_id` is the first argument. Priority stays `high` (D1).
- **Stale attempts:**
  - The 60-second rule runs inside `begin_turn_attempt`, only for the same turn, before the replacement step.
  - A stale attempt becomes `failed` with `status_reason 'stale'`, and is **not** listed in `replaced_attempt_ids`, because it wasn't replaced by this request.
  - If its backend later calls `finish_turn_attempt`, the `failed` status is kept (003 never overwrites a final status).
- **Abandonment:**
  - "Last activity" is the latest of the conversation start, any turn's `t_received`, and any attempt's start or end.
  - An abandoned conversation's `ended_at` is set to that last activity, not to the time of the sweep.
  - Its still-active attempts are failed as `stale`, so none stays `active` forever.
  - `ended_reason` is left for the Vapi webhook.
  - The function takes an optional `p_idle_minutes` (default 15), returns the count, and has no caller yet (Batch 2D).
- **Existing tests changed because 005 drops the old signature:**
  - The 001 escalation checks in `schema-suite.sh` and `race.sh` now call v2 with an active attempt. The assertions are unchanged.
  - The "RLS on every table" count is now 13/13.
- **Planned for Batch 2C:** S7's "right away" and "in most cases they're lifted" (run 4) break `escalation-rules.md`: no outcome promises, no timelines for reviews. The runtime filter (D37) will get outcome-promise and timeline-promise phrase checks in 2C.

### D39. Batch 2B tools: choices the spec didn't cover

- **Identity (`lookup_customer`):**
  - `contact_name` counts as an identifier. The spec's test "Amara" + "Lagos Ledger" is two identifiers: a name and a company.
  - A contact name matches the whole record name or exactly one of its words. "Amara" and "Okafor" match "Amara Okafor"; "Ama" does not match.
  - Companies are compared after normalising (`normaliseName`), emails after `normaliseEmail`, and IDs after `normaliseReference`.
  - With fewer than two identifiers, **nothing is looked up**: whether a single identifier exists is itself information.
  - Outcomes:
    - no match (including conflicting identifiers) → status `not_found`, reason `no_match`, event `identity_failed`;
    - several matches → `denied`, reason `ambiguous`, event `identity_ambiguous`;
    - verified → `success` plus `identity_verified`;
    - conversation already verified as someone else → `denied`, reason `already_verified_other_customer` (D38).
  - Event metadata lists which identifier **kinds** were given, never their values.
  - Escalation flag: KYC `review required` → `compliance`; account `restricted` → `account`. Compliance wins when both apply (CUS-1003).
  - The customers table is read whole (limit 10,000) and matched in code. That's fine for seed-scale data; at real scale, it would move into a SQL function on normalised columns.
- **`lookup_transaction`:**
  - IDs are accepted in any case, with or without a separator ("txn 9001" → `TXN-9001`), but must be exactly four digits.
  - `past_estimated_arrival` = an arrival date is set, the status is not `completed`, and today (UTC) is after it.
  - `failed` → `payment` escalation; `review required` → `compliance`.
  - `customer_id` is never returned. *(Superseded by D40: amount and currency are never returned, verified or not.)* ~~The amount and currency are replaced by an `amount_withheld` note unless the verified customer owns the transaction.~~
- **`lookup_payout`:**
  - Takes a payout ID or a transaction ID. When both are given, they must refer to the same payout.
  - `failure_reason` passes through a whitelist of customer-safe texts. Any unlisted reason becomes "The payout could not be completed.", and "compliance review" is spoken as "The payout is under review." (escalation rules: no internal compliance explanations).
  - `support_summary` = a status sentence plus the linked transaction's `support_summary` (Task 1 decision).
  - Only `review required` sets `requires_escalation` (per the spec). A `failed` payout does not.
  - Amounts and recipient names are not returned.
- **`create_support_ticket`:**
  - The model can't pass `customer_id` or `priority`: they're stripped by the schema. The customer comes from the verified conversation, and the priority from SQL.
  - The idempotency key is `ticket:<conversation>:<category>:<transaction ID, payout ID or none>`.
  - A transaction or payout that doesn't exist → `not_found`, and nothing is created.
  - `ticket_created` is logged only when a ticket was actually created, not on a duplicate.
- **`create_escalation`:**
  - Keys are `escalation:<conversation>:<category>` and `escalation-ticket:<conversation>:<category>`, namespaced apart from plain tickets.
  - The ticket summary is "Escalation (<category>): <reason>".
  - `follow_up_summary` says a specialist will follow up by email, plus the noted preferred time. It gives no timeline and no outcome, and a unit test asserts that.
  - `escalation_created` is logged only when the escalation was actually created.
- **`log_conversation_event`:**
  - The model may log only `clarification_requested`, `declined_unsupported`, `lookup_performed` and `other`. Identity, ticket and escalation events are written by those tools, and `gate_blocked` is the backend's.
  - Why: an audit trail the model could fake ("identity_verified") would be worthless.
  - The summary is truncated to 300 characters. Metadata over 2 KB is rejected with `invalid_input`. Both are redacted with the shared log redaction.
- **Status mapping:**
  - `ATTEMPT_NOT_ACTIVE` → `denied` (from `withWriteToolLogging`).
  - Other database refusals (`ATTEMPT_SCOPE_MISMATCH`, `ESCALATION_KEY_CONFLICT`) → `error`, because they are bugs.
  - Missing records → `found:false`, never a crash.
  - `lookup_customer` is a write tool: it sets the verified customer and logs events, so it is guarded too.
- **Not in 2B:** the agent's tool allowlist and prompt are unchanged. The tools exist and are tested directly; wiring them to the agent is Batch 2C.

### D40. Sensitive data: tools never return amounts, verified or not (supersedes the D39 amount rule)

- **Change (2026-09-30, before the first `test:tools` run):**
  - `lookup_transaction` never returns `amount` or `currency`. It doesn't even select them.
  - D39 had returned them when the verified customer owned the transaction.
- **Why:**
  - Our voice identity check is weak: a company name plus a contact's first name is guessable.
  - `escalation-rules.md` forbids the agent to "access or display sensitive account data in a spoken response".
  - Scenario 4 needs only the customer-safe status summary.
  - A field the tool never returns can't be spoken, whatever the prompt, the model or the filter do. This is the same move as D37: enforce it in code instead of instructing the model.
- **`lookup_payout`** was checked the same way. It selects and returns no amount, currency or recipient name.
- **Tests:** `scripts/test-tools.ts` asserts that amount and currency are absent before and after verification, for another customer's transaction, and for both payouts. No output contains the seed amounts or currencies.

**Fixes found by the first `test:tools` run (2026-09-30), before anything was committed:**
- **Reserved `status` key.**
  - `toToolResult` builds `{ status: <tool status>, ...result }`, so a record's own `status` silently replaced the tool status the model reads. For example, `lookup_transaction` showed `"status":"processing"` instead of `"success"`. The `tool_calls` rows were always correct.
  - Record statuses are now `transaction_status`, `payout_status`, `ticket_status` and `escalation_status`.
  - `withToolLogging` turns any result that still uses `status` into a logged `error`, and a unit test covers it.
- **`lookup_payout` embed.** `payouts` has two foreign keys to `transactions` (the plain one and the composite consistency one from 001), so PostgREST refused the embed (`PGRST201`). The embed now names `payouts_transaction_id_fkey`.
- **`log_conversation_event.metadata`** accepted any value. The MCP Inspector's `--strict` schema check flagged it. It is now a flat object with string (≤200), number, boolean or null values.

**Sensitive-data matrix (what each tool may return):**

| Field | Returned? | Notes |
| --- | --- | --- |
| `customers.support_notes` | Never | Internal notes |
| `customers.contact_email` | Never | Used only to match an identifier the caller gave |
| `customers.region` | Never | Not needed for support answers |
| customer_id, company, contact name, plan, account and KYC status | After verification only | `lookup_customer`'s safe projection |
| `transactions.amount`, `currency` | **Never** (D40) | Was "for the verified owner" in D39 |
| `transactions.customer_id`, `destination_country` | Never | |
| transaction type, status, support summary, estimated arrival, past-arrival flag | Always, by reference | Customer-safe status (scenario 4) |
| `payouts.amount`, `currency`, `recipient_name` | Never | |
| payout status, scheduled date | Always, by reference | |
| `payouts.failure_reason` | Only as whitelisted customer-safe text | D39 |
| ticket and escalation IDs, follow-up summary | To the caller whose conversation created them | No timelines or outcomes |

### D41. Batch 2C: tools connected to the agent; choices and deviations from the spec

- **Hiding `search_knowledge_base`.** `allowedTools` only grants permission: an MCP tool still appears in `init.tools`.
  - So the backend spawns the MCP server with `MCP_TOOLSET=agent`, and the server neither lists nor runs `search_knowledge_base` (a call to it gets `unknown_tool`).
  - Scripts and the Inspector default to `all`.
  - The tool-list guard requires exactly the six `mcp__relaypay__*` tools and a connected server.
- **MCP bundle (latency, measured in `docs/latency.md`).**
  - The CLI starts the MCP server only after its own boot and emits `init` only once it has connected. So MCP startup sits on the critical path and can't overlap the database work.
  - The backend spawns an esbuild bundle, `mcp-server/dist/bundle/server.mjs`, which starts about 300 ms faster than `dist/main.js`. It uses the bundle only when it is newer than every compiled source; otherwise it uses `main.js` and logs why.
  - The `ANTHROPIC_API_KEY` scrub (D13) is tested against the bundle.
  - The net cost of attaching MCP is about +1.0 s p50 first token on a KB-only turn.
- **Grounding of tool-backed answers.**
  - The backend records each tool result from the SDK stream (`tool_use` name, then the `tool_result`'s own JSON `status`).
  - A header's `tool=` must name a grounding tool that returned `success` in this attempt. A false claim blocks the message even if a valid chunk is cited.
  - **Deviation:** besides the three lookups, `create_support_ticket` and `create_escalation` also ground a `type=answer`. Otherwise "I've logged a ticket" has no valid type.
- **Filter modes.**
  - `answer` and `escalate` get the full filter; `clarify` and `decline` get the promise checks only.
  - Evidence = the cited chunks, plus the successful tool results of this attempt (statuses, and month/day dates, must come from the evidence when a record is present), plus the caller's words.
  - Promise phrases are exempt only if the **evidence** contains them (not the caller), or if they are denied in the same clause ("can't guarantee it arrives within 7 days").
- **"your <noun>" in the full filter.** Always allowed for request nouns (name, email, preferred time, callback, details, reference…). Also allowed for record nouns (account, payout, transaction…) once a tool returned a record in this attempt. Otherwise the escalation flow ("your name and email") would be filtered to silence.
- **Filler.** "One moment while I check that." is spoken by the backend at a tool start when nothing has been said yet, at most once per turn.
  - **Deviation:** it applies to `create_support_ticket` and `create_escalation` too, not only lookups. In the first `test:agent` run, a `create_escalation` turn hit the 8 s first-token timeout **after** the escalation was created, so the caller heard the fallback line. `log_conversation_event` is excluded.
  - Decisions that asked "was anything spoken?" now ask whether anything **other than the filler** was spoken, so a blocked reply after the filler still gets the safe decline line.
- **Ticket vs escalation (prompt).**
  - `lookup_transaction` returns `requires_escalation` with category `payment` for a failed transaction (2B), which conflicted with "a failed invoice payment with a reference is a ticket".
  - Resolved: `escalation_category` `payment` means offer a support ticket. `compliance` / `account`, and the escalation-rules triggers, mean the escalation flow.
- **Spoken emails.** The model passes the caller's words verbatim and the tool normalises them. In the first run, the model "corrected" "accra stack" to `accrastalk`.
  - Confirmed on 2026-09-30 (decision 4): the prompt says VERBATIM for `create_escalation` (never respell, join, correct or complete it; on `invalid_input`, ask again) and for any email given to `lookup_customer` (D42).
  - Both tools run `normaliseEmail` in code (unit-tested; `test:tools` checks "amara at lagos ledger dot example" → `amara@lagosledger.example`). So the only conversion is in code.
  - Whether the model now copies verbatim is checked by the S7 rerun (the `create_escalation` input is printed).
- **Identity for lookups.** `lookup_transaction` and `lookup_payout` need only the reference (they return only customer-safe fields, D40). Only account questions need `lookup_customer`.
- **Known gaps after this batch:**
  - S3: Haiku still asks for an email or ID after "I am Amara from LagosLedger" despite an explicit example.
  - *(Considered and allowed, 2026-09-30, decision 3.)* "They will follow up to help get this resolved" passes the promise filter, and that is intended.
    - `escalation-rules.md` requires the agent to confirm that a representative will follow up.
    - "to help get this resolved" states the team's intent, not an outcome: it doesn't say the issue **will be** resolved, or when.
    - The filter keeps blocking outcome constructions ("will be resolved", "will be lifted") and timelines.
  - *(Resolved by D43: a per-conversation write cap of 2 tickets and 1 escalation.)* No per-turn ticket cap in the tool. Idempotency keys are per category, so a model making parallel calls in several categories could create several tickets. The five-tickets test passed only because the model refused.

### D42. Security decisions belong to code: the model passes details, the tool decides (2026-09-30)

- The first 2C prompt told the model to check identity itself ("ask for a second identifier BEFORE calling lookup_customer").
  - Haiku then refused to call the tool even with a name plus a company (S3 failed twice), and asked for a customer ID or email instead.
  - The rule was being enforced twice, and the model's copy was the unreliable one.
- **Rule:** the model does not gatekeep identity. It calls `lookup_customer` with whatever identifiers the caller gave (contact name, company, email, customer ID).
  - The tool enforces the two-identifier rule in code (D39) and returns `needs_second_identifier`, `ambiguous` or `no_match`.
  - Only then does the model ask for another identifier, without saying which detail was wrong.
- "Clarify before calling" stays only for a missing transaction or payout reference. Without it there is nothing to look up, and guessing one would be worse.
- **What actually fixed S3:** the prompt change alone did not. `lookup_customer`'s own tool description still said "Needs at least TWO identifiers … With fewer, it refuses and you must ask for another one", and Haiku kept gatekeeping.
  - With the description rewritten to "call it with whatever details the caller gave; this tool decides", S3 called the tool and verified CUS-1001 on the next run.
  - **Rule: tool descriptions are instructions too.** The model reads them with the same weight as the system prompt. A description must never tell the model to enforce a policy the tool enforces in code (identity, amounts, ownership, write limits). It should say what to pass and what to do with each result.
- The live S3 answer "Your account is active and your KYC status is approved" was dropped by the attribution check. "kyc" and "status" are now allowed record nouns when a tool returned the caller's record (unit test with the live sentence).
- General principle for Phase 2: anything security- or policy-critical (identity, amounts, write limits, idempotency, supersession) is enforced in code or in SQL. The prompt only describes what to do with the tool's answer.

### D43. Per-conversation write cap in the MCP tools: 2 tickets, 1 escalation (2026-09-30, decision 2)

- **Rule:** at most **2 support tickets** and **1 escalation** per conversation, enforced in the tool code (no migration). The tool counts the conversation's rows in the database before the guarded write.
- **Beyond the cap:** status `denied` with `reason: conversation_write_limit`, and nothing is written. The prompt tells the agent to say the support team already has the details, and not to try again.
- **Counting:**
  - Only plain tickets (idempotency key `ticket:…`) count toward the 2. An escalation's own linked ticket counts under the 1-escalation limit.
  - A repeat of an **existing** idempotency key is never capped: it creates nothing and returns the existing row (idempotency, D11). It still reaches the database guard (D29). `test:tools` uses exactly that to prove the guard after replacement.
- **Race:**
  - Count-then-write is not atomic across processes.
  - Within one turn, the write tools run one at a time inside the MCP server process (`serialised`), so parallel tool calls in one message can't both pass the count.
  - Across turns, requests for one call are sequential, and a replaced attempt can't write anyway (D29).
  - A hard database guarantee would need a constraint or trigger (a migration); not done, as decided.
- **Tests (`test:tools`, fresh conversation with its own active attempt):**
  - tickets 1 and 2 are created;
  - a third ticket is `denied` / `conversation_write_limit`;
  - a repeat of ticket 1 returns it;
  - escalation 1 is created;
  - a second escalation in another category is `denied` / `conversation_write_limit`;
  - the rows are 2 plain tickets plus 1 escalation with its ticket.

### D44. Ownership rule: a reference is a bearer token only until an identity is established (2026-09-30)

- **The leak:** in `test:agent`, a caller verified as CUS-1001 asked about TXN-9003 and heard its status ("under compliance review"). TXN-9003 belongs to CUS-1003.
- **Rule (`lookup_transaction`, `lookup_payout`):**
  - **Conversation not verified:** a reference-only lookup returns the customer-safe fields, as before. Scenario 4 still passes: knowing a reference is the only credential there is.
  - **Conversation verified, and the record belongs to a different customer:** `denied`, `reason: not_available`. No status, summary or date is returned, and the result doesn't confirm the record exists.
    - A verified caller asking about a reference that doesn't exist gets the byte-identical result, so the tool can't be used to probe which references exist.
    - The `tool_calls` row records the real reason, for the audit.
  - The agent says it can't share details on that reference and offers a specialist.
- **Why:** before anyone has proven an identity, a reference is all we have, and the fields are customer-safe. Once a caller has proven to be customer A, asking about customer B's record is not a normal support question. It is a misuse signal (a shared phone, a guessed reference, social engineering), so the proven identity wins.
- **Ownership is read from the database:** `transactions.customer_id` / `payouts.customer_id` against `conversations.verified_customer_id`. Never from tool input.
- **Tests (`test:tools`):**
  - unverified TXN-9001 → success;
  - verified CUS-1001: own TXN-9001 → success; TXN-9003 → denied with no status or summary; unknown TXN-0000 → the identical denial;
  - PAY-7002, and PAY-7003 via TXN-9004 → denied; own PAY-7001 → success.

### D45. "Compliance" is never spoken (2026-09-30)

- **Tools:**
  - `lookup_transaction` and `lookup_payout` return the record status through the same customer-safe mapping ("review required" → "under review").
  - A seed `support_summary` that mentions compliance, or carries an internal instruction ("Escalate account-specific questions."), is replaced by a plain status sentence ("The transaction is under review."). This includes the linked transaction summary that `lookup_payout` appends, which changes D39's "status sentence + transaction summary" for those records only.
  - `escalation_category: "compliance"` is still returned, because it is the value the model passes to `create_escalation`. It is a field, not text to speak.
- **Runtime filter (every spoken type):** a sentence containing "compliance" is dropped unless the caller used the word first (`internal_term`).
  - Why: `escalation-rules.md` forbids explaining compliance decisions, and naming them invites it. "Under review" plus an offer of a specialist says everything the caller needs.
  - Side effect, accepted: a general KB answer that quotes "compliance reviews" is also filtered. The restrictions FAQ now yields its other sentences, or the safe decline if nothing is left.
- **Tests:**
  - `test:tools`: unverified TXN-9003 → "under review" with the summary replaced, and no "compliance" in any spoken field; the same for PAY-7002.
  - Unit tests: the filter drops the word, and allows the caller's echo.

### D46. A preferred callback time is a preference, not a promise (2026-09-30)

- The escalation flow collects an optional preferred time (`preferred_time_text`, verbatim, D1/D39). It records what the caller would like, not something RelayPay has scheduled.
- **Prompt:** step 5 of the escalation flow says the time is noted ("I've noted tomorrow morning as your preferred callback time. A representative will follow up.") and never states it as a commitment ("they will call you tomorrow morning", "someone will be in touch soon").
- **Filter:** "will … tomorrow" / "will … soon" in the same clause is filtered even when "tomorrow morning" is the caller's own words. Promise phrases are exempt only when the cited evidence contains them, and the caller's words are not evidence for promises (D41). The "noted as your preferred callback time" framing has no promise construction and is spoken.
- **Unit test:** the live S7 shape. With the caller's "tomorrow morning" and a `create_escalation` record in evidence, "A representative will call you tomorrow morning." is filtered, while "I've noted tomorrow morning as your preferred callback time." and "A representative will follow up." are spoken.

### D47. A gate violation mid-reply does not end the turn (2026-09-30)

- **Live case (other-customer test):** the model spoke "I'd be happy to help, Amara." and then called a tool in the same message. The gate cut the rest of that message (as designed, D23), the agent loop continued, and the next message was empty. Because something had been spoken, no safe line was added, and the caller heard a dangling sentence.
- **Rule:**
  - The rest of the violating message is still dropped, and the agent loop continues. The NEXT message is spoken if it has its own valid header, which the gate already allowed.
  - What changed: sentences spoken from a cut-off message no longer count as "the caller heard a reply". If nothing valid follows, the turn appends the safe line (blocked) or the fallback line (error), exactly as for a turn where only the filler was spoken.
- **Prompt:** "Never write text before a tool call."
- **Unit tests:** the live case followed by a valid answer, where the answer is spoken; and the live case followed by an empty message, where the final message is blocked.

### D48. decline / clarify may name any tool that was called (2026-09-30)

- **Live case:** after `lookup_transaction` returned `denied` / `not_available`, the model's correct reply "I can't share details on that transaction reference over the phone…" was blocked. Its header claimed `tool=lookup_transaction`, and D41 required a successful result, so the caller got the generic decline instead.
- **Rule:**
  - For `type=decline` and `type=clarify` only, a tool claim is valid if that tool was **called** in this attempt, whatever its status. Those types assert no facts from the result.
  - A tool that was never called is still a false claim, and blocks the message.
  - `type=answer` and `type=escalate` still require a successful grounding tool (or a cited chunk, for answer).
- **Prompt:** a reply after a tool that did not succeed is `decline` or `clarify`, never `answer`. (The live header was `type=answer`, which stays blocked.)
- **Unit test:** the live sentence under `type=decline` with a denied lookup is spoken; a never-called tool is still rejected; `type=answer` with the denied lookup is still rejected.

### D49. The agent model comes only from the environment, with a one-shot fallback on model_not_found (2026-09-30)

- **Config:** `AGENT_MODEL` (required; the backend refuses to start without it) and `AGENT_MODEL_FALLBACK` (optional). Both must look like a Claude model id. No model id is hard-coded in the backend.
- The decision is Haiku 4.5, with Sonnet 5.5 as the fallback (docs/model-choice.md).
- **Unit tests** preload `backend/dist/test-env.js`, which sets a test `AGENT_MODEL`. No unit test calls a model.
- **Detection:** probed on 2026-09-30 with an unknown model id.
  - The CLI emits `init` (about 1.4 s), then an assistant message with `error: "model_not_found"` and a synthetic text (about 2.4 s), then an error result.
  - The backend stops that run on the `model_not_found` assistant message, before the synthetic text can reach the gate.
- **Fallback, only when all of these hold:**
  - the error is `model_not_found`. Other errors (rate limit, overloaded, auth, billing) are **not** a reason to switch models;
  - nothing has been spoken yet;
  - the turn isn't finished;
  - at least `MODEL_FALLBACK_MIN_REMAINING_MS` (3 s) of the 8 s first-token budget remains.
  - Then the primary run's CLI tree is killed, and the same prompt runs once more with the fallback model on a fresh CLI/MCP, with a fresh gate and stdin.
- **Logging:** a `model_fallback` event (from, to, `ms_remaining`, `retried`). The turn note says "model fallback: A -> B", and `conversation_turns.model` / `turn_attempts.model` record the model that actually answered.
- **If the fallback isn't possible** (no fallback set, not enough time, or the fallback is also unavailable), the caller hears the fallback line and the turn is `error`.
- **Tests (`test:endpoint`):**
  - an unknown primary with Haiku as fallback → the fees question is answered, the row has `model = claude-haiku-4-5`, and `model_fallback` shows `retried: true`;
  - an unknown primary with no fallback → 200 plus the fallback line, and `retried: false`.

### D50. End-of-call webhook: POST /v/:token/vapi/events, with a deterministic summary (Batch 2D step 1, 2026-09-30)

- **Route:** `POST /v/<VAPI_LLM_SECRET>/vapi/events`, with the same constant-time token check as the Custom LLM route. A wrong token, or any other method, gets the same 404.
- **Messages:**
  - Only `end-of-call-report` is handled. Every other type gets 200 and is ignored, and only the type is logged.
  - Shape: `ServerMessageEndOfCallReport` in https://api.vapi.ai/api-json.
  - Vapi doesn't retry by default (`server.backoffPlan` is undefined). The report is informational, and the default timeout is 20 s.
- **200 first, then recording:** the call is over and nobody waits on the write, so acknowledging immediately avoids Vapi's timeout. It was measured at 4 ms locally. A failed recording is retried once with a timeout, then logged (`vapi_end_of_call_failed`).
- **Idempotent by `call.id`** (our `conversation_id`): a repeated delivery writes the identical row, and `test:endpoint` checks it. A call that never reached the LLM gets its conversation row created (channel `voice`, `started_at` from the report).
- **Fields:**
  - `ended_at` comes from `endedAt`.
  - `ended_reason` comes from `endedReason`.
  - `final_status`: an explicit list of normal endings maps to `completed`. The list covers `customer-ended-call`, `assistant-ended-call*`, `assistant-said-end-call-phrase`, `assistant-forwarded-call`, `manually-canceled`, `voicemail` and `call-deleted`, plus the timeouts `silence-timed-out` and `exceeded-max-duration`.
  - Everything else maps to `failed`. That includes errors, caller media problems such as a denied microphone, and **unknown reasons**: the enum has 600+ values and grows, and a real error is worse to miss than a normal ending mislabelled.
- **`vapi_metrics`** holds only `artifact.performanceMetrics` (`turnLatencies[]` and the averages), `cost` and a duration computed from `endedAt − startedAt`.
  - The transcript, messages, customer details and Vapi's own summary are never stored or logged.
  - `performanceMetrics` may be missing; then it is stored as `null`.
- **Summary:** deterministic, built from our own rows. For example: "4 turns (answer 1, escalate 2, social 1). Identity: verified. Tickets: 1 (payment). Escalations: 1 (account). Ended: customer-ended-call."
  - Not Vapi's `analysis.summary`, and not an LLM: it can't hallucinate, it costs nothing, and the same facts always give the same text.
  - No names, emails or transcript.
- **Totals** are recomputed (`recompute_conversation_totals`) after each report.
- **Tests:**
  - unit (`vapi-events.test.ts`): status mapping, metrics projection with no PII, summary determinism, message classification;
  - `test:endpoint`: first delivery (200 in < 1 s, fields, metrics, summary, nothing sensitive stored); duplicate (identical row); unknown type (ignored, row unchanged); wrong token (404); a call with no turns and an error ending (row created, `failed`); no transcript or customer details in the logs.

### D51. Stale cleanup every 5 minutes (Batch 2D step 2, 2026-09-30)

- `abandon_stale_conversations()` (migration 005) runs once at startup and then every `STALE_SWEEP_INTERVAL_MS` (5 min). The test knob is `RELAYPAY_STALE_SWEEP_MS`.
- A sweep never overlaps the previous one: a tick that finds one running is skipped and logged (`stale_sweep_skipped`).
- Each run logs `stale_sweep` with the count and duration, or `stale_sweep_failed`. A failure doesn't stop later runs.
- The timer is unref'd.
- **Tests:** unit tests with a stub database (startup run, overlap guard, failure then recovery); `test:endpoint` checks the startup sweep's log line.

### D52. Web voice page at /, served by the backend (Batch 2D step 3, 2026-09-30)

- **Routes:** public `GET` (and `HEAD`) routes for `/`, `/app.js`, `/app.css`, `/config` and `/health`.
  - They are checked before the token routes. Any other `GET` gets a 404, and the token routes are unchanged.
  - `/config` returns exactly `{vapiPublicKey, vapiAssistantId}` from the environment, and a 503 if either is unset. They are public by design, but stay out of the repo.
  - `/health` returns `{"status":"ok"}` and nothing else, so it exposes no configuration.
- **SDK:**
  - `@vapi-ai/web` 2.7.1 publishes no UMD/browser build (its `main` is CommonJS), so a plain `<script src>` can't load it.
  - It is imported as an ES module from esm.sh, pinned twice: `https://esm.sh/@vapi-ai/web@2.7.1?deps=@daily-co/daily-js@0.87.0`. That pins the SDK version and its Daily WebRTC dependency.
  - Not SRI-hashed: an import of an esm.sh module graph can't carry integrity for its sub-imports.
- **Security headers on every public response:**
  - CSP `default-src 'self'; script-src 'self' https://esm.sh https://*.daily.co; style-src 'self'; img-src 'self' data:; connect-src 'self' https: wss:; media-src 'self' blob: mediastream:; worker-src 'self' blob:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`;
  - `nosniff`, `no-referrer`, and `Permissions-Policy: microphone=(self)`.
  - Daily is allowed in `script-src` because the Daily client loads its call bundle at call start. That part was **not** exercised locally, because no call was started. Check it on the first real call from the deployed page.
- **UX:**
  - Brand colours: deep blue primary `#0b2a5b`, teal accent `#0f766e` (focus ring and the listening icon only), and an off-white background. System UI font, no web font. No transcript or chat UI.
  - States in words: Loading → Ready → Requesting microphone → Connecting → Live (listening / RelayPay is speaking) → Call ended (a plain-English reason from `endedReason`) → Error.
  - The icon's shape also changes with the state, so colour is never the only cue.
  - A call timer with a 4-minute guard: a warning at 3:30, and the page stops the call at 4:00.
- **Errors, each with steps the caller can take:**
  - The microphone is checked with `getUserMedia` first, so a blocked mic, a missing device and a mic in use by another app are told apart.
  - SDK `error` events are classified:
    - microphone blocked: how to allow it;
    - output device / `setSinkId`: use the built-in speakers and mic, and close apps using the mic;
    - origin or key rejected;
    - network: try another network or a hotspot;
    - the SDK failed to load;
    - not configured.
- **Accessibility:**
  - native buttons, so it is keyboard operable;
  - a visible 3 px focus outline;
  - `role="status" aria-live="polite"` for state changes, and `role="alert"` for errors;
  - AA contrast (ratios listed in `app.css`);
  - responsive: buttons go full width under 420 px, and there is no horizontal scroll.
  - Focus moves to End call when a call starts, and back to Start when it ends.
- **Checked:**
  - In Chrome against the local backend, the page reached **Ready**: `/config` answered and the pinned SDK loaded under the CSP. No console errors, the focus ring was visible, and there was no overflow.
  - `test:endpoint` checks the routes, headers, `/config` (exactly the two env values), `/health`, and the 404s.
- **Also fixed:** the backend entry is now `dist/start.js`, which loads `.env` before anything reads it (see the commit). `npm start` had failed because the model is required from the environment (D49).

### D53. Deployed to Railway: project therese-relaypay-week6, EU West (Amsterdam) (Batch 2D step 4, Part A, 2026-09-30)

- **Project and service:**
  - A new project, `therese-relaypay-week6`, created with `railway init`. The repo wasn't linked to any project before, and the Week 5 project was not touched.
  - Service `relaypay-backend`, environment `production`.
  - Domain: `relaypay-backend-production-aa34.up.railway.app`.
- **Image** (`Dockerfile`):
  - `node:22-bookworm-slim`, two stages. `npm ci --include=optional` keeps the Claude CLI's `linux-x64` binary and esbuild. Then `npm run build` (tsc + MCP bundle) and a prune of dev dependencies.
  - The runtime stage copies only `dist`, `public` and `node_modules`, adds `ca-certificates` for the CLI's TLS, and runs as the non-root `node` user with `HOME=/home/node`, `CLAUDE_CODE_DISABLE_TERMINAL_TITLE=1` and `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`. The CLI child's environment sets the last two as well.
  - CMD: `node backend/dist/start.js`.
- **Config:**
  - `railway.json` sets: DOCKERFILE builder; healthcheck `/health` (60 s); restart on failure (max 10); `sleepApplication: false`; `multiRegionConfig` `europe-west4-drams3a` ×1.
  - **The first deploy still ran in `us-west2`:** the service manifest showed it, although the file named `europe-west4-drams3a`.
  - Fixed with `railway scale eu-west=1 us-west=0`, and the manifest now shows `europe-west4-drams3a: 1 replica`.
  - Railway warns that config-as-code files are deprecated in favour of `.railway/railway.ts`, and keep working until 2026-12-01. Migrating is a later task.
- **Secrets:**
  - 8 variables were set with `railway variable set KEY --stdin --skip-deploys`, so values went through stdin and never onto a command line or into output: `ANTHROPIC_API_KEY`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `VAPI_LLM_SECRET`, `AGENT_MODEL`, `AGENT_MODEL_FALLBACK`, `VAPI_PUBLIC_KEY`, `VAPI_ASSISTANT_ID`.
  - They were verified equal to `.env` by a script that prints only "match".
  - `PORT` is Railway's (8080).
- **Checked after deploy:**
  - `/health` → `{"status":"ok"}`; `/`, `/app.js` and `/config` (the two public keys only) → 200; unknown path and wrong token → 404.
  - The deploy log shows `listening` and a startup `stale_sweep` (0 abandoned, 160 ms).
  - The deploy log (7 lines) and build log (235 lines) contain no secret value and no secret-shaped string (scanned locally, only counts printed).
- **Expected monthly cost, against the $5 of included Hobby usage:**
  - Prices (https://railway.com/pricing, 2026-09-30): memory $0.00000386/GB·s (≈ $10/GB-month), CPU $0.00000772/vCPU·s (≈ $20/vCPU-month), egress $0.05/GB. Billing is per second of actual use.
  - Idle: about 0.1 GB (the backend measured about 90 MB on the laptop) ≈ **$1.00/month**, plus idle CPU of a few thousandths of a vCPU ≈ **$0.10–0.20**.
  - Per turn: about 0.3 GB and about 1 vCPU for about 8 s ≈ $0.00007. So 500 turns a month ≈ **$0.04**, with egress under 1 GB ≈ **$0.05**.
  - **Total ≈ $1.2–1.5/month**, well under the $5 included.
  - The 1 GB replica limit caps a runaway, and the account has a $10 hard limit with a $5 alert.
  - Estimate only: re-check against Railway's usage page after a week.
- **Replica memory limit: set to 1 GB by the user on 2026-09-30.** In the dashboard it is under the service's **Scale** settings, not under Settings → Deploy → Replica Limits as the docs say (https://docs.railway.com/guides/optimize-usage). Serverless (app sleeping) was confirmed OFF. The limits are per replica, and "setting replica limits too low will cause your service to crash". 1 GB leaves about 3× headroom over one turn's measured peak (~300–350 MB with MCP).

### D54. Vapi server messages: Vapi's default list if the dashboard has no selector (2026-09-30)

- The assistant's `serverMessages` field can't be set by us without a private API key, and the user won't provide one (decided). If the dashboard shows no "Server Messages" selector, the assistant keeps **Vapi's default list**:
  - `conversation-update, end-of-call-report, function-call, hang, speech-update, status-update, tool-calls, transfer-destination-request, handoff-destination-request, user-interrupted, assistant.started` (https://docs.vapi.ai/api-reference/assistants/create).
- **Trade-off, accepted:**
  - Every call then POSTs several extra messages to `/v/<token>/vapi/events`, mainly `speech-update`, `status-update` and `conversation-update` several times per turn.
  - The webhook answers each one with a fast 200 (measured 4 ms locally), logs only its type, and writes nothing (D50). The cost is a little CPU, egress and log volume.
  - `conversation-update` bodies carry the transcript. They are parsed in memory and discarded, never logged or stored.
- **Risk:** if Vapi ever waited on one of these messages (e.g. `transfer-destination-request`, `tool-calls`), our 200 without a body would be the answer. We use neither transfers nor Vapi tools (D8), so no call path depends on them.
- **To revisit:** if a private key is ever available, set `serverMessages: ["end-of-call-report"]`.

### D55. The Vapi/Daily SDK needs 'unsafe-eval'; allowed in script-src only (2026-09-30)

- **What happened:** the first live call from the deployed page failed before starting.
  - Chrome reported "Content Security Policy blocks the use of eval" in `daily-esm.js`.
  - Our CSP report route recorded exactly **2× `script-src`, blocked `eval`, source `esm.sh`** and nothing else.
  - The page showed the generic error.
  - This was the untested gap noted in D52: Daily's call bundle only runs when a call starts.
- **Change:** `script-src 'self' 'unsafe-eval' https://esm.sh https://*.daily.co`.
  - **Only** `'unsafe-eval'` was added, because it's the only thing the reports showed. No `'unsafe-inline'`, and every other directive is unchanged.
  - If the retry reports another block (worker, blob, wasm, media or connect), add only that one and list it here.
- **Trade-off, accepted:**
  - `'unsafe-eval'` lets any script already running on the page turn a string into code. So it widens what a script-injection bug could do.
  - Mitigations:
    - there are no inline scripts, and `'unsafe-inline'` stays off, so injected markup can't run;
    - the page has no user-generated content: it renders only our static text, the server's state strings, and error text from fixed tables;
    - script sources are limited to `'self'`, esm.sh and Daily;
    - the SDK is pinned: `@vapi-ai/web@2.7.1` with `@daily-co/daily-js@0.87.0`;
    - `frame-ancestors 'none'`, `base-uri 'none'` and `form-action 'none'`.
  - The vendor requires eval; the alternative is no web calls.
- **Second live call: `blob:` added to `script-src` (2026-09-30).**
  - With eval allowed, the call got further. Daily's **Krisp** noise filter then failed. Chrome: "Loading the script 'blob:https://relaypay-backend-production-aa34.up.railway.app/…' violates … script-src", then "Failed to load worklet module script", then `KrispInitError … WORKLET_NOT_SUPPORTED`.
  - Worklet modules have no directive of their own and fall back to `script-src` (`script-src-elem` isn't set).
  - Vapi recorded `silence-timed-out` after 41 s with no customer audio (`fromTransportLatencyAverage` 0), and the browser showed "Meeting ended due to ejection".
  - Change: `script-src 'self' 'unsafe-eval' blob: https://esm.sh https://*.daily.co`.
  - `worker-src 'self' blob:` was already present (D52), and no worker violation was reported. **Nothing else was added.**
  - Our report route received no report for this block, so Chrome's console was the only evidence. It is kept as the evidence here.
  - **Why `blob:` is acceptable:**
    - a `blob:` URL can only be created by script that is already allowed to run on this page (our own code, or the pinned SDK sources). So it adds no new source of code, only a new way for already-trusted code to load a module;
    - there is still no `'unsafe-inline'`, and still no user-generated content.
  - **Why noise filtering is kept** (instead of disabling Krisp to avoid `blob:`): on earlier calls, background noise was transcribed as caller speech and started spurious turns. The filter is worth the directive.
- **Error messages (the page):**
  - A component or bundle load failure, or a failure while the browser reported a CSP violation in this attempt, now says: "The call couldn't start because the voice component failed to load. This is a problem on our side, not your microphone or network."
  - The microphone, device, network, origin and not-configured messages are unchanged.
  - The generic "Something went wrong" appears only for truly unknown errors, with "Error code for support: <sdk error type>" (lower-case, 40 characters at most).

## Migration log

- 001 applied to Supabase from commit ab76cb5 (ab76cb506e025890454c3a8c61c06291e85f21b9) on 2026-09-29.
  - User-verified after applying: RLS is true on all 11 tables. `create_escalation_with_ticket` EXECUTE is held only by `postgres` and `service_role`.
- 002 applied to Supabase from commit b4646bf (b4646bf28eedbdd90e3b19df072e49eba36906fd) on 2026-09-29.
  - User-verified after applying: `search_kb` EXECUTE is held only by `postgres` and `service_role`.
- 003 applied to Supabase from commit 485387c on 2026-09-29.
  - User-verified after applying: EXECUTE on `begin_turn_attempt`, `finish_turn_attempt`, `attempt_is_active`, `require_active_attempt` and `recompute_conversation_totals` is held only by `postgres` and `service_role`.
- 004 applied to Supabase from commit 8144fcc on 2026-09-29.
  - User-verified after applying: `conversation_turns_answer_type_check` lists all 7 values, including `'social'`.
- 005 applied to Supabase from commit 29b7227 on 2026-09-30.
  - User-verified after applying: the old 13-argument `create_escalation_with_ticket` is gone (`to_regprocedure(...) is null` = true).
  - EXECUTE on `check_attempt_scope`, `create_support_ticket_guarded`, `create_escalation_with_ticket` (v2), `set_verified_customer`, `log_conversation_event_guarded`, `begin_turn_attempt` and `abandon_stale_conversations` is held by `service_role` and not by `anon`.
  - RLS is true on `conversation_events`.

## Task 1 findings, classified

| Class | Finding | Resolution |
| --- | --- | --- |
| Source contradiction | The KB fee wording differs from scenario 1's expected wording | Follow the KB (D2) |
| Data/schema mismatch | `lookup_payout` must return `support_summary`, but payouts have no such column | Derived in code from the payout status plus the linked transaction's `support_summary` |
| Naming mismatch | The column is `transaction_type`, but the `lookup_transaction` output field is `type` | Mapped in the tool output |
| Underspecified | Ticket category, priority and status are not defined | Decided in D1 |
| Policy/test tension | `escalation-rules.md` says to escalate questions about a specific transaction, but scenarios 3–5 expect lookups | **Our reconciliation, not the documents':** do a safe lookup first when enough verified context exists, state customer-safe facts only, and escalate when the case needs human judgment |
| Data note | TXN-9001 is `processing` with `estimated_arrival` 2026-08-19, a date that has passed | `lookup_transaction` computes `past_estimated_arrival` in code. The agent states the record and offers a ticket without speculating |

Seed enum values all fall within the schema guide's lists. `payouts.status` values `scheduled` and `completed` are allowed by the guide but absent from the CSV. CHECK constraints use the guide's full lists.

## Documentation discrepancies

- **X1. Vapi Custom LLM path.**
  - The OpenAPI `CustomLLMModel.url` describes the value as the OpenAI client's `baseURL`, so the path is appended.
  - The docs' tool-calling integration page instead shows `url: "https://custom-llm-url/chat/completions"`.
  - We follow the base-URL reading (D4). The first live request confirms which is right; record the result here.
- **X2. Vapi streaming.** The docs recommend streaming, and one page implies a JSON response is accepted. Neither `stream` nor `max_tokens` is documented as a request field. We stream SSE `chat.completion.chunk` lines ending with `data: [DONE]`.

### D56. Declining an offer is not goodbye: `declined_offer` social intent and a guard on the model's goodbye (2026-09-30)

- **What happened:** live call `01a0f455…` from the deployed page. Turn 1 offered a ticket ("…Would you like me to log a ticket for the support team to look into this?"), and the caller said "No, thank you."
  - The fast path correctly returned null: a decline outside the "anything else?" context went to the model.
  - The **model** chose `intent=goodbye` (the turn row: `model = claude-haiku-4-5`, cost $0.0017, no `fast_path` note), following the D35 prompt rule "if you just asked whether there is anything else and the caller declines… choose goodbye". So the goodbye line was spoken to someone who had only declined a ticket.
- **Fix, in three places:**
  - **Fast path** (`social-fast-path.ts`): a whole-message short decline ("no", "no thanks", "no thank you", "I'm good", …) is
    - `goodbye` ONLY when the previous assistant line is one of the fixed "anything else?" lines (thanks or declined_offer);
    - `declined_offer` when the previous line asked a question (ends in "?") or made an offer ("would you like", "if you'd like", "do you want");
    - otherwise, including no previous line or a plain statement, it goes to the model.
    - Clear goodbyes ("bye", "no, that's all", "nothing else") still end the call in any context, as in D35.
  - **New fixed line** `SOCIAL_LINES.declined_offer`: "No problem. Is there anything else I can help you with?" It sets up the anything-else context, so the next "no" is a goodbye. It contains no "goodbye", so it can't trigger the end-call phrase.
  - **Prompt:** the goodbye rule now requires the caller to say goodbye, or the last line to be exactly "Is there anything else I can help you with?". Declining a ticket, callback or specialist is `intent=declined_offer`.
  - **Guard in the gate** (the model is not trusted to end the call): a model `intent=goodbye` stands only if `goodbyeAllowed(caller message, previous agent line)`, meaning the previous line was a fixed "anything else?" line, or the caller's message contains bye / goodbye / that's all / that's it / nothing else. Otherwise the gate speaks the declined_offer line.
- **Tests:**
  - `social-fast-path.test.ts`: after the live ticket offer, "No, thank you." → declined_offer (and the line has no "goodbye"); "No thanks", "No", "I'm good" likewise; an offer without "?" ("…if you'd like.") likewise; after "anything else?" → goodbye; after the declined_offer line → goodbye; a bare "no" with no context → model; clear goodbyes after an offer still end the call; `goodbyeAllowed` cases.
  - `gate.test.ts`: the declined_offer header speaks its line; the guard turns a model goodbye without context into the declined_offer line, and keeps it in context.
- **End-call phrase (D36) still unverified live:** this call ended `customer-ended-call`, about 10 s after the goodbye line (turn received 22:01:25.7, spoken by about 22:01:27; ended 22:01:37). No call has ever ended with `assistant-said-end-call-phrase`. Either the phrase is not set on the assistant, or Vapi does not match it on Custom LLM output. Check the assistant's End Call Phrases in the dashboard.
