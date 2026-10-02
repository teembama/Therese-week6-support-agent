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

### D57. Ticket creation applies the D44 ownership rule (audit F3, Batch 3A item 1, 2026-10-01)

- **Gap:** `create_support_ticket` only checked that a TXN or PAY reference existed. A verified caller could file a ticket on another customer's record. `not_found` vs `success` confirmed that the record existed, and the computed `priority: high` revealed that it was failed or under review.
- **Rule now:** the same rule as the lookups. Once the conversation is verified, a reference owned by another customer gets **exactly the same** `denied` / `reason: not_available` result as one that doesn't exist (`notAvailable()`). This happens before the write cap, the guarded RPC and the priority computation, so nothing is written and no priority is computed.
  - Unverified conversations keep the current behaviour: `not_found` for an unknown reference, otherwise the ticket is created.
- **Tests** (`test:tools`, 61 checks, all pass):
  - verified CUS-1001 + TXN-9003 → denied not_available, no priority;
  - verified + PAY-7002 → denied;
  - verified + unknown TXN-0000 → the identical denial;
  - denied calls wrote nothing;
  - unverified + TXN-9003 → created, priority high.
  - The old check that filed a verified ticket on CUS-1003's PAY-7002 asserted the leak itself. It now uses CUS-1001's own PAY-7001.

### D58. The full sentence filter runs on decline, clarify and escalate replies (audit G2/G3, Batch 3A item 2, 2026-10-01)

- **Gap:**
  - Decline and clarify replies were only checked for promises and "compliance".
  - Escalate replies got the full filter, but it had no check for a number-free diagnosis. "Your account was likely flagged because of unusual activity" passed whenever the caller had said "my account" (an echo).
- **Now** (`gate.ts filterOptionsFor`, `shared/src/grounding-check.ts`): every spoken type except social gets every check: promises, "compliance", strengthening words, invented "your X", unsupported numbers, plus statuses and months when a tool record is present.
- **Decline, clarify and escalate also get:**
  - **Evidence** = this attempt's successful tool results + the caller's words. Cited chunks don't count for these types, so a chunk's "suspicious activity" can't be pinned on the caller.
  - **`speculative_diagnosis`:** "likely / probably / possibly / most likely / presumably", "because of / due to / caused by / as a result of / triggered by", and "flagged".
    - Allowed if the evidence contains the phrase.
    - Allowed when it sits under a denial in the same clause ("I can't say why it was flagged").
    - Answers don't get this check, because a cited chunk may legitimately explain causes.
  - **Reference-format descriptions** are not checked for numbers or "exactly": "TXN followed by four digits", "exactly four numbers", "like TXN-9001".
  - **"your X" in a question** asks, not claims ("Is your payment incoming or outgoing?").
  - **Extra allowed "your" nouns:** identity, information, account, dashboard, customer, id, company, issue, concern, frustration, situation, and service/services (added after `test:agent` flagged "your service" in the SEC-notes decline). "your name / email / preferred time" stay allowed as before.
- **Also:** "one" as a pronoun or in a set phrase is no longer read as the number 1 ("is it one you're sending", "one moment").
- **Replay:** all 106 stored decline/clarify/escalate replies (235 sentences, from Supabase, read-only) were run through the new filter with evidence = caller words only. That is stricter than at runtime, because tool records aren't stored in full.
  - The first pass flagged 14 sentences that the old filter passed, all false positives. They led to the allowances above: the pronoun "one", "four numbers", "your identity / dashboard / account".
  - The final pass flags **0** of them.
- **Tests:** 10 in `tool-grounding.test.ts`. Among them:
  - the escalate diagnosis → filtered, even with "my account" said;
  - the chunk-sourced cause → filtered;
  - decline with "3 percent" → filtered;
  - decline "Your bank always…" → filtered;
  - reference formats → spoken;
  - an invented number in clarify → filtered;
  - a question with "your payment" → spoken.
  - The backend suite now has 165 tests, all passing.
- **Still not caught (G1):** a number-free unsupported claim in an **answer** that cites a valid chunk. See `limitations.md`.

### D59. At most 3 concurrent agent turns per process; beyond that, a fixed busy line (audit H4, Batch 3A item 3, 2026-10-01)

- **Gap:** every non-social request spawned a Claude CLI and an MCP server, with no limit. A burst, or a leaked token, could exhaust the single 1 GB replica (about 300–350 MB per turn, D53) and run up spend.
- **Rule:**
  - `backend/src/admission.ts` admits at most `RELAYPAY_MAX_CONCURRENT_TURNS` agent turns at once (default 3; must be a positive integer, or startup fails).
  - Beyond that, `runTurn` speaks `BUSY_LINE` ("We're getting a lot of calls right now. Please try again in a moment.") through the same no-model path as the social fast path. No CLI or MCP is spawned.
  - The busy turn is recorded as `answer_type = error`, `confidence_note = "busy: concurrency cap N reached"`, attempt `completed` / `busy`. The turn log line carries `busy: "busy"`.
- **What counts toward the cap:**
  - Slots are counted **per conversation turn** (`callId#turnIndex`). A speculative replacement of the same turn reuses its predecessor's slot, so one caller's partial transcripts never lock out another caller.
  - An in-flight duplicate joins the running turn and needs no slot.
  - The social fast path is exempt: it spawns nothing.
  - A slot is released when the turn's `done` settles.
- **Why 3:** at about 350 MB per turn plus the ~100 MB idle backend, 3 turns fit in 1 GB with headroom. At one turn every few seconds per active call, that is several simultaneous calls, which is plenty for the demo and grading.
- **Tests:**
  - `admission.test.ts`, 4 tests: cap, same-turn slot reuse, idempotent release, drain.
  - `npm run test:capacity`, 10 checks, run locally, all pass:
    - with cap 1, a second conversation's agent turn gets the busy line in 15 ms, and nothing is spawned;
    - a social turn in the same period gets its fixed line;
    - the running turn answers normally;
    - the busy row, attempt and log line are as specified;
    - after the first turn finishes, a new one is admitted.

### D60. Graceful shutdown on SIGTERM: drain for up to 10 s, then exit (audit M7, Batch 3A item 4, 2026-10-01)

- **Gap:** there was no signal handling. Every deploy dropped in-flight turns and could leave attempts active.
- **Now** (`server.ts main`):
  - On SIGTERM (and SIGINT locally), `admission.drain()` runs and `shutdown_started` is logged with the in-flight count.
  - **New agent turns get BUSY_LINE** (D59). The social fast path still answers: it spawns nothing and finishes in milliseconds.
  - **Every started turn gets up to `SHUTDOWN_GRACE_MS`** (10 s; `RELAYPAY_SHUTDOWN_GRACE_MS` for tests) to finish, including its row and totals. That is tracked by a set of unfinished `done` promises, not the in-flight join map, which is released at `persisted`.
  - Then `shutdown_complete` is logged with the unfinished count and time, the server is closed, and the process exits with `exit(0)`.
  - The Dockerfile's exec-form `CMD ["node", "backend/dist/start.js"]` runs Node as PID 1 with the handler registered. `start.js` imports the server in the same process, so SIGTERM reaches it.
