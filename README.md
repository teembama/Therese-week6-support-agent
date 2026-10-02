# RelayPay Voice Support Agent

A voice customer-support agent for RelayPay, a (fictional) cross-border payments company. You talk to it in the browser:
- it answers from an approved knowledge base;
- it looks up customers, transactions and payouts through a custom MCP server;
- it creates support tickets and human escalations in Supabase.

Everything it says passes a grounding gate in code before it is spoken.

**Live:** https://relaypay-backend-production-aa34.up.railway.app: a landing page with **Customer support** (the call page, `/support`: choose a path, click **Start call** and allow the microphone) and **Staff** (`/staff`).

### Starting a call (graders)

The call page offers two paths (D88). Choose one, then press **Start call**.
- **I'm an existing customer:** enter the account's contact name and email. Demo customer: **Amara** (or **Amara Okafor**), **amara@lagosledger.example**. The call is identified as that customer (LagosLedger, CUS-1001) from its first turn and greets you by first name. Claiming to be someone else during the call is refused: one account per call.
  - Details that don't match one customer get "We couldn't find an account matching those details." (it never says which detail was wrong), and no call starts.
- **Continue as a guest:** the call behaves exactly as the PRD describes. The agent asks who you are and checks two details by voice (for example "I'm Amara from LagosLedger"). After a guest call that checked an identity, the page suggests the existing-customer path next time.

