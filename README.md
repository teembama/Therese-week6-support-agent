# RelayPay Voice Support

A browser voice agent for a fintech help desk: it answers from approved policy, checks account records and books a human callback when a case needs one. RelayPay is a fictional cross-border payments company.

<!-- SCREENSHOT + DEMO VIDEO: added in the second pass -->

**Stack:** Claude Agent SDK · MCP · Vapi · Supabase · TypeScript · Docker · **Live demo:** available on request

## The problem

A fintech help desk answers the same policy and account questions all day. A voice agent could take that load, but a voice agent that guesses can tell a caller something the policy doesn't say, about their money, out loud, with no chance to edit it first. In a regulated business that's worse than no answer at all.

## Results

- **Evaluations went from 15/34 to 31/34 passing** (the 8 product scenarios ×3, plus 5 security and 5 robustness cases) against the deployed service, with database checks and an LLM judge whose quotes are verified in code. The 8 scenarios alone went from 11/24 to 21/24.
- **About 1.4 s to the first spoken sentence** (median, deployed, measured server-side). Across 4 live calls, Vapi measured 3.0–5.4 s on average from the caller's end of speech to the agent's audio, including transcription and speech synthesis.
- **About $0.003 of model spend per turn.** Each turn is capped at $0.05 and 4 model turns, with at most 3 turns running at once.
- **31 test files** hold 355 backend unit tests, 42 MCP server tests and 28 shared-helper tests, all passing. A separate database suite runs 219 checks on a throwaway local Postgres, all passing, plus a concurrent-write race test. Eval results and run IDs are in [docs/testing-evidence.md](docs/testing-evidence.md).

## What it does

From the landing page, a caller chooses **Customer support**, picks how to identify themselves, and presses **Start call** (allowing the microphone). They hear a ringback tone while the call connects.

- **Existing customer:** the caller enters the account's contact name and email. The call is identified as that customer from its first turn, and greets them by first name. Claiming to be someone else mid-call is refused. Details that don't match exactly one customer get the same answer whichever detail was wrong, and no call starts.
- **Guest:** the agent asks who the caller is and checks two details by voice. To look up a transaction or payout, a guest also needs the owner's customer ID. A wrong ID gets the same answer as an unknown reference, and lookups stop after 2 failures in a call.

During the call the agent:

- **answers policy questions** from an approved knowledge base;
- **looks up customers, transactions and payouts**, returning only customer-safe details (never amounts, stored emails or support notes);
- **creates support tickets and escalations**;
- **books a real callback slot** when a specialist is needed. Slots run Monday to Friday, every 30 minutes from 9:00 to 16:30 Lagos time, and a taken slot is never offered. A weekend, out-of-hours or vague time ("tomorrow morning") is refused with the reason and three free slots to choose from.

Staff sign in at `/staff` to see raised tickets and scheduled callbacks (sorted by slot time) and to close them, which frees the callback slot. New tickets and escalations can also post to a Discord channel.

## How it works

```
 Browser page              Vapi (speech-to-text, text-to-speech, turn-taking)
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
                          Supabase (Postgres, eu-central-1): seed data, knowledge base, and every turn,
                          attempt, retrieval, tool call, ticket, escalation, event and evaluation
```

| Component | Where | What it does |
| --- | --- | --- |
| Web pages | `backend/public/` | The landing page (`/`), the call page (`/support`, which gets a one-time call pass and then starts a Vapi web call) and the staff dashboard (`/staff`). |
| Vapi assistant | Vapi dashboard | Speech-to-text, text-to-speech and turn-taking. Its "Custom LLM" is this backend. **Vapi runs no tools.** |
| Backend | `backend/` | The OpenAI-compatible `/chat/completions` endpoint Vapi calls. It runs one agent turn per request, gates what is spoken, records everything and handles the end-of-call webhook. |
| MCP server | `mcp-server/` | A stdio MCP server, started per turn, with 6 tools: `lookup_customer`, `lookup_transaction`, `lookup_payout`, `create_support_ticket`, `create_escalation`, `log_conversation_event`. Identity, ownership, write caps and idempotency are enforced here and in the database, not by the model. |
| Shared | `shared/` | Supabase client, retrieval, grounding checks and logging helpers. |
| Database | `db/migrations/001–009` | Tables, row-level security, guarded write functions, escalation details and the notification outbox, one-time call passes, and callback slots with no double booking. |
| Scripts | `scripts/` | Seed verification, tests, evals and the MCP Inspector launcher. |

The full design is in [docs/system-overview.md](docs/system-overview.md), and every decision with its reason is in [docs/decisions.md](docs/decisions.md).

