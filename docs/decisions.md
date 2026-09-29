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