**What this enforces (and what it doesn't):**
- Every call needs a **one-time call pass** from the backend, issued just before the call starts. It expires after 5 minutes and works for **one call only**. A call without a valid pass hears "Please log in on the RelayPay page to use voice support." and nothing else: the agent doesn't run.
- The existing-customer path is **identification, not authentication**: a name and an email aren't secrets. Real customer authentication (a login or an emailed code) is future work (docs/limitations.md).
- The form's details are sent once, to get the pass. Nothing is stored in the browser, and the browser never reads the database.

### Staff dashboard (graders)

- **URL:** `/staff` on the live service (https://relaypay-backend-production-aa34.up.railway.app/staff). **Staff account:** `care@relaypay.example`; the password is provided separately in the submission.
- **Read-only.** Two filters: **Raised tickets** (tickets without an escalation) and **Scheduled callbacks** (escalations with a callback time). Press **Refresh** for new records.
- **Real calls only by default.** Add `?include_test=1` to the URL to include test and eval data: `/staff?include_test=1`.
- Only staff accounts can see it; a customer account gets "This account isn't staff." It shows no support notes and no amounts (D87).

---

## Architecture

```
 Browser page (/)          Vapi (speech-to-text, text-to-speech, turn-taking)
 @vapi-ai/web  ─────────►  Custom LLM: POST /v/<token>/chat/completions  ──┐
                           Webhook:    POST /v/<token>/vapi/events      ──┤
                                                                         ▼
                          Backend (Node 22, Railway EU West)
                          ├─ social fast path (thanks / goodbye / declined offer: fixed lines, no model)
                          ├─ admission (≤ 3 agent turns per process; otherwise a busy line)
                          ├─ pre-turn: register attempt + retrieve KB chunks (Supabase full-text search)
                          ├─ Claude Agent SDK (Haiku 4.5) ── stdio ──► MCP server (6 tools) ──► Supabase
                          └─ grounding gate: header check + per-sentence filter ──► SSE back to Vapi
                                                                         │
                          Supabase (Postgres, eu-central-1): seed data, KB, every turn, attempt,
                          retrieval, tool call, ticket, escalation, event and evaluation
```

| Component | Where | What it does |
| --- | --- | --- |
| Voice page | `backend/public/` | A static page served at `/`. It starts a Vapi web call with the public key and assistant ID from `/config`. |
| Vapi assistant | Vapi dashboard | Speech-to-text (Soniox), text-to-speech and endpointing. Its "Custom LLM" is our backend. **Vapi runs no tools.** |
| Backend | `backend/` | The OpenAI-compatible `/chat/completions` endpoint for Vapi. It runs one agent turn per request (Claude Agent SDK), gates what is spoken, records everything, and handles the end-of-call webhook. |
| MCP server | `mcp-server/` | A stdio MCP server, spawned per turn, with 6 tools: `lookup_customer`, `lookup_transaction`, `lookup_payout`, `create_support_ticket`, `create_escalation`, `log_conversation_event`. Identity, ownership, write caps and idempotency are enforced here and in the database, not by the model. |
| Shared | `shared/` | Supabase client, retrieval, grounding checks, logging helpers. |
| Database | `db/migrations/001–005` | Tables, row-level security, and guarded write functions (atomic escalation with its ticket, attempt-scoped writes). |
| Scripts | `scripts/` | Seed verification, tests, evals, and the MCP Inspector launcher. |

The full design is in [docs/system-overview.md](docs/system-overview.md), and every decision with its reason is in [docs/decisions.md](docs/decisions.md).

---

## Prerequisites

- **Node.js 22** (`node --version` should print v22.x).
- A **Supabase** project. You need its URL and the **service role (secret) key**, which is server-side only.
- An **Anthropic API key** (the agent uses `claude-haiku-4-5`, with a fallback to `claude-sonnet-5-5`).
- A **Vapi** account with one assistant, plus its **public key** and **assistant ID**.
- For deploying: a **Railway** account and the Railway CLI.
- For `npm run db:test` only: local PostgreSQL binaries (`initdb`, `pg_ctl`, `psql`).

## Setup (local)

1. **Clone and install**
   ```bash
   git clone https://github.com/teembama/Therese-week6-support-agent.git
   cd Therese-week6-support-agent
   npm ci
   ```
2. **Environment.** Copy the template and fill in the values. Never commit `.env`.
   ```bash
   cp .env.example .env
   ```
   Required:
   - `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`;
   - `ANTHROPIC_API_KEY`;
   - `VAPI_LLM_SECRET`: at least 32 URL-safe characters, e.g. `openssl rand -base64 48 | tr '+/' '-_' | tr -d '='`;
   - `AGENT_MODEL=claude-haiku-4-5`, `AGENT_MODEL_FALLBACK=claude-sonnet-5-5`;
   - `VAPI_PUBLIC_KEY`, `VAPI_ASSISTANT_ID`.

   Login (D86): `SUPABASE_PUBLISHABLE_KEY` (the project's publishable key) and `CUSTOMER_LOGIN_REQUIRED=1` to enforce it. Accounts are Supabase Auth users with `app_metadata.role` = `customer` or `staff`, set through the admin API. With the flag off, calls need no login.

   Optional: `DISCORD_WEBHOOK_URL` turns on team notifications in Discord for new tickets and escalations (D83). Without it, the sender stays off and rows stay pending.

   The `RELAYPAY_*` variables are test knobs: leave them at their defaults.
3. **Apply the migrations in order.** In the Supabase dashboard, open **SQL Editor** and run each file's full contents, one at a time, **in this order**:
   1. `db/migrations/001_schema.sql`
   2. `db/migrations/002_search_kb.sql`
   3. `db/migrations/003_turn_attempts.sql`
   4. `db/migrations/004_social_answer_type.sql`
   5. `db/migrations/005_guarded_writes_and_events.sql`
   6. `db/migrations/006_escalation_enrichment_and_outbox.sql`
   7. `db/migrations/007_call_passes.sql`

   Migrations are append-only: never edit one that has been applied.
4. **Seed the business data** (customers, transactions and payouts from `assets/seed-data/*.csv`; upserts, so it's safe to rerun):
   ```bash
   npm run db:seed
   ```
5. **Verify the seed** (read-only: row counts, no orphans, the scenario fixtures):
   ```bash
   npm run db:verify      # ends with "VERIFY OK"
   ```
6. **Load the knowledge base** (`assets/relaypay-knowledge-base.md` → `kb_chunks`, about 37 chunks; it syncs, so reruns don't duplicate):
   ```bash
   npm run db:load-kb
   ```
7. **Run the backend**
   ```bash
   npm run build
   npm start -w @relaypay/backend      # http://localhost:8787 (PORT to change)
   ```
   Check it: `curl http://localhost:8787/health` → `{"status":"ok"}`.

   The voice page at `http://localhost:8787/` only works if Vapi can reach your backend over the internet, and a laptop on a home or office network usually isn't reachable from outside. Either expose it through a tunnel and point Vapi's URLs at the tunnel (see Troubleshooting), or use the deployed service.

## Run the MCP server standalone (MCP Inspector)

The MCP server is a stdio server that needs Supabase credentials and a registered conversation and attempt, because its writes are attempt-guarded. `scripts/inspector-server.mjs` sets those up:
- it reads `.env` itself, so no secret goes on the command line;
- it removes `ANTHROPIC_API_KEY`, which the server refuses to start with;
- it creates a fresh `test-inspector-…` conversation with an active attempt, then starts the server.

```bash
npm run build

# Interactive UI (opens in the browser):
npx @modelcontextprotocol/inspector node scripts/inspector-server.mjs

# Command line:
npx @modelcontextprotocol/inspector --cli node scripts/inspector-server.mjs --method tools/list
npx @modelcontextprotocol/inspector --cli node scripts/inspector-server.mjs --method tools/call --tool-name lookup_transaction --tool-arg transaction_id=TXN-9001
npx @modelcontextprotocol/inspector --cli node scripts/inspector-server.mjs --method tools/call --tool-name lookup_customer --tool-arg contact_name=Amara --tool-arg company_name=LagosLedger
```

- **Environment it uses** (from `.env`): `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`. `CONVERSATION_ID`, `TURN_INDEX` and `ATTEMPT_ID` are set by the launcher.
- **Where the calls are recorded:** every call is a row in `tool_calls` under the printed `test-inspector-…` conversation.
- **Things to try:**
  - `lookup_customer` with a single identifier → `needs_second_identifier`;
  - `lookup_transaction` for `TXN-9003` after verifying as Amara → `not_available` (another customer's record);
  - `create_support_ticket` three times → the third is `conversation_write_limit`.

## Connect Vapi

In the Vapi dashboard, on the assistant:

| Setting | Value |
| --- | --- |
| Model provider | **Custom LLM** |
| Custom LLM URL (a *base* URL; Vapi appends `/chat/completions`) | `https://<your-host>/v/<VAPI_LLM_SECRET>` |
| Server URL (webhook) | `https://<your-host>/v/<VAPI_LLM_SECRET>/vapi/events` |
| Server messages | `end-of-call-report` is the one we use. If the dashboard shows no selector, Vapi's default list is fine: other types are acknowledged and ignored. |
| Metadata send mode | **Variable** (so `call.id` arrives in the body) |
| End call phrases | `Thanks for calling RelayPay. Goodbye.` (our fixed goodbye line) |
| Tools / knowledge base | **None.** Vapi must not run tools; the backend does. |
| Public key | Restricted to this assistant, transient assistants **off**, allowed origin = your deployed `https://` origin |

- **The token is in the path.** A wrong token gets the same 404 as an unknown path. Rotate `VAPI_LLM_SECRET` after demos, then update the Vapi URLs to match.
- **The end-call phrase has never been seen to fire.** Calls so far ended `customer-ended-call`. See docs/next-session.md for backend-side alternatives.

## Deploy to Railway

`railway.json` and the `Dockerfile` define the service:
- Node 22 slim image, non-root user, `/health` healthcheck;
- restart on failure;
- 1 replica in `europe-west4-drams3a` (EU West, next to Supabase Frankfurt);
- `drainingSeconds: 15`, so the SIGTERM drain can finish. Railway's default is 0.

```bash
railway login
railway init                                  # or: railway link (existing project)
# Set each variable through stdin so values never appear on a command line:
railway variable set SUPABASE_URL --stdin --skip-deploys
railway variable set SUPABASE_SERVICE_ROLE_KEY --stdin --skip-deploys
railway variable set ANTHROPIC_API_KEY --stdin --skip-deploys
railway variable set VAPI_LLM_SECRET --stdin --skip-deploys
railway variable set AGENT_MODEL --stdin --skip-deploys
railway variable set AGENT_MODEL_FALLBACK --stdin --skip-deploys
railway variable set VAPI_PUBLIC_KEY --stdin --skip-deploys
railway variable set VAPI_ASSISTANT_ID --stdin --skip-deploys
railway up --detach
railway domain                                # the public https origin
```

- **Check the region.** The first deploy once ignored the file's region. Confirm with `railway status --json` (`multiRegionConfig` should show `europe-west4-drams3a: 1`). If it's wrong: `railway scale eu-west=1 us-west=0`.
- **Keep one replica.** Duplicate-request joining is in-process (docs/limitations.md).
- **Smoke test:** `npm run test:deployed -- --base-url https://<domain> --kb-runs 3 --s4-runs 3`.

## Tests and evals

| Command | What it checks | Writes to Supabase? | Spends money? |
| --- | --- | --- | --- |
| `npm run test:gate -w @relaypay/backend` | Backend unit tests: gate, sentence filter, social fast path, admission, webhook mapping (193) | No | No |
| `npm test -w @relaypay/mcp-server`, `npm test -w @relaypay/shared` | MCP tool and shared-helper unit tests | No | No |
| `npm run db:test` | 131 schema checks + a concurrent-escalation race test, on a **throwaway local Postgres** (refuses non-localhost) | No | No |
| `npm run db:verify` | Seed integrity | Read-only | No |
| `npm run test:tools` | The 6 tools through the real MCP server: identity, ownership, caps, idempotency, guard | Yes (`test-` rows) | No |
| `npm run test:mcp` | MCP server start-up and env rules through the real MCP client | Yes (`test-` rows) | No |
| `npm run eval:retrieval` | Retrieval ranks for the scenario questions | Yes (retrieval logs) | No |
| `npm run test:capacity` | Concurrency cap and graceful shutdown on a local backend | Yes | ~$0.03 (model) |
| `npm run test:agent` | Scenario conversations through a local backend, with assertions (cap $0.15) | Yes | ≤ $0.15 |
| `npm run test:endpoint` | End-to-end endpoint behaviour, fault injection, latency (local servers) | Yes | a few cents |
| `npm run test:deployed -- --base-url …` | The deployed service: routes, webhook, logs, latency | Yes | ≤ $0.15 |
| `npm run eval:grounding` | The deterministic grounding checks on fixed questions | Yes | a few cents |
| `npm run test:callpass` | The call page's two paths on the deployed service: form-Amara verified from turn 0 and a spoken identity switch refused; wrong email / wrong name / unknown → the identical 422; guest; the rate limit | Yes (`test-callpass-` rows) | ~$0.02 |
| `npm run eval:scenarios -- --cap 0.50` | **PRD scenarios ×3 + security + robustness against the deployed service, with deterministic DB checks and an LLM judge with verified quotes; writes `evaluations`**. With call passes enforced, add `--path guest` (or `--path customer --form-name Amara --form-email amara@lagosledger.example`): every conversation gets a real one-time pass from the deployed `/calls/pass` | Yes | ~$0.45 |

`npm run test:login` is **retired**: it tested the customer Supabase login (L1, D86), which was removed from the call page in L1b (D88), and its demo customer accounts were deleted on 2026-10-02.

Results: [docs/testing-evidence.md](docs/testing-evidence.md) (BEFORE 15/34 → AFTER 31/34, plus a targeted after2 run).

## Security notes

- **Secrets stay server-side.**
  - The Supabase service role key and the Anthropic key are only in the backend's environment.
  - The agent's CLI process gets only the Anthropic key. The MCP process gets only Supabase credentials and the conversation, turn and attempt IDs; it refuses to start if the Anthropic key is present.
  - `/config` serves only the Vapi **public** key and assistant ID, plus the Supabase URL and **publishable** key when login is on.
- **Call passes (D86, D88):** 32 random bytes, stored only as SHA-256, valid 5 minutes, redeemed once (row lock), and never logged. The existing-customer path matches name AND email to one customer and answers every mismatch identically; it is identification, not authentication. A matched call's customer is set from the pass, never from the caller's words. `/calls/pass` is rate-limited. Staff roles come only from Supabase `app_metadata`, verified by the backend.
- **The endpoint token is in the URL path**, compared in constant time. Request paths are redacted in logs. Rotate it after demos.
- **The agent has no built-in tools** (no shell, files or web), only the 6 MCP tools. A tool-list guard fails the turn if the set differs (D21).
- **Sensitive data:**
  - Tools never return amounts, currency, stored emails or support notes.
  - Once a caller is verified, another customer's reference gets the same "not available" answer as a missing one (D44/D57).
  - Identity takes two identifiers and is stored server-side. Name plus company is accepted, as Scenario 3 requires, and verification unlocks no sensitive data (D63).
- **Grounding:** every non-social reply is filtered sentence by sentence against this turn's evidence before it's spoken. Known gap: a number-free unsupported claim in an answer (docs/limitations.md).
- **The web page:** strict CSP (`'unsafe-eval'` and `blob:` only because Vapi/Daily need them), no inline scripts, `frame-ancestors 'none'`.

## Troubleshooting

- **The agent hears itself (echo).** Use earphones: laptop speakers can feed the agent's voice back into the microphone, and it is then transcribed as the caller (smoke test: the agent's own "While I check that—" came back as a caller turn).

| Symptom | Cause we hit | Fix |
| --- | --- | --- |
| The call starts, then "Meeting ended due to ejection"; Vapi records `silence-timed-out` or `…did-not-receive-customer-audio` | The browser sent no audio: the CSP blocked Daily's noise-filter worklet (`blob:`) or bundle (`eval`) (D55), or the wrong mic or output device was selected | Check Chrome's console for CSP errors. Use the built-in mic and speakers, disconnect Bluetooth headsets, and close other apps using the mic (Zoom, Teams, WhatsApp, other tabs). The page's error box gives the same steps. |
| "Microphone access is blocked" | Site permission denied | Click the padlock in the address bar → Microphone → Allow, then reload. |
| "The call couldn't start because the voice component failed to load" | A CSP violation or SDK load failure on our side | See D55. `/csp-report` records violations. |
| `fetch failed` / `ENOTFOUND` from scripts on a laptop | Intermittent local DNS | Retry. `eval:scenarios` retries connect-level errors itself. It isn't a server problem: check `/health`. |
| Vapi says the LLM failed (`pipeline-error-custom-llm-…`) after a restart | When developing locally through a tunnel, **the tunnel URL changes on every restart**, so Vapi still points at the old one | Update the assistant's Custom LLM URL and Server URL to the new tunnel URL (keep the `/v/<token>` path), or use the deployed service. |
| Every reply is "Sorry, I'm having trouble checking that right now…" | Supabase or Anthropic unreachable, or the MCP server failed the tool-list guard | Check `conversation_turns.confidence_note` for the turn, and the deploy logs (`event="turn"`, `request_error`). |
| "We're getting a lot of calls right now…" | More than 3 agent turns at once in one process (D59), or the process is shutting down (D60) | Expected under load. Raise `RELAYPAY_MAX_CONCURRENT_TURNS` only with more memory per replica. |

## Docs

| File | What's in it |
| --- | --- |
| [docs/one-page.md](docs/one-page.md) | One-page guide to operating the system |
| [docs/system-overview.md](docs/system-overview.md) | Full current-state architecture, data, security, reliability, cost and testing |
| [docs/testing-evidence.md](docs/testing-evidence.md) | PRD test table, BEFORE/AFTER eval runs, live calls, logging and latency evidence |
| [docs/decisions.md](docs/decisions.md) | Every decision (D1–D69): what was observed, what changed, why |
| [docs/limitations.md](docs/limitations.md) | Known limitations and future work |
| [docs/latency.md](docs/latency.md) | Latency measurements, laptop vs deployed, and the init regression |
| [docs/model-choice.md](docs/model-choice.md) | Why Haiku 4.5 |
| [docs/retrieval-eval.md](docs/retrieval-eval.md), [docs/grounding-eval.md](docs/grounding-eval.md) | Retrieval and grounding evaluations |
| [docs/loom-script.md](docs/loom-script.md) | The demo script |
| [docs/next-session.md](docs/next-session.md), [docs/pre-submission-checklist.md](docs/pre-submission-checklist.md) | Open items |
| [docs/assignment-brief.md](docs/assignment-brief.md) | The original assignment brief (formerly this README) |
| `PRD.md`, `assets/` | The product requirements and the source material: KB, rules, tool spec, schema, seed data, test scenarios |