## Design decisions

- **Nothing is spoken until code checks it.** Every non-social reply must cite knowledge-base passages the agent actually retrieved this turn, and each sentence is filtered again before it's spoken. A dropped sentence is safer than a spoken unsupported claim.
- **The rules live in the tools and the database, not the prompt.** The MCP tools enforce identity, record ownership, write caps and idempotency. Once a caller is verified, another customer's reference gets the same "not available" answer as a missing one.
- **Every call needs a one-time pass.** The backend issues it just before the call starts. It expires after 5 minutes, works for one call only, and is stored only as a hash. Without one, the agent doesn't run.
- **Caller words are data, never instructions.** Caller text is escaped and marked untrusted. The agent has no built-in tools (no shell, files or web), only the 6 MCP tools, and a guard fails the turn if that set ever differs.
- **Bounded cost and load.** Each turn is capped at $0.05 and 4 model turns, with at most 3 turns at once and a polite busy line beyond that. Thanks, goodbyes and declined offers get fixed lines without calling the model at all.
- **Secrets stay server-side.** The browser gets only the Vapi public key and assistant ID (plus the Supabase publishable key for staff sign-in), never the database.

## Limitations

- **The existing-customer path is identification, not authentication.** A name and an email aren't secrets. The path unlocks no sensitive data, but real customer authentication (a login or an emailed code) is still to do.
- **Grounding has one known gap.** In an answer citing a valid passage, a plausible claim with no number in it can slip past the pattern checks. The offline LLM judge catches it, but there's no runtime judge, because it would add about 0.6–1.2 s before the first word.
- **Short customer IDs:** a guest needs the owner's customer ID to look something up, but those IDs are short, so they aren't secrets either.
- **One replica only.** Duplicate-request handling is in-process, so the service mustn't be scaled out as it stands.
- **The callback calendar is simple:** one shared team calendar and fixed 30-minute slots, with no public holidays excluded.
- **Calls end when the caller hangs up.** Vapi's end-call phrase doesn't fire on the goodbye line, so a backend-driven hang-up is future work.
- **The model needs replacing soon.** Claude Haiku 4.5 has a retirement floor of 2026-10-15. The model is set by environment variable, with an automatic fallback to `claude-sonnet-5-5`.

Everything else, with the reasoning, is in [docs/limitations.md](docs/limitations.md).

## Run it locally

### Prerequisites

- **Node.js 22** (`node --version` should print v22.x).
- A **Supabase** project. You need its URL and the **service role (secret) key**, which is server-side only.
- An **Anthropic API key** (the agent uses `claude-haiku-4-5`, with a fallback to `claude-sonnet-5-5`).
- A **Vapi** account with one assistant, plus its **public key** and **assistant ID**.
- For deploying: a **Railway** account and the Railway CLI.
- For `npm run db:test` only: local PostgreSQL binaries (`initdb`, `pg_ctl`, `psql`).

### Setup