- **Railway needed a config change as well:** "Once the new deployment is online, the old deployment is sent a SIGTERM signal. By default, it is given 0 seconds to gracefully shutdown before being forcefully stopped with a SIGKILL." (https://docs.railway.com/reference/deployments, "Singleton deploys").
  - Config-as-code field `deploy.drainingSeconds`: "The time in seconds between when the previous deploy is sent a SIGTERM to the time it is sent a SIGKILL." (https://docs.railway.com/reference/config-as-code).
  - `railway.json` now sets `drainingSeconds: 15`, which is the 10 s grace plus margin.
  - Without it, the handler would never get to run on Railway.
- **Local test** (`npm run test:capacity`, 11 of its 21 checks, all pass):
  - Windows can't deliver SIGTERM to a Node child: `kill()` terminates it. So the test sends the server an IPC `{type: "shutdown"}` message, which calls the same `shutdown()`.
    - The IPC listener only exists when a parent spawned the process with an IPC channel, which Railway never does.
  - With a KB turn in flight:
    - a new agent turn → busy line;
    - a social turn → its line;
    - the in-flight turn answered normally, and its row was written;
    - no attempt was left active;
    - the process exited 0 at 3.8 s;
    - `turns_unfinished: 0`.
  - With `RELAYPAY_SHUTDOWN_GRACE_MS=500` and a turn in flight: it exited at 581 ms, reporting `turns_unfinished: 1`. That turn's attempt stays active until the stale sweep closes it (D51).
- **Real SIGTERM on Linux: verified 2026-10-01.** `railway redeploy` replaced deployment `ffeb53c0`, and its own logs show:
  - "Stopping Container";
  - `event="shutdown_started" signal="SIGTERM" turns_in_flight=0 grace_ms=10000` at 10:45:02.951Z;
  - `event="shutdown_complete" signal="SIGTERM" turns_unfinished=0 ms=0` 1 ms later.
  - So the handler runs as PID 1 in the container and Railway delivers SIGTERM before stopping it. There was no traffic in flight; the in-flight drain is covered by the local test.

### D61. A call with no answered turn is `failed` (no_interaction), whatever Vapi's ended reason (Batch 3A item 5, 2026-10-01)

- **Gap:** D50 mapped `final_status` from `endedReason` alone. A call where the caller never got a reply (silence timeout, a hang-up before any answer) showed as `completed`. Example: the 2026-09-30 18:46 voice call, `silence-timed-out` with 0 turns.
- **Rule** (`vapi-events.ts`):
  - An **answered turn** is one where something was spoken and `answer_type` is not `error`. Fallback and busy lines are errors. A `blocked` turn counts, because the safe decline was spoken (`isAnswered`).
  - With 0 answered turns, `finalStatusFor(endedReason, 0)` is `failed`.
  - The summary gets "No interaction: no answered turn." appended.
  - Vapi's `ended_reason` is stored unchanged. The summary and final_status carry our reading of it.
- **Tests:** `vapi-events.test.ts`:
  - zero answered turns → failed for five reasons, including `customer-ended-call` and `assistant-said-end-call-phrase`;
  - `isAnswered` cases;
  - summaries for 0 turns and for 2 error-only turns.
  - The backend suite has 171 tests, all passing.
- **Existing rows, read-only preview (2026-10-01):** 12 webhook-closed conversations, 6 of them with no answered turn.
  - `final_status` would change on **1**: the 18:46 voice call `01a0f3a3…` (`silence-timed-out`), from `completed` to `failed`.
  - The other 5 are already `failed`: two `test-ep-…` with `pipeline-error-custom-llm-llm-failed`, and three voice calls with `…did-not-receive-customer-audio`.
  - All 6 summaries would gain the no-interaction sentence.
  - **Data correction applied 2026-10-01 10:43 UTC**, on the user's explicit approval ("Item 5: apply"):
    - **6 rows** in `conversations` were updated: `final_status = 'failed'` and " No interaction: no answered turn." appended to `summary`.
    - Nothing else was touched (no other columns, tables or rows).
    - The script re-selected the targets first (webhook-closed, 0 answered turns), and they matched the preview exactly. Each PATCH returned 1 row.
    - The rows: `01a0f3a3-ffa3-7bb3-b798-dc9b8f6dc6e8` (status **completed → failed**), plus summary-only changes on the five already-failed rows: `01a0f395-4c08-7bbb-a739-0c5517a58a4e`, `01a0f396-098d-766b-909f-bb0a07d4518f`, `01a0f396-32ce-7997-ba5e-026b6d456e97`, `test-ep-2026-09-30T13-38-43-891Z-webhook-no-turns`, `test-ep-2026-09-30T13-51-35-605Z-webhook-no-turns`.
    - **Why:** so these historical rows follow the same rule (D61) as every call recorded from now on.

### D62. Attribution repair: drop an invented "your" when the rest is verbatim evidence (Batch 3A item 6, 2026-10-01)

- **Why:** in the deployed runs (latency.md, Batch 2D Part B), "International payouts usually take 2 to 5 business days, depending on the destination and **your** banking partners." was dropped by `invented_attribution`. It was the only sentence, so the caller got the safe decline instead of a correct answer. Dropping the whole sentence cost precision over one word.
- **Rule** (`SentenceFilter.repairAttribution`, used by the gate):
  - A flagged sentence is repaired only if **every** flag is `invented_attribution`.
  - For each flag, the phrase after "your" (e.g. "banking partners") must appear **verbatim** in the cited evidence.
  - Then that "your" is removed (a sentence-initial "Your" moves its capital on).
  - The repaired sentence must pass **every** check again.
  - Otherwise the sentence is dropped exactly as before.
  - "your own / specific / particular X" is never repaired, because the remainder isn't verbatim evidence.
- **Logging:** `conversation_turns.confidence_note` gets `grounding_repaired: <flags>: <model sentence> -> <spoken sentence>`, and the log line is `event: grounding_repaired` with terms and a digit-masked excerpt.
- **Tests** (`sentence-filter.test.ts`, 5):
  - the live sentence → spoken as "...depending on the destination and banking partners.", nothing filtered, one repair logged;
  - "your banking setup there" (not verbatim) → still dropped;
  - an extra unsupported number or strengthening word → not repaired;
  - "your specific banking partners" → not repaired;
  - a sentence-initial "Your" → capitalised correctly.
  - The backend suite has 176 tests, all passing.

### D63. Accepted residual risks from the audit: F2 identity strength, F1 pre-verification references, G1 number-free claims (Batch 3A item 7, 2026-10-01)

- **F2: first name + company name verifies a caller.**
  - This is **required by Scenario 3's own wording**. assets/test-scenarios.md: "Hi, this is Amara from LagosLedger. Can you check my account status?". The expected behaviour is a `lookup_customer` with that information and a safe summary. A rule demanding an email or customer ID would fail the scenario as written.
  - **Compensating control:** verification unlocks **no sensitive data** (D40). Verified or not, the tools never return an amount, currency, contact email or support notes. The customer lookup returns only plan, account status and KYC status, spoken as customer-safe values (D45).
  - What verification does unlock: ownership-scoped reference lookups (D44, D57) and linking tickets and escalations to that customer.
  - **Residual risk:** someone who knows a customer's contact name and company can hear that customer's plan and account status, and file a ticket or escalation under that customer with their own email. A specialist's callback goes to the email the caller gave, not the one on file.
  - **Future work:** require a non-public identifier for anything beyond status, and flag escalations whose email differs from the account's.
- **F1: TXN/PAY reference lookups before verification.**
  - This is **required by Scenario 4**: "Can you check transaction TXN-9001?", with no identity step. The expected behaviour is a `lookup_transaction` and a safe summary.
  - D44 makes a reference a bearer token only until the caller is verified.
  - **Only the safe summary is returned:** type, customer-safe status and summary, estimated arrival and a past-ETA flag. There is no amount, currency, customer identity or recipient (D40).
  - **Known limitation:** there is **no rate limit on enumeration**. References are the prefix plus 4 digits, so 10,000 values per prefix. A caller could step through them, one tool call each and at most 4 per turn (maxTurns). That would reveal other customers' operational statuses, but nothing that identifies them.
  - Voice makes this slow. The per-process cap (D59) bounds concurrency, not volume.
  - **Future work:** a per-conversation cap on distinct references looked up while unverified.
- **G1: a number-free unsupported claim in an answer that cites a valid chunk can be spoken.**
  - Example: "Your payment is most likely held up by bank processing times", under the "why is my payment delayed" chunk.
  - Pattern checks can't catch this. The meaning is added without any of their markers: no number, promise, strengthening word, invented "your", or (for answers) diagnosis wording.
  - D58 closes it for decline/clarify/escalate, with the diagnosis check and tool/caller-only evidence. For answers, a cited chunk may legitimately explain causes, so that check would drop correct answers.
  - **The backstop is the offline LLM judge.** It is the Task 6 evals, planned and **not yet built** (limitations.md). It would run on recorded answers against the chunks they cite, after the fact.
  - **Update 2026-10-01:** built later the same day as `scripts/eval-scenarios.ts` (Batch 3B; D66). It flagged "outside our control" in S8 (docs/testing-evidence.md).
  - **A runtime judge was considered and rejected for latency.** It would be a second Haiku 4.5 call ($1 / $5 per MTok, per the claude-api skill's model table, cached 2026-09-25) before each answer is spoken.
    - **Cost (estimate):** about 1,000 input tokens (instructions, 1–2 cited chunks, the answer) and about 30 output tokens. That is ≈ **$0.0012 per answer turn**, about +40% on the measured mean of $0.0028 per turn (test:agent, 2026-10-01).
    - **Latency (estimate, not measured):** the judge must see the whole answer before any of it is spoken. That adds one direct model round trip, roughly **0.6–1.2 s**, on top of the deployed KB first-token p50 of 1.33 s (latency.md). It would also cancel sentence streaming, which the latency work depends on.
    - The added latency is the reason for rejecting it; the cost is acceptable. Revisit it if the offline judge shows these claims happen often.

### D64. Clause-level trimming in the runtime filter (Batch 3C fix 1, 2026-10-01)

- **Observed (BEFORE eval run `eval-2026-10-01T10-57-37-311Z`):** S1 failed 3/3.
  - Haiku joins the required fact and an embellishment in one sentence: "RelayPay displays the applicable fees before you confirm a transaction, **so you'll see exactly what applies to your payment**."
  - The filter drops whole sentences, so the scenario's required fact ("shown before confirmation") was never spoken.
- **Rule** (`SentenceFilter.trimTrailingClause`, used by the gate after the D62 repair):
  - It applies when **every** flag of a sentence sits in a trailing clause introduced by ", so", ", so that", ", which", ", meaning" or " — ", and the leading clause passes **every** check on its own.
  - Then the leading clause is spoken, ending with a full stop, and logged as `grounding_trimmed` (note and log line, like D62).
  - The latest qualifying cut wins, to keep as much of the sentence as possible.
  - A flag in the leading clause is never trimmed away. The cut never falls inside a number range ("2 — 9") or after a reference prefix.
  - The lead must have at least 3 words. Otherwise the sentence is dropped as before.
- **Replay (read-only):** all 56 stored `grounding_filtered` sentences that were complete in their notes, replayed with their turn's cited chunks and the caller's words. **52 would now be trimmed, 4 still dropped.**
  - The 52 are two patterns only: the S1 fees sentence → "RelayPay displays the applicable fees before you confirm a transaction." (50), and the S8 sentence → "Payment timelines depend on external banking systems and regulatory checks." (2).
  - Every trimmed lead is verbatim chunk wording. There were no unintended trims.
- **Tests:** `sentence-filter.test.ts`, 6 tests:
  - the live S1 sentence through the gate → trimmed and logged;
  - a flag in the lead → dropped;
  - ", which" and " — " cuts;
  - no connector → dropped;
  - a number range is never split;
  - a lead that fails on its own → dropped.

### D65. Outcome verbs without "will", real reference prefixes only, and no follow-up channel or time (Batch 3C fixes 2a–2c, 2026-10-01)

- **Observed (BEFORE eval run):**
  - S6 r1: "…will follow up on the beneficiary details **and get your payment sorted**". This is an outcome promise the patterns missed, because "get … sorted" isn't next to "will".
  - S6 r3: "references typically start with **INV** or TXN followed by four numbers". INV is an invented prefix. D58's format exemption skips a format's numbers but checked nothing about its prefixes.
  - S7 r3: "will follow up with you **at efua@…**". This states the follow-up channel; the escalation records a callback preference only.
- **2a. Outcome promises** (`OUTCOME_PROMISES`, every spoken type): "get (your/the/this/it…) (payment…) sorted / resolved / fixed / cleared up", "take(n) care of", "sort it/this/that out".
  - The D41 allowance stands: "a representative will follow up" is required by the escalation rules and is not flagged (unit test).
- **2b. Reference prefixes:**
  - A reference-shaped token `XXX-dd…`, or an all-caps token in a "starts with X or Y followed by N digits/numbers" description, must be TXN, PAY or CUS. Anything else is flagged `unsupported_specific` ("inv prefix").
  - **CUS is allowed as well as TXN and PAY.** It is the customer-ID format `lookup_customer` accepts (assets/mcp-tool-requirements.md), and clarify replies legitimately describe it. Flagging it would drop correct sentences.
  - "ID" (as in "customer ID") is never a prefix.
- **2c. Prompt:**
  - Escalation step 5 now says to confirm a representative will follow up, but never HOW (email, phone, callback to an address or number) or WHEN, beyond the caller's noted preference.
  - The ticket rule says the same, and adds: never say they will fix, sort out or resolve it.
- **Tests:** `tool-grounding.test.ts`, 4 tests:
  - the S6 r1 sentence is filtered while "A representative will follow up." is spoken;
  - four other outcome verbs;
  - the S6 r3 INV sentence is flagged, the TXN/PAY format is spoken, and REF-1234 is flagged;
  - "customer ID … CUS followed by four digits" is spoken.
  - The backend suite has 188 tests, all passing.
- **Replay** of the 149 stored decline/clarify/escalate replies (351 sentences): the new checks add **0** flags. Four "your payout" flags in that replay are an artifact: the replay has no tool records, while at runtime the payout record allows the noun.

### D66. Judge evidence: an approved-procedure corpus, for procedural statements only (Batch 3C fix 3, 2026-10-01)

- **Why:** in the BEFORE run, the judge flagged statements the PRD *requires* the agent to make, because its evidence was only the turn's chunks, tool results and caller words. Examples:
  - "A RelayPay specialist needs to look at a restricted account" (S7 ×3; escalation-rules.md: "Tell the user that a RelayPay specialist needs to help");
  - "the support team will follow up" (S6);
  - "references start with TXN or PAY followed by four digits" (S2 ×2).
  - **Flagging these measured the wrong thing.** They are procedure, not product claims, and the PRD's escalation and decision rules mandate them.
- **Change** (`scripts/eval-scenarios.ts`):
  - The judge also receives `<approved_procedure>`, made of:
    - `assets/escalation-rules.md`;
    - `assets/support-decision-rules.md`;
    - the reference formats.
  - The tool spec gives no reference format, so the formats block holds the system prompt's tool-input rule, quoted verbatim ("A reference is the prefix and exactly four digits."), plus a sentence built from the seed IDs: "Transaction references look like TXN-9001 and payout references like PAY-7002."
- **Enforcing the split in code, not only in the prompt:**
  - The judge now tags each claim `procedural` (what the agent will do, who follows up, what a specialist handles, what the caller should provide) or `fact` (product and policy facts, fees, timelines, features, the caller's records).
  - A **fact**'s quote must be found verbatim in the turn's evidence.
  - A **procedural** claim's quote may also come from the procedure corpus.
  - So a product claim can never be "supported" by the procedure files, even if the judge mislabels the block it quotes.
- **Not changed:** product and policy facts still need the turn's chunks or tool results. Example: SEC-AMOUNT's "you can view the amount in your dashboard" is still a fact claim.

### D67. Evidence-free decline: the backend speaks the fixed safe-decline line (Batch 3C fix 4b, 2026-10-01)

- **Observed (BEFORE eval, ROB-OVERSEAS):** "What's it cost to pay someone overseas?" retrieved **zero** chunks. The model declined, but in the same reply stated policy from memory: "…RelayPay displays the applicable fees before you confirm any transaction…".
  - The statement is true, but nothing in the attempt supported it. With no evidence, the gate only checked the sentence for promises and patterns.
- **Rule** (`StreamingGate`, at header validation):
  - It fires when **all three** hold: `type=decline`, **this attempt retrieved no qualifying chunk** (the retrieved set is empty), and **no tool returned success**. A called but denied or failed tool doesn't count as evidence.
  - Then the backend speaks `SAFE_DECLINE_LINE` and discards the model's text, as for social replies.
  - Logged as note `decline_fixed_line` and log event `decline_fixed_line`.
  - Only decline is replaced. An evidence-free clarify is still the model's own question.
- **Tests:** `tool-grounding.test.ts`, 5:
  - the BEFORE-eval ROB-OVERSEAS reply → the fixed line, no fee policy;
  - a denied tool → still the fixed line;
  - with a retrieved chunk → the model's decline as before;
  - with a successful tool → as before;
  - an evidence-free clarify → unchanged.
  - The backend suite has 193 tests, all passing.
- **Impact on stored declines (read-only):**
  - 19 of the 51 stored declines that have a retrieval log meet the condition. One is the ROB-OVERSEAS case.
  - The other 18 are off-topic declines (mostly weather) in which the model described RelayPay's products from memory ("cross-border payments, invoicing, contractor payouts…"). Those are also unsupported claims, and they now get the fixed line.
  - That is safe but less natural for an off-topic question. Accepted: the fixed line still offers a specialist.
  - `test:endpoint`'s weather check asserts only `answer_type = decline`, which still holds.
- **With fix 4a** (the synonyms), ROB-OVERSEAS itself now retrieves the fees chunk, so it is answered rather than declined. This rule covers the paraphrases that synonyms don't reach.

### D68. Event writes are best-effort; an evidence-replay failure is evidence_error (Batch 3C fix 5; the fix for the observed audit M5 pattern, 2026-10-01)

- **Observed (BEFORE eval, SEC-OTHER):** in the evidence replay, `lookup_customer` committed the verification (`set_verified_customer`). Then the `identity_verified` event write failed (`fetch failed`, 12.4 s), and the tool returned **`error`**.
  - The conversation stayed verified; the next replayed call says "conversation verified as CUS-1001".
  - This is audit finding M5, observed for real: a business action that succeeded, reported as a failure. In a live call the agent would have told the caller verification failed.
- **MCP fix** (`logEventBestEffort` in `mcp-server/src/tools/common.ts`):
  - The events that *record* an action already committed, or an outcome, are now best-effort: `identity_verified`, `identity_failed`, `identity_ambiguous`, `ticket_created` and `escalation_created`.
  - A failed write is logged to stderr (`[relaypay-mcp] event … not recorded`) and appended to the tool call's `result_summary` (`; event_write_failed (<type>): <message>`). The tool's status and result are unchanged.
  - **Not changed:** the `log_conversation_event` tool keeps the strict write, because there the event *is* the action.
  - **Trade-off:** an event can now be missing while its ticket, escalation or verification exists. The `tool_calls` note shows it, and the business rows stay the source of truth.
- **Runner fix** (`scripts/eval-scenarios.ts`):
  - A replay fails when a lookup throws, or when the **replayed status differs from the status the agent got**.
  - On failure the replay is retried once in a fresh evidence conversation (`…-retry`).
  - If it fails again, the run is `evidence_error`: not judged, not a pass, with the reason in `evaluations.notes`.
- **Tests:**
  - `mcp-server/src/tools.test.ts`, 3: a "fetch failed" error object → note, no throw; a thrown error → note; success → empty note.
  - `test:tools` 61/61 against Supabase: events are still written on the normal path.
  - The runner change is exercised by the AFTER eval run; it has no unit test of its own.

### D69. Failed transactions offer a ticket; only "review required" escalates (Batch 3C follow-up, 2026-10-01)

- **Observed (AFTER eval S6 r3):** after `lookup_transaction` returned failed TXN-9004, the model started the escalation flow. When the caller then said "Yes, please log a ticket", it asked for name and email instead of creating the ticket.
- **Root cause, a contradiction in our own signals:**
  - `transactionEscalation("failed")` returned `requires_escalation: true, escalation_category: "payment"`.
  - The prompt's escalation section says to escalate when a tool returns `requires_escalation true`.
  - The ticket rule said "requires_escalation with escalation_category payment means the same: offer a ticket".
  - So the model got two instructions for one flag. Payouts were already consistent: only "review required" set `requires_escalation`.
- **Change:**
  - Only "review required" sets `requires_escalation` (category compliance), for both transactions and payouts.
  - A **failed** transaction or payout returns `offer_ticket: true` and `requires_escalation: false`.
  - Both tool descriptions now say: offer_ticket → offer a support ticket (`create_support_ticket`), not a specialist; requires_escalation → a specialist.
  - The prompt's ticket rule now reads "A lookup that returns offer_ticket true … means the same: offer a ticket, not the escalation flow".
- **Tests:**
  - `tools.test.ts`: failed → `{ requires_escalation: false, offer_ticket: true }`; review required → compliance.
  - `test:tools` 63/63: failed TXN-9004 and failed PAY-7003 each return offer_ticket with no escalation.

### D70. create_escalation's follow-up text: no channel, address or time (2026-10-01)

- **Found by the system-overview check, and the root cause of a BEFORE-eval failure:**
  - `followUpSummary` returned "A RelayPay support specialist will follow up with you **by email at** <email>" (or "…**at** <email>, and your preferred time … has been noted").
  - The tool description told the model to "Read follow_up_summary to the caller".
  - That contradicted D65's prompt rule (never state the follow-up channel or time) and produced the BEFORE S7 r3 sentence "will follow up with you at efua@…". The runtime filter doesn't catch it: the email is the caller's own words.
- **Change:**
  - `follow_up_summary` is now always "A RelayPay support representative will follow up.", with no channel, address or time.
  - The caller's preferred time is returned separately as `preferred_time_noted`.
  - The tool description says to tell the caller a representative will follow up, never how or when. A preferred time is confirmed only as **noted** ("I've noted tomorrow morning as your preferred time"), never as a commitment.
  - The escalation row is unchanged: `user_email`, `call_booked` and `preferred_time_text` are still stored for the specialist.
- **Tests:**
  - `tools.test.ts`: the summary says "will follow up" and contains no email address, no channel words ("by email", "e-mail", "phone") and no time words.
  - `test:tools` 64/64: the real escalation's summary has no "@", "by email" or time, and `preferred_time_noted` equals the caller's words.

### D71. gate_blocked events are written when the gate blocks a reply (2026-10-01)

- **Why:** `conversation_events.event_type` allowed `gate_blocked`, and D39 and `log-conversation-event.ts` said the backend records it, but no code wrote it (found by the system-overview check). Blocks were visible only in `conversation_turns.confidence_note` and the logs.
- **Change** (`recordGateBlocked` in `backend/src/turn.ts`):
  - When the final message is blocked (missing, malformed or late header; every sentence filtered; …), the backend writes a guarded `gate_blocked` event.
  - The summary is "Reply blocked by the grounding gate: <reason>". `metadata.reason` holds the reason. The blocked text is never stored here; it stays in the turn's `confidence_note`.
  - **Best-effort, like D68:** the write is bounded by `DB_CALL_TIMEOUT_MS`, never throws, and logs a failure to stderr. Nothing the caller hears changes.
  - The write is awaited before `finish_turn_attempt`, because the event is attempt-guarded and must land while the attempt is still active.
- **Tests:** `turn-units.test.ts`, 2:
  - the guarded RPC with `gate_blocked`, the attempt ID, the turn index and the reason-only summary;
  - a failed write doesn't reject.
  - The backend suite has 195 tests, all passing.

### D72. The escalation flow is enforced by create_escalation's input schema, not description wording (2026-10-01)

- **Measured regression caused by D70:**
  - S7 passed 3/3 in the AFTER run.
  - After D70 reworded `create_escalation`'s description (the follow-up text change), the after3 run recorded **0/3**. Both complete runs (r1, r2) called the tool straight after the caller's email, skipping the email read-back and never asking for a preferred time (`preferred_time_text` null). r3 was cut short by the run's cost cap.
  - The flow had been held in place only by description and prompt wording, and a wording change elsewhere in the same description broke it.
  - **Lesson:** a flow step that matters must be a precondition the tool checks, not a sentence the model may weigh differently after an unrelated edit.
- **Change** (`mcp-server/src/tools/create-escalation.ts`):
  - **New inputs:** `email_confirmed_by_caller: true` (the agent read the email back and the caller confirmed it), and **either** `preferred_time_text` (verbatim) **or** `preferred_time_declined: true`.
  - **`escalationPreconditions`** checks them in the flow's order, before anything is read or written. A missing or false value returns `invalid_input` with a reason the model can act on, ending "Nothing was written.":
    - "Read the email back to the caller exactly and get their confirmation first, then call again with email_confirmed_by_caller true."
    - "Ask the caller for their preferred callback time first, then call again with preferred_time_text … or preferred_time_declined true."
  - The two fields are optional in the zod schema on purpose, so a missing value gets this actionable message rather than a generic schema error.
  - **`call_booked`** is true only when `preferred_time_text` is given; a declined time means call_booked false.
- **Description:** lists the steps in order (name → email → read back and confirm → preferred time → create), says the tool refuses until steps 3 and 4 are done, and keeps D70's "a representative will follow up, never how or when" and "time NOTED, never a commitment".
- **Prompt:** escalation steps 3–4 now name the flags, and say to do the missing step and call again if the tool refuses.
- **Tests:**
  - `tools.test.ts`, 5:
    - missing time → reason "Ask the caller for their preferred callback time first";
    - declined → allowed, call_booked false;
    - time given → allowed, call_booked true;
    - email not confirmed, missing or false → "Read the email back…", checked before the time;
    - every reason says nothing was written.
  - `test:tools` 65/65 against Supabase: both refusals return `invalid_input` with the actionable reason, and no escalation row is written. The existing escalation calls (idempotency, guard after replacement, write cap) now pass the flags.

### D73. The previous line's LAST question decides goodbye vs declined_offer (live testing, 2026-10-01)

- **Observed (live call `01a0f80f…`, 15:22):**
  - The weather decline was model text: "I can only help with RelayPay account and payment questions. **Is there anything else I can help you with regarding RelayPay?**"
  - The caller said "No. Thank you." and got "No problem. Is there anything else I can help you with?" (`declined_offer`), so it asked "anything else?" twice.
  - Only the *fixed* "anything else?" lines counted as anything-else context (D35/D56). This model-written line didn't, but it ended in "?", so the decline was treated as declining an offer.
- **Rule** (`askedAnythingElse`, used by the fast path and by `goodbyeAllowed`):
  - The anything-else context holds if the previous line is a fixed anything-else line, **or** its **last question** contains "anything else" and an offer of help (help, assist, do for you).
  - So "…I can log a ticket if you'd like. Is there anything else I can help with?" → a decline is a goodbye.
  - But "Is there anything else I can help you with? Or would you like me to log a ticket?" → the offer is the last question → declined_offer.
- **Tests:** `social-fast-path.test.ts`, 7:
  - the live weather line → goodbye;
  - an offer followed by anything-else → goodbye, including the live ticket confirmation line;
  - anything-else followed by an offer → declined_offer;
  - an offer last → declined_offer;
  - "anything else about this transaction…" (not an offer of help) → not goodbye;
  - `goodbyeAllowed` agrees.
  - The backend suite has 201 tests, all passing.

### D74. One account per call: a different identity on a verified call is refused up front (live testing, 2026-10-01)

- **Observed (live call `01a0f816…`, 15:30):**
  - The caller was verified as Amara (CUS-1001), then said "Actually, I'm Efua from AccraStack", which was transcribed as "**FY from Acrostic**".
  - `lookup_customer` returned **no_match**: the misheard name matched nobody, so the database's `VERIFIED_CUSTOMER_CONFLICT` backstop was never reached.
  - The agent then asked for more details. On the next turn it passed `email: "efua"` and got invalid_input, and asked for the full email: as if verifying a second account were possible.
- **Rule** (`lookup_customer`), checked first, before the one-identifier rule and before any matching:
  - If the conversation is already verified, the given identifiers are compared with **that** customer (`matchesCustomer`).
  - **Same customer:** success with the safe projection. It still goes through the guarded, idempotent `set_verified_customer`, so a replaced attempt is refused here like everywhere else (D29). The first version skipped that write; `test:tools`' guard test caught it.
  - **Anything else** (another customer, a misheard name, a single different identifier, a malformed email or ID): `denied`, reason **`already_verified_other`**. Its message: "This call is already verified for another account. Tell the caller you can only help with one account per call, and offer to connect them with a RelayPay specialist. Do not ask for more details." Nothing about the other customer is returned. An `identity_failed` event is written best-effort.
  - The database conflict path now returns the same reason, as a backstop.
- **Tool description and prompt:** on `already_verified_other`, say you can only help with one account per call, offer a specialist, and never ask for more details to verify a second account.
- **Tests:**
  - `tools.test.ts`: `matchesCustomer` (the same customer across spellings; Efua/AccraStack, FY/Acrostic and a single "Efua" don't match), and the `already_verified_other` message.
  - `test:tools` 69/69: after verifying CUS-1001, "Efua"/"AccraStack", the live "FY"/"Acrostic", and a single "Efua" each → `already_verified_other`, with nothing about CUS-1003. Amara again → success. After replacement → `attempt_not_active`.

### D75. The filler is flushed as a complete sentence (live testing, 2026-10-01)

- **Observed:** the caller hears "One moment while I check that." only once the answer seems ready.
- **Measured (read-only, today's live calls):**
  - **Server-side** (Railway turn marks, 14 tool turns): the filler fires at the `tool_use` content-block **start**, already as intended (turn.ts). Request → filler p50 **1257 ms**; filler → first answer sentence p50 **1449 ms** (n=13). So the backend sent the filler about 1.4 s before the answer.
  - **Vapi side** (`vapi_metrics.performance_metrics`, 4 calls whose turns align): tool turns had turn latency p50 **3938 ms** and **voiceLatency p50 1854 ms**. Turns without a tool: 2637 / 392 ms. Social fast-path turns: 995 / 377 ms.
  - The extra ~1.4 s of voice latency on tool turns matches the server-side gap between filler and answer. Vapi wasn't voicing the filler until the answer arrived.
- **Cause (inferred, not confirmed in Vapi's docs):**
  - `SseStream.content` sent each piece without a trailing space, and put a leading space on the *next* piece.
  - So the filler went out as "One moment while I check that." with nothing after the full stop until the answer's " Your payout…" arrived. Vapi's sentence chunker couldn't see the boundary and held it.
- **Change:** every content piece is a complete sentence and is sent with its **trailing** space ("One moment while I check that. "), never a leading space on the next. It is still written to the response immediately.
- **Tests:** `sse.test.ts`, 2: the filler is written at once as exactly "One moment while I check that. "; later sentences carry their own trailing space, and the joined text is unchanged. The backend suite has 203 tests, all passing.
- **After:** measured on the next live call's Vapi `voiceLatency` for tool turns, recorded below when available.

### D76. The voice page explains every known ending and failure in plain words (live testing, 2026-10-01)

- **Observed (live call `01a0f839…`, 16:08):** Vapi ended the call for silence (`silence-timed-out`, 39 s, no caller speech transcribed), and the page showed "Something went wrong… Error code for support: daily-error".
  - The page doesn't log SDK events server-side, so the exact client event wasn't captured.
  - The code shows the path: the Vapi SDK reports Daily's ejection ("Meeting has ended") as an `error` of type `daily-error`. `classify` had no rule for it, so it fell through to generic.
- **Change** (new pure module `backend/public/call-end.js`, imported by `app.js`, served at `/call-end.js`):
  - **`isCallOverError`:** once the call has started, an ejection or "meeting ended" error, or an otherwise-unclassified `daily-error`, is the call **ending**. It is explained at call-end, with a 1.5 s fallback if call-end never comes.
  - **`endOutcome`:**
    - a silence end, meaning Vapi's `silence-timed-out` or **no caller speech ever transcribed** for 20 s or more (tracked client-side from Vapi's final user transcripts), → "We couldn't hear you, so the call ended. Check your microphone is selected and unmuted, then try again." with a headset tip;
    - the 4-minute limit → "The call reached the 4-minute limit. Start a new call to keep going.";
    - a normal end → "The call has ended. Thanks for calling RelayPay.";
    - the caller hanging up → "You ended the call.".
  - Microphone blocked, device, network, not allowed, not configured, insecure page and component-failed keep their messages. Only a truly unknown error is "Something went wrong", with its code.
- **Tests:** `backend/src/call-end.test.ts`, 6, loading the browser module itself:
  - the ejection and an unclassified daily-error after start → an end;
  - before start → still an error;
  - a network daily-error → the network message;
  - silence by reason or by no transcript → noAudio;
  - limit, normal end and hang-up texts;
  - classify mappings, and generic only for unknown errors.

### D77. Live captions on the voice page (2026-10-01)

- A compact "Live captions" panel, shown once the call starts, lists the **last 3 final lines**: "You:" (the caller's speech as recognised) and "RelayPay:" (the assistant's text as spoken).
  - Lines come from Vapi's client `transcript` messages with `transcriptType: "final"`; partials are never shown.
  - It is not a chat UI: no history, no input.
- **Accessibility:** the list is `aria-live="polite"` and only final lines are ever added. "Hide captions" / "Show captions" toggles the list, with `aria-expanded`.
- **Privacy:** nothing is stored client-side. Lines live in the page and are cleared when a new call starts; the toggle state isn't saved.
- **Style:** the brand palette (primary blue for RelayPay, muted for the caller, teal link-style toggle).
- Checked locally: the page, `/app.js` and `/call-end.js` return 200 with the right types, and the panel markup is served. Live behaviour is to be confirmed on the next call.

### D79. Captions toggle fixed: [hidden] always wins (web page only, 2026-10-01)

- **Bug:** "Hide captions" changed the button label and `aria-expanded` but hid nothing. The list had `hidden` set, but `.captions-lines { display: grid }` in app.css overrides the browser's default `[hidden] { display: none }`.
- **Change:**
  - app.css has a global `[hidden] { display: none !important; }`, which also protects the error box and the other panels from the same trap.
  - The toggle's state (visibility, label, `aria-expanded`) comes from a pure `toggleState` in the new `backend/public/captions.js`, served at `/captions.js`.
- **Tests:** `backend/src/captions.test.ts`:
  - `toggleState` both ways;
  - app.css contains the `[hidden]` rule;
  - the page's toggle starts as "Hide captions" with `aria-expanded="true"` and `aria-controls="captions-lines"`.
- **No agent behaviour changed.**

### D80. Captions keep the whole call, scroll, and merge fragments (web page only, 2026-10-01)

- **Change** (`backend/public/captions.js` + `app.js` + `app.css`):
  - Every final line of the current call is kept, not just the last 3, in a fixed-height (9.5rem) list with its own scrollbar (`overflow-y: auto`). The list is keyboard-focusable.
  - **Auto-scroll** to the newest line only if the reader is already at the bottom (`isNearBottom`, 24 px). If they scrolled up to reread, the panel stays put and a small **"Jump to latest"** button appears. It hides again when they click it or scroll back down.
  - **Consecutive fragments from the same speaker are merged into one line** (`appendFinal`). A live call had one RelayPay sentence split across two caption lines at "corridor—", because Vapi sends a reply as several final transcripts.
  - Nothing is stored: lines live in page memory, are cleared when a new call starts, and are gone on reload.
  - `aria-live="polite"` with `aria-relevant="additions text"`, so a merged line is read when it grows. Only final transcripts are ever rendered.
- **Tests:** `captions.test.ts`:
  - 10 lines are all kept;
  - the live "corridor—" split merges into one line;
  - a new speaker starts a new line;
  - empty text and unknown roles are ignored;
  - near-bottom detection both ways;
  - speaker labels;
  - the stylesheet has a fixed-height scroll area, and the jump button starts hidden.
  - The backend suite has 218 tests, all passing.
- **No agent behaviour changed.**

### D81. Page failures by type: user-fixable, network, our side (web page only, 2026-10-01)

- **Why:**
  - A live call got a `daily-error` 33 s in, mid-call, and the page fell through to generic.
  - An earlier `start-method-error` ("Signaling connection interrupted by a disconnect") showed generic text too.
  - Main messages mixed headlines with SDK jargon.
- **Rule** (`backend/public/call-end.js`). Every failure maps to one group, each with one headline and one next step, and no jargon in the main text:
  - **User-fixable**, "Microphone problem": microphone blocked, a device error, or the page isn't secure.
  - **User-fixable**, "Call ended": no audio heard, meaning Vapi's `silence-timed-out` or `…did-not-receive-customer-audio`, or no caller transcript for 20 s or more. Text: "We couldn't hear you, so the call ended. Check your microphone is selected and unmuted, then try again."
  - **Network**, "Connection problem":
    - Daily or signalling errors, fetch failures and timeouts;
    - a `daily-error` during an active call whose details say nothing more specific (the transport);
    - an ejection with no server-side end reason after the caller had spoken.
    - Text: "Your connection to the call dropped." mid-call, or "We couldn't connect to the voice service." before it, then "Check your internet connection, reload the page, or try a different network."
  - **Our side**, "Something on our side isn't working":
    - `start()` rejected with an HTTP status (4xx/5xx, including credits 402 and auth 401/403);
    - a component load failure (CSP, bundle, SDK import);
    - a missing config;
    - a server-side error ending reason;
    - anything unknown.
    - Text: "Please try again later. If it keeps happening, contact RelayPay support."
  - **Every group** shows a small secondary "Reference: <code>" line (e.g. `daily-error`, `start-method-error-402`, `silence-timed-out`, `ejected-without-reason`) for support. It is never the main message.
  - **Normal endings are not failures:** the caller hung up, the goodbye phrase, or the 4-minute limit → "Call ended" with a neutral text.
- **Diagnosis:** every SDK or browser error is logged to the console via `sanitizeForLog`. Keys like token/key/secret/url/room are redacted, and JWT-looking strings and URLs inside values are masked. A transport ejection is logged with `console.info`.
- **Tests:** `call-end.test.ts`:
  - the live mid-call daily-error → network "dropped";
  - start-method-error signalling → network "couldn't connect";
  - fetch failure → network;
  - 402/401/403/400/500 → our side, with the status in the reference;
  - component and unknown → our side;
  - mic blocked and device → "Microphone problem";
  - no main text contains jargon;
  - ejection is an ending (only after start);
  - normal endings;
  - three no-audio paths;
  - ejection without a reason → network;
  - server error reasons;
  - console sanitising.
  - The backend suite has 225 tests, all passing.
- **No agent behaviour changed.**

### D78. Evidence-free declines get a fixed line per reason: off_topic or not_covered (tone refinement of D67, 2026-10-01)

- **Why:** D67 made every evidence-free decline speak the formal safe-decline line ("I'm sorry, I can't confirm that from our support information…"), including plainly off-topic questions such as the weather. That reads as stiff in a conversation whose tone the user wants kept.
- **Change (a refinement, not a reversal):**
  - The decline header gains `reason=off_topic | not_covered`, chosen by the model (prompt header rules). `parseHeader` reads it. A missing or invalid value is **not_covered**, the safe default.
  - For an **evidence-free** decline (D67's condition, unchanged), the backend speaks a **fixed** line by reason:
    - `off_topic`: "That's outside what I can help with. I can only help with RelayPay payments and accounts. Is there anything RelayPay-related I can help you with?"
    - `not_covered`: the current safe-decline line, unchanged.
  - A decline **with** evidence is unchanged: the model's own words go through the full filter (D58).
  - The off-topic line ends with an anything-else question, so it is in the fast path's fixed anything-else set: a "no thanks" after it is a goodbye (D73).
- **Safety guarantee unchanged:** in an evidence-free decline the model's text is still never spoken. The model only picks which of two fixed lines.
- **Tests:**
  - `tool-grounding.test.ts`, 4:
    - weather + off_topic → the off-topic line;
    - a crypto-style miss + not_covered → the safe line;
    - a missing reason and an invalid reason → the safe line;
    - a decline with evidence → the model's words, not the fixed line.
  - `social-fast-path.test.ts`: "No thanks." / "No, thank you." after the off-topic line → goodbye.
  - The backend suite has 230 tests, all passing.

### D82. Escalation enrichment and the notification outbox (migration 006; Part C step 1, 2026-10-01)

- **Observed (live call `01a0f833…`, 16:02):**
  - The caller gave "tomorrow morning", and the `create_escalation` call carried `preferred_time_text: "tomorrow morning"`.
  - But the stored escalation ESC-F215353A has `preferred_time_text = null`, `call_booked = false`. The tool returned "existing": an earlier, speculative attempt of the same turn had already created the escalation without the time (same idempotency key).
  - Idempotency correctly prevented a duplicate escalation, but the later, fuller call's information was lost.
- **Principle:**
  - Speculative attempts can perform writes before they're replaced (Vapi sends partial transcripts; D28). The attempt guard only stops writes *after* replacement.
  - **Idempotency prevents duplicates; enrichment prevents information loss.**
- **Change** (`db/migrations/006_escalation_enrichment_and_outbox.sql`):
  1. **`create_escalation_with_ticket` v3** (same arguments, now also returns `updated`).
     - When the escalation already exists, it locks the row (`FOR UPDATE`) and fills **only missing fields** from this call: `preferred_time_text` when null, with `call_booked = true` alongside it. A blank time counts as missing.
     - A set value is **never overwritten**.
     - Still inside the attempt guard: a replaced attempt can't enrich.
     - `user_email` is `NOT NULL`, so it is never missing and never enriched. A new escalation is stored with `call_booked` true only when a time is given (D72).
  2. **`conversation_events.event_type`** gains `escalation_updated`.
  3. **`notification_outbox`** for team notifications.
     - One row per ticket created, escalation created and escalation updated, written by the same database function in **the same transaction** as the record, so it exists exactly when the record committed.
     - `dedupe_key` is unique (`escalation_created:ESC-…`, `escalation_updated:ESC-…:preferred_time`, `ticket_created:TKT-…`): a repeat never queues a second message.
     - The payload comes only from the ticket or escalation row: IDs, category, priority, customer ID, reason or summary, preferred time, and the caller's email for escalations. **No amounts or support notes.**
     - Status is pending, sent or failed, with attempts, last error and `sent_at`.
     - RLS on; no access for anon or authenticated; `queue_notification()` is service_role only.
     - **The Discord sender is not built**: rows stay pending.
- **MCP** (`create_escalation`):
  - Reads `updated`. A missing flag counts as false, so the code is compatible with 005 and 006.
  - On an existing escalation it reports the **stored** `call_booked` and `preferred_time_noted`.
  - On enrichment it logs `escalation_updated` best-effort (D68).
- **Tests** (throwaway local Postgres, every migration applied in order; `npm run db:test`): `schema-suite.sh` **156/156** (25 new for 006):
  - a speculative attempt creates without a time → the full attempt with "tomorrow morning" → the same ticket and escalation, created=false, updated=true, still one row, time filled, call_booked true;
  - a later, different time → updated=false and not overwritten;
  - a blank time is stored as NULL;
  - a replaced attempt's enrichment is denied (ATTEMPT_NOT_ACTIVE) and changes nothing;
  - outbox kinds in order: created, updated once, created;
  - the update payload carries the time;
  - no amounts or notes in any payload;
  - one ticket_created notification for a created-then-repeated ticket;
  - duplicate dedupe_key, unknown kind and sent-without-`sent_at` rejected;
  - outbox RLS and privileges;
  - `escalation_updated` accepted as an event type.
  - `race.sh` 5/5 against v3.
  - `test:tools` 69/69 against Supabase **still on 005** (backward compatible).
- **Not yet applied to Supabase:** the user applies 006 in the SQL editor. After that, `test:tools` and a live S7 should be run again.

### D83. Discord team notifications: the outbox sender (Part C step 3, 2026-10-02)

- **What:** `backend/src/discord-notify.ts` posts `notification_outbox` rows (D82) to `DISCORD_WEBHOOK_URL`. No migration: it uses 006's columns as they are.
- **When:**
  - Kicked after each turn is persisted (the tool's ticket or escalation transaction has committed by then).
  - Swept every 60s (`RELAYPAY_DISCORD_SWEEP_MS`) and on startup, for anything still pending.
  - Fire-and-forget; every error is caught and logged. It never blocks or fails a ticket, escalation or turn.
- **No double send:**
  - A row is claimed by a compare-and-set on `attempts` (one `UPDATE … WHERE status = 'pending' AND attempts = n`) before each post, so two sweeps or two replicas (e.g. during a deploy's overlap) never both post it.
  - A sweep only picks up unclaimed rows (`attempts = 0`).
  - A row left mid-send by a crash (pending, `attempts > 0`, older than 10 minutes) is marked failed with "interrupted mid-send; not retried" rather than posted again: a possible miss is better than a double post.
- **Delivery:**
  - Marked `sent` with `sent_at` only on a 2xx (`?wait=true`, so Discord confirms the message).
  - One retry: after a 429 it waits Discord's `retry_after` (body, else the `Retry-After` header; capped at 30s), otherwise 2s. Then `failed` with `last_error`.
  - Each post has a 10s timeout.
- **Content:**
  - `ticket_created`: ID, category, priority, customer ID, summary.
  - `escalation_created` / `escalation_updated`: escalation ID, linked ticket, category, customer ID, reason (on creation), preferred time, call booked, caller email.
  - Built from a **whitelist** of payload fields, so an unexpected field can't leak. Amounts in free text (summary, reason) are masked as `[amount]`. Mentions are disabled (`allowed_mentions: { parse: [] }`).
  - The webhook URL never appears in a log or in `last_error` (scrubbed); only a Discord webhook URL shape is accepted.
- **Message wording (revised 2026-10-02; sender formatting only, no agent change):**
  - Every field is on its own line with a bold label. Discord markdown inside a value is shown literally (escaped).
  - **Customer:** "CUS-1001 (verified on call)". With no customer ID (not verified): "Not verified on this call. Verify identity before discussing the account."
  - **Callback** lines replace "Preferred time" and "Call booked":
    - with a time: `Callback: requested`, then `Caller's preference: "<verbatim>" (said <weekday date, time> WAT)`, then `Action: contact the customer to agree an exact time.` The "said" time is the outbox row's `created_at` in Africa/Lagos.
    - without: `Callback: not requested`.
  - **Why "requested", not "booked":** no slot is actually booked; the caller stated a preference. The database's `call_booked` is unchanged and keeps its PRD meaning (a callback was asked for, with a time). Only the message wording differs.
- **Test conversations are not posted.** Rows from channel `test` conversations (`test:tools`, the eval runner) are marked `sent` with `last_error = 'skipped (not posted): test conversation'`, so only real calls reach the channel. (The status check allows only pending/sent/failed; a separate `skipped` status would need a migration.)
- **Off switch:** without `DISCORD_WEBHOOK_URL` the sender is off, logs once (`discord_notifier_off`), and rows stay pending.
- **Tests:** `backend/src/discord-notify.test.ts`, 13 tests in `test:gate` (243/243). They cover:
  - message content per kind;
  - no amounts or notes (non-whitelisted fields, amounts masked);
  - URL scrubbing and shape check;
  - `retry_after` parsing;
  - sent on 2xx;
  - one retry, then failed;
  - 429 wait and its cap;
  - concurrent sweeps and two notifiers posting each row exactly once;
  - claimed rows not resent and stuck rows failed;
  - test rows skipped;
  - the off switch;
  - a database error never escaping.
- **Live (2026-10-02):**
  - `DISCORD_WEBHOOK_URL` was set by the user in the Railway dashboard. It was never printed.
  - The 10 pre-sender test rows were marked not posted first.
  - ONE row (id 9, `escalation_created` ESC-75639CEF from S7 after5) was sent from a local one-off. Discord returned 2xx, and the row is `sent` with `sent_at`, after 1 attempt.
- **Future work:**
  - **Customer email confirmations:** the caller gets an email with the ticket or escalation reference (outbox kind `customer_confirmation`, and a verified sender domain).
  - **Authenticated login sessions:** a logged-in page would carry the customer's identity into the call, replacing the weak voice identity (F1/F2). See `docs/limitations.md`.

### D84. On-screen "Your references" panel (web page and a read-only endpoint, 2026-10-02)

- **No agent behaviour change:** the prompt, tools, gate and filter are untouched.
- **Endpoint `GET /calls/:callId/records`** (`backend/src/records.ts`), read-only:
  - **Scoped to one call.** `conversation_id` is Vapi's `call.id`, which only the caller's page has (an unguessable UUID returned by `vapi.start()`). Only UUID-shaped IDs reach the database, so `eval-…` and `test-tools-…` conversations can't be read through it.
  - **Returns only references:**
    - tickets `{reference, category (label), follow_up: "A RelayPay support representative will follow up."}`;
    - escalations `{reference, linked_ticket, callback_preference (as noted, or null)}`.
    - An escalation's own ticket appears as its linked ticket, not as a second entry.
  - **Whitelisted output:** no customer ID, name, email, amount, summary, reason, priority or status, whatever the rows hold.
  - **Unknown or malformed call ID:** 200 with the same empty shape (no existence leak). A malformed ID never reaches the database.
  - **Rate limit:** 60 requests per minute per client IP (first `X-Forwarded-For` hop), then 429. Polling every 3s uses 20.
  - **Logging:** a 10-character SHA-256 prefix of the call ID, never the ID.
  - `Cache-Control: no-store` and the page's security headers.
- **Page** (`backend/public/records.js`, pure and unit-tested; wired in `app.js`):
  - Polls every 3s during the call and once 2s after it ends.
  - The panel appears with the first record and stays until reload. References from earlier calls on the same page are kept. Nothing is stored.
  - Each entry has a Copy button. A ticket copies "RelayPay ticket TKT-…: <category>. A RelayPay support representative will follow up."; an escalation copies its reference, linked ticket and callback preference.
  - The button shows "Copied" for 2s ("Copy failed" if the clipboard is unavailable). It's a native button, with the entry's name as screen-reader text.
  - A polite aria-live region announces new references and copies.
  - Brand styling: teal accent, primary titles, full-width buttons on narrow screens.
- **Tests:**
  - `records.test.ts`: scoping, the linked ticket not duplicated, no sensitive fields, unknown and malformed IDs, route matching, the rate limiter, and HTTP 200/429 with the hash-only log.
  - `records-panel.test.ts`: merge and dedupe, malformed responses, copy text, visible lines, the announcement, the poll interval and URL encoding, and the markup.
  - `test:gate` 261/261.
- **Live check pending:** it relies on `vapi.start()` resolving with the call object (`call.id`). If it doesn't, the panel stays hidden; nothing else is affected.

### D85. Future work, not built: authenticated customer sessions and a staff dashboard (2026-10-02)

- **(a) Authenticated customer sessions.**
  - The customer signs in on the web page; the login sets the verified customer on the conversation **before** the call starts, instead of voice verification (name plus company, or a reference: F1/F2).
  - A spoken identity switch during the call ("actually, I'm calling for another account") is **refused**: the session's customer is the only one the call can act on. This extends the one-account-per-call rule (D74) from "first verified" to "signed in".
  - Ticket and escalation confirmations go to the **account's verified email** (never one spoken on the call) through a **second outbox channel**: a new `notification_outbox` kind, e.g. `customer_confirmation`, sent by its own sender with a verified sender domain. The team channel (Discord, D83) is unchanged.
- **(b) Staff dashboard.**
  - Behind staff login and authorisation (roles; every read checked server-side).
  - Tickets and scheduled callbacks shown as cards, filterable by type (raised tickets / scheduled callbacks), reading the existing `support_tickets` and `escalations` tables. No schema change is needed for a first version.
  - **Why it wasn't built:** it exposes customer PII (names, emails, account and callback details). Today's staff surface is Discord messages with no amounts or notes (D83); a dashboard needs real staff authentication and authorisation first, which didn't fit this week. The customer-facing panel (D84) shows references only, for that reason.
- **No code** for either when recorded; recorded in `docs/limitations.md`.
- **Update (2026-10-02, submission day):** parts are now being built behind flags, with a feature freeze at 4pm. Anything not complete and tested by then stays off and remains future work here.
  - **L1** (D86): enforced customer login for calls (`CUSTOMER_LOGIN_REQUIRED`).
  - **L2**: the staff dashboard (`STAFF_DASHBOARD_ENABLED`), if time allows.
  - **L3**: a login mapped to a customer sets the verified customer at the start of the call (D74 then refuses a spoken switch), only if L1 and L2 are done.
  - Still future work regardless: confirmations to the account's verified email through a second outbox channel.

### D86. L1: enforced customer login for calls (flag `CUSTOMER_LOGIN_REQUIRED`, migration 007; 2026-10-02)

- **Scope:** the voice agent's prompt, tools, gate and filter are unchanged. Voice identity rules are unchanged: a logged-in general customer still verifies by voice, so S1–S8 behave as before.
- **Accounts** (Supabase Auth, created by the user): `customer@relaypay.example` (role customer), `care@relaypay.example` (role staff), `amara@lagosledger.example` (role customer, `customer_id` CUS-1001, for L3).
  - Roles are set in `app_metadata` through the admin API; users can't edit it.
- **Page:**
  - A login form (Supabase Auth in the browser with the **publishable** key only; the session in `sessionStorage`, this tab only), "Signed in as …" and Log out.
  - The browser never reads tables: RLS is on everywhere, with no policies.
  - When the session ends without a logout (refresh failed, revoked, or `/calls/pass` returns 401): back to the login form with "Your session has expired. Please log in again."
  - The Supabase origin is listed in CSP `connect-src`.
- **`POST /calls/pass`** (Authorization: Bearer access token), served only while the flag is on:
  - The backend verifies the token with Supabase (`auth.getUser`) and requires `app_metadata.role` customer or staff. Otherwise 401 (no or invalid session) or 403 (role).
  - It returns a **one-time pass**: 32 random bytes, base64url. Only its SHA-256 is stored, in `call_passes`, with the user ID, role, the `customer_id` mapping and a 5-minute expiry from the database clock.
  - Rate-limited to 10 per minute per client IP. Logs carry a short hash of the user ID, never the token or the pass.
- **Carrying the pass:** the page starts the Vapi call with `assistantOverrides.variableValues.callPass`.
  - It reaches the backend as `call.assistantOverrides.variableValues.callPass`. Evidence: a live Custom LLM request body (2026-09-29, the D28 structure log) contained `call.assistantOverrides.variableValues`.
  - Each first check logs `pass_source` (the path, never the value) to confirm it on the first live call.
- **Every turn:** `redeem_call_pass(conversation, sha256(pass))` (migration 007, row lock):
  - unused and unexpired → marked used and linked to the conversation;
  - already linked → ok, so later turns and Vapi's speculative retries of turn 0 need no pass;
  - missing, forged, expired, or reused by another conversation → the fixed line **"Please log in on the RelayPay page to use voice support."**, spoken with no agent run (before the social fast path) and recorded as `answer_type` error, status reason `login_required`.
  - A database failure in the check speaks the usual fallback line (`login_check_failed`), never a misleading login prompt.
  - An ok conversation is cached in memory, so later turns don't wait on the database.
- **Tests:**
  - Local Postgres: `schema-suite.sh` **180/180** (24 new). They cover:
    - valid → linked;
    - a later turn without a pass, and a retry with the same pass → ok;
    - reused on another conversation, missing, forged, malformed, expired (not marked used);
    - the mapped `customer_id`;
    - a second pass on a linked conversation stays unused;
    - constraints: role, hash shape, expiry ≤ 10 minutes, unknown customer, used without a conversation, one pass per conversation;
    - RLS and privileges.
  - `race.sh` **6/6**, including two concurrent conversations redeeming one pass: exactly one gets it.
  - Unit (`login.test.ts`, `auth-page.test.ts`), 274/274 in `test:gate`:
    - pass extraction;
    - roles only from `app_metadata`;
    - only the hash sent;
    - ok cached and failures not;
    - `/calls/pass` 200 (hash stored, nothing sensitive logged), 401, 403, 429;
    - the denied turn (login line, `error`/`login_required`, no model, the admission slot never requested);
    - page messages and markup.
  - Live: `npm run test:login` (deployed, flag on) and S1, S3, S7 ×1 with `eval-scenarios --login-email` (real passes). Pending: 007 to be applied.

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
- 006 applied to Supabase from commit 015702d on 2026-10-01. The file is wrapped in `begin;` … `commit;`, like 001–005.
  - User-verified after applying: RLS is true on `notification_outbox`.
  - EXECUTE on `queue_notification`, `create_support_ticket_guarded` and `create_escalation_with_ticket` (v3) is held by `service_role` and not by `anon`.
- 007 applied to Supabase from commit 6d5ba75 on 2026-10-02. The file is wrapped in `begin;` … `commit;`.
  - User-verified after applying: RLS is true on `call_passes`; EXECUTE on `redeem_call_pass` is held by `service_role` and not by `anon`.

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
