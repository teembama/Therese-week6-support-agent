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

### D33. Deployment region: Fly.io `fra`, next to Supabase `eu-central-1` (Batch 2D)

- The Supabase project's region is **eu-central-1** (Frankfurt), per the user on 2026-09-29.
- The backend will be deployed to **Fly.io region `fra`** in Batch 2D, to test D24's hypothesis that most of the latency tail and the Supabase stalls come from running on a laptop far from the database.
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

## Migration log

- 001 applied to Supabase from commit ab76cb5 (ab76cb506e025890454c3a8c61c06291e85f21b9) on 2026-09-29.
  - User-verified after applying: RLS is true on all 11 tables. `create_escalation_with_ticket` EXECUTE is held only by `postgres` and `service_role`.
- 002 applied to Supabase from commit b4646bf (b4646bf28eedbdd90e3b19df072e49eba36906fd) on 2026-09-29.
  - User-verified after applying: `search_kb` EXECUTE is held only by `postgres` and `service_role`.
- 003 applied to Supabase from commit 485387c on 2026-09-29.
  - User-verified after applying: EXECUTE on `begin_turn_attempt`, `finish_turn_attempt`, `attempt_is_active`, `require_active_attempt` and `recompute_conversation_totals` is held only by `postgres` and `service_role`.
- 004 applied to Supabase from commit 8144fcc on 2026-09-29.
  - User-verified after applying: `conversation_turns_answer_type_check` lists all 7 values, including `'social'`.

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