1. **Clone and install.**
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

   Optional:
   - `STAFF_DASHBOARD_ENABLED=1` and `SUPABASE_PUBLISHABLE_KEY` (the project's publishable key) turn on `/staff`.
   - `DISCORD_WEBHOOK_URL` turns on Discord notices for new tickets and escalations. Without it, the sender stays off and notices stay pending.
   - Leave `CUSTOMER_LOGIN_REQUIRED=0` (a customer login flow the call page no longer uses) and the `RELAYPAY_*` test settings at their defaults.
3. **Apply the migrations in order.** In the Supabase dashboard, open **SQL Editor** and run each file's full contents, one at a time, **in this order**:
   1. `db/migrations/001_schema.sql`
   2. `db/migrations/002_search_kb.sql`
   3. `db/migrations/003_turn_attempts.sql`
   4. `db/migrations/004_social_answer_type.sql`
   5. `db/migrations/005_guarded_writes_and_events.sql`
   6. `db/migrations/006_escalation_enrichment_and_outbox.sql`
   7. `db/migrations/007_call_passes.sql`
   8. `db/migrations/008_call_pass_sources.sql`
   9. `db/migrations/009_callback_slots.sql`

   Migrations are append-only: never edit one that has been applied.
4. **Seed the business data:** customers, transactions and payouts from `assets/seed-data/*.csv`. It upserts, so it's safe to rerun.
   ```bash
   npm run db:seed
   ```
5. **Verify the seed.** This is read-only: row counts, no orphans and the scenario fixtures.
   ```bash
   npm run db:verify      # ends with "VERIFY OK"
   ```
6. **Load the knowledge base:** `assets/relaypay-knowledge-base.md` becomes `kb_chunks` (about 37 chunks). It syncs, so reruns don't duplicate.
   ```bash
   npm run db:load-kb
   ```
7. **Run the backend.**
   ```bash
   npm run build
   npm start -w @relaypay/backend      # http://localhost:8787 (PORT to change)
   ```
   Check it: `curl http://localhost:8787/health` → `{"status":"ok"}`.

   The voice page only works if Vapi can reach your backend over the internet, and a laptop on a home or office network usually isn't reachable. Expose it through a tunnel and point Vapi's URLs at the tunnel (see Troubleshooting), or deploy it.
8. **Staff accounts** (optional) are Supabase Auth users with `app_metadata.role` = `staff`, set through the Supabase admin API.

### Try a call

The seed data includes a demo customer, **Amara Okafor** of LagosLedger (`CUS-1001`):

- **Existing customer path:** name **Amara** (or **Amara Okafor**), email **amara@lagosledger.example**.
- **Guest path:** say "I'm Amara from LagosLedger". To look up `TXN-9001`, also say "My customer ID is CUS-1001". Other seeded pairs: `PAY-7002` → `CUS-1003`, `TXN-9004` → `CUS-1004`.
- **Callback:** ask for a specialist and give a weekday time, such as "Monday at 11 AM".

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

- **Environment it uses** (from `.env`): `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`. The launcher sets `CONVERSATION_ID`, `TURN_INDEX` and `ATTEMPT_ID`.
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
| Server messages | `end-of-call-report` is the one used. If the dashboard shows no selector, Vapi's default list is fine: other types are acknowledged and ignored. |
| Metadata send mode | **Variable** (so `call.id` arrives in the body) |
| End call phrases | `Thanks for calling RelayPay. Goodbye.` (the fixed goodbye line) |
| Tools / knowledge base | **None.** Vapi must not run tools; the backend does. |
| Public key | Restricted to this assistant, transient assistants **off**, allowed origin = your deployed `https://` origin |

The token is in the path, and a wrong token gets the same 404 as an unknown path. Rotate `VAPI_LLM_SECRET` after demos, then update the Vapi URLs to match.

## Deploy to Railway

`railway.json` and the `Dockerfile` define the service:
- Node 22 slim image, non-root user, `/health` healthcheck;
- restart on failure;
- 1 replica in `europe-west4-drams3a` (EU West, next to Supabase Frankfurt);
- `drainingSeconds: 15`, so the shutdown drain can finish. Railway's default is 0.

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
- **Keep one replica** (see Limitations).
- **Smoke test:** `npm run test:deployed -- --base-url https://<domain> --kb-runs 3 --s4-runs 3`.

## Tests and evals

| Command | What it checks | Writes to Supabase? | Spends money? |
| --- | --- | --- | --- |
| `npm run test:gate -w @relaypay/backend` | Backend unit tests (355): gate, sentence filter, social fast path, admission, webhook mapping, call path, staff view | No | No |
| `npm test -w @relaypay/mcp-server`, `npm test -w @relaypay/shared` | MCP tool (42) and shared-helper (28) unit tests | No | No |
| `npm run db:test` | 219 schema checks plus a concurrent-escalation race test, on a **throwaway local Postgres** (refuses non-localhost) | No | No |
| `npm run db:verify` | Seed integrity | Read-only | No |
| `npm run test:tools` | The 6 tools through the real MCP server: identity, ownership, caps, idempotency, guard | Yes (`test-` rows) | No |
| `npm run test:mcp` | MCP server start-up and environment rules through the real MCP client | Yes (`test-` rows) | No |
| `npm run eval:retrieval` | Retrieval ranks for the scenario questions | Yes (retrieval logs) | No |
| `npm run test:capacity` | Concurrency cap and graceful shutdown on a local backend | Yes | ~$0.03 (model) |
| `npm run test:agent` | Scenario conversations through a local backend, with assertions (cap $0.15) | Yes | ≤ $0.15 |
| `npm run test:endpoint` | End-to-end endpoint behaviour, fault injection and latency (local servers) | Yes | a few cents |
| `npm run test:deployed -- --base-url …` | The deployed service: routes, webhook, logs and latency | Yes | ≤ $0.15 |
| `npm run eval:grounding` | The deterministic grounding checks on fixed questions | Yes | a few cents |
| `npm run test:callpass` | The call page's two paths on the deployed service: a form-identified customer verified from the first turn and a spoken identity switch refused; wrong email, wrong name or unknown → the identical response; guest; the rate limit | Yes (`test-callpass-` rows) | ~$0.02 |
| `npm run eval:scenarios -- --cap 0.50` | **The product scenarios ×3, plus security and robustness cases, against the deployed service, with deterministic database checks and an LLM judge with verified quotes; writes `evaluations`.** With call passes enforced, add `--path guest` (or `--path customer --form-name Amara --form-email amara@lagosledger.example`): every conversation then gets a real one-time pass from `/calls/pass`. | Yes | ~$0.45 |

## Security notes

- **Secrets stay server-side.**
  - The Supabase service role key and the Anthropic key are only in the backend's environment.
  - The agent's process gets only the Anthropic key. The MCP process gets only Supabase credentials and the conversation, turn and attempt IDs, and refuses to start if the Anthropic key is present.
  - `/config` serves only the Vapi **public** key and assistant ID, plus the Supabase URL and **publishable** key when staff sign-in is on.
- **Call passes:** 32 random bytes, stored only as SHA-256, valid for 5 minutes, redeemed once (under a row lock) and never logged. The existing-customer path matches name AND email to one customer and answers every mismatch identically. A matched call's customer is set from the pass, never from the caller's words. `/calls/pass` is rate-limited. Staff roles come only from Supabase `app_metadata`, verified by the backend.
- **The endpoint token is in the URL path**, compared in constant time. Request paths are redacted in logs.
- **Sensitive data:** tools never return amounts, currency, stored emails or support notes. Identity takes two identifiers and is stored server-side.
- **The web page:** strict CSP (`'unsafe-eval'` and `blob:` only because Vapi's audio library needs them), no inline scripts, `frame-ancestors 'none'`.

## Troubleshooting

- **The agent hears itself (echo).** Use earphones: laptop speakers can feed the agent's voice back into the microphone, where it's transcribed as the caller.

| Symptom | Cause | Fix |
| --- | --- | --- |
| The call starts, then "Meeting ended due to ejection"; Vapi records `silence-timed-out` or `…did-not-receive-customer-audio` | The browser sent no audio: the CSP blocked the audio library's noise-filter worklet (`blob:`) or bundle (`eval`), or the wrong mic or output device was selected | Check Chrome's console for CSP errors. Use the built-in mic and speakers, disconnect Bluetooth headsets, and close other apps using the mic (Zoom, Teams, WhatsApp, other tabs). The page's error box gives the same steps. |
| "Microphone access is blocked" | Site permission denied | Click the padlock in the address bar → Microphone → Allow, then reload. |
| "The call couldn't start because the voice component failed to load" | A CSP violation or a failure loading the voice SDK | `/csp-report` records violations. |
| `fetch failed` / `ENOTFOUND` from scripts on a laptop | Intermittent local DNS | Retry. `eval:scenarios` retries connection errors itself. It isn't a server problem: check `/health`. |
| Vapi says the LLM failed (`pipeline-error-custom-llm-…`) after a restart | When developing locally through a tunnel, **the tunnel URL changes on every restart**, so Vapi still points at the old one | Update the assistant's Custom LLM URL and Server URL to the new tunnel URL (keep the `/v/<token>` path), or deploy. |
| Every reply is "Sorry, I'm having trouble checking that right now…" | Supabase or Anthropic unreachable, or the MCP server failed the tool-list guard | Check `conversation_turns.confidence_note` for the turn, and the deploy logs (`event="turn"`, `request_error`). |
| "We're getting a lot of calls right now…" | More than 3 agent turns at once in one process, or the process is shutting down | Expected under load. Raise `RELAYPAY_MAX_CONCURRENT_TURNS` only with more memory per replica. |

## More docs

| File | What's in it |
| --- | --- |
| [docs/one-page.md](docs/one-page.md) | A one-page guide to operating the system |
| [docs/system-overview.md](docs/system-overview.md) | The full architecture, data, security, reliability, cost and testing |
| [docs/testing-evidence.md](docs/testing-evidence.md) | The test table, before-and-after eval runs, live calls, logging and latency evidence |
| [docs/decisions.md](docs/decisions.md) | Every decision: what was observed, what changed and why |
| [docs/limitations.md](docs/limitations.md) | Known limitations and future work |
| [docs/latency.md](docs/latency.md) | Latency measurements, laptop vs deployed |
| [docs/model-choice.md](docs/model-choice.md) | Why Haiku 4.5 |
| [docs/retrieval-eval.md](docs/retrieval-eval.md), [docs/grounding-eval.md](docs/grounding-eval.md) | Retrieval and grounding evaluations |
| `PRD.md`, `assets/` | The product requirements and the source material: knowledge base, rules, tool spec, schema, seed data and test scenarios |
