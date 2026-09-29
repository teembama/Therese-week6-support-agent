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

## Migration log

- 001 applied to Supabase from commit ab76cb5 (ab76cb506e025890454c3a8c61c06291e85f21b9) on 2026-09-29.
  - User-verified after applying: RLS is true on all 11 tables. `create_escalation_with_ticket` EXECUTE is held only by `postgres` and `service_role`.
- 002 applied to Supabase from commit b4646bf (b4646bf28eedbdd90e3b19df072e49eba36906fd) on 2026-09-29.
  - User-verified after applying: `search_kb` EXECUTE is held only by `postgres` and `service_role`.

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
