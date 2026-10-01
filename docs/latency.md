# Latency (Task 4, 2026-09-29)

## Setup

- **Endpoint runs:** `npm run test:endpoint`, 5 fees-question runs, each a new call with the same fees question.
- **Handshake runs:** `backend/src/dev/handshake.ts`, run through a diagnostic MCP wrapper, 3 runs.
- **Environment:** local Windows machine, Node 22.23.3, Supabase over the internet, `claude-haiku-4-5` with thinking disabled.

## Per-turn results (second endpoint run)

| Run | Answer type | `ms_retrieval` | `ms_first_token` | `ms_total` | `sdk_duration_ms` | `ms_tools` | SDK turns | Cost |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 0 | answer | 508 | 5428 | 5429 | 1751 | 0 | 1 | $0.0039 |
| 1 | answer | 508 | 7100 | 7101 | 3750 | 1052 | 2 | $0.0067 |
| 2 | **error (8s timeout)** | 630 | 8010 | 8010 | 4882 | 1316 | 2 | $0.0067 |
| 3 | **error (8s timeout)** | 539 | 8012 | 8012 | 3861 | 1042 | 2 | $0.0067 |
| 4 | **error (8s timeout)** | 497 | 8003 | 8003 | 1784 | 0 | 1 | $0.0039 |

- **p50 / p95 `ms_first_token`:** 8003 / 8012 ms. For the first endpoint run, which had no timeouts, it was 6315 / 6951 ms.
- **p50 / p95 `ms_total`:** the same values, because the reply is released whole.

## Timing marks (ms from request receipt)

| Run | Retrieval done / `query()` | `init` | First model message | First text | Final message stop | Released |
| --- | --- | --- | --- | --- | --- | --- |
| 0 | 1150 | 3513 | 4268 | 4270 | 5177 | 5428 |
| 1 | 1097 | 3102 | 3898 | 6029 | 6780 | 7100 |
| 2 | 1113 | 5692 | 7240 | 9690 | 10448 | 8010 (timeout) |
| 3 | 1148 | 3931 | 4696 | 6962 | 7729 | 8012 (timeout) |

## Breakdown

Typical one-model-call turn (run 0):

| Phase | ms | Share of 5428 |
| --- | --- | --- |
| Before the agent: body read, conversation upsert, turn lookup, retrieval RPC and log insert (≈5 Supabase round trips) | ~1150 | 21% |
| **CLI + MCP start**, `query()` → `init` | ~2360 (2.0–4.6 s seen in the endpoint; 1.65–1.85 s in isolated handshakes) | **43%** |
| Model time to first token, `init` → first message | ~755 | 14% |
| Final-reply generation, buffered by the gate until `message_stop` | ~910 | 17% |
| Gate check: `retrieval_logs` lookup, then release | ~250 | 5% |

**CLI start vs MCP start**, from three handshakes timed inside the MCP process:

| Phase | ms |
| --- | --- |
| `query()` → CLI spawns the MCP server (**CLI boot**) | 817–883 |
| MCP spawn → serving (**MCP start**: Node, imports, Supabase client) | 538–557 |
| MCP serving → `init` (MCP initialize, tools/list, CLI setup) | 286–446 |
| **Total `query()` → `init`** | 1651–1841 |

**Redundant search.** In 6 of 10 fees runs across the two endpoint runs, the model called `search_knowledge_base` again, even though the pre-turn chunks already contain the answer. That adds about 2.2–2.5 s (tool-call generation, the ~1.0 s MCP round trip, and a second model call) and about 75% more cost. It is what pushes turns past the 8 s first-token timeout.

## Levers (not built, pending decision)

| Lever | Expected saving | Notes |
| --- | --- | --- |
| Stop redundant searches: the prompt says the chunks are already retrieved and to search only if they don't cover the question; or no tool on turns where pre-turn retrieval is sufficient | ~2.3 s on ~60% of turns | Prompt or config change, cheapest |
| Long-lived session per call (streaming-input `query()`), pre-warmed at call start | ~2 s CLI + MCP start on turns 2+ (and turn 1 if pre-warmed) | Revisits D3 (stateless) |
| Run pre-agent DB work in parallel, and start the CLI while retrieval runs (streaming-input prompt) | ~0.5–1.0 s | Moderate change |
| Stream the final reply once the header is parsed, instead of buffering the whole message | ~0.9 s | Weakens the "no pre-tool text spoken" guarantee (D19) |
| Gate: use the in-memory retrieved set, with the DB as a check | ~0.25 s | Deviates from "DB is source of truth" |

# Latency levers (Task 4 follow-up, 2026-09-29)

**Target:** backend p50 `ms_first_token` ≤ 2500ms, p95 ≤ 4000ms. Each lever was measured with 10 fees runs via `npm run test:endpoint`.

| State | p50 `ms_first_token` | p95 `ms_first_token` | p50 / p95 `ms_total` | Notes |
| --- | --- | --- | --- | --- |
| Before (model-discretion search, MCP attached, buffered gate) | 6315 / 8003 (two runs) | 6951 / 8012 | same | 3 of 5 runs hit the 8s fallback |
| Lever 1: backend-owned retrieval, no agent tools, no MCP | 5792 | 12033 | same | 2 fallbacks from Supabase stalls of 11–14s, which were outside the timers then |
| Lever 3: streaming-input overlap, parallel DB, timers from receipt | **2453** | 8001 | same | 1 fallback: a 10.4s Supabase stall, now correctly cut at 8.0s |
| Lever 4: streaming gate (sentences after a valid header) | 3085 | 6918 | 3464 / 7190 | 0 fallbacks; 3 of 10 runs had a 4.4–5.4s model wait |

**The per-lever effect**, measured within runs, which is more reliable than comparing percentiles across runs:

- **Lever 1:** `query()` → `init` fell from 2.36s to 0.54s. `query()` → speech fell from 4.28s (6s with a tool call) to 2.95s.
- **Lever 3:** about 0.7s of CLI startup hidden behind the DB work. DB work became parallel, at 0.16–2.1s.
- **Lever 4:** the first sentence is spoken 0.2–0.5s (median 0.33s) before the reply finishes.

## Phase breakdown after all levers (lever-4 run, medians)

| Phase | Median | Range | Owner |
| --- | --- | --- | --- |
| Parallel DB work: upsert, turn check, ranking (receipt → prompt yielded) | 715ms | 163–2084 | Supabase network |
| Prompt yielded → first model event (CLI init tail + API time to first token) | 1320ms | 1069–**5444** | CLI + Anthropic API |
| First text delta → first spoken sentence (header + first sentence) | 290ms | 6–480 | model output speed + gate |
| First spoken → reply finished (streamed while speaking) | 325ms | 205–430 | model output speed |

**Typical turn:** about 0.7 + 1.3 + 0.3 ≈ **2.3s** to first speech, which is within the p50 target.

**The p95 tail isn't in our code.** It comes from two things:

- time from prompt to first model event, 4.4–5.4s in 3 of 10 runs;
- Supabase round trips, up to 2.1s here and 10–14s in earlier runs.

## Still over target: what a long-lived session would change, and the D9 implication

The remaining CLI cost sits inside the 1.3s prompt → first-model-event phase. A long-lived session per call would remove it from turns 2+, but it is **not built**, by decision. If it were:

- Today the agent has no MCP tools, so there is no MCP server to keep alive.
- Task 5 adds side-effect tools through MCP. A long-lived MCP server is spawned once per call, so it **cannot receive `TURN_INDEX` at spawn** (D9), and its logging context would be stale after turn 0.
- It would need a backend-owned channel for the current turn. For example, the backend writes the active `(conversation_id, turn_index)` to a table the MCP server reads per call, or the MCP server is exposed over HTTP with a per-request header set by the backend. Either way, the model must still never supply it.

## Candidates not yet tried (not built, pending decision)

- **The auxiliary model call:** every query includes a ~918-input / 15-output `claude-haiku-4-5-20251001` call (D18). If it runs before the main call, it is on the critical path. This is unverified; a CLI setting that disables non-essential model calls might remove it.
- **Supabase latency:** the DB phase ranges from 0.16 to 2.1s, with stalls up to 14s. Worth checking whether this is connection reuse or regional distance.

## Helper model call disabled (D25)

A/B test with two local servers taking alternating requests, 10 runs each:

| Variant | p50 `ms_first_token` | p95 | Errors | Cost per turn |
| --- | --- | --- | --- | --- |
| Default (session-title call on) | 2855 | 6651 | 0 | $0.0032 |
| `CLAUDE_CODE_DISABLE_TERMINAL_TITLE=1` | **1960** | 7352 | 0 | **$0.0016** |

Confirmation run after adopting it (full suite, 10 fees runs): p50 **2171**, p95 7160. `ms_total` p50 2475, p95 7544.

The p95 is still set by one or two network outliers per 10 runs, measured from the laptop in Lagos. The deployment comparison follows.

## Batch 2C step 1: attaching the MCP server (2026-09-30)

A KB-only turn (the fees question), 8 runs per variant, interleaved on one laptop. `no-mcp` is the test-only `RELAYPAY_TEST_DETACH_MCP=1` baseline; `default` attaches the relaypay MCP server with the six agent tools.

| Run | Variant | `init` median | First token p50 / p95 | Total p50 | Errors | Input tokens |
| --- | --- | --- | --- | --- | --- | --- |
| A: MCP from `dist/main.js` | no-mcp | ~1.8 s | 3529 / 6170 ms | 3665 ms | 0 | 1,824 |
| | default | ~3.9 s | 4994 / 8012 ms | 5338 ms | 1 (8 s first-token timeout: `init` never arrived) | 3,843 |
| B: MCP from the bundle | no-mcp | ~1.6 s | 2746 / 4441 ms | 2967 ms | 0 | 1,824 |
| | default | ~2.5 s | 3752 / 4333 ms | 4039 ms | 0 | 3,843 |

- **The database work still overlaps.** In every run, `db_done` and `message_yielded` come well before `init`. The cost is on the CLI side: the CLI starts the MCP server only after its own boot, and emits `init` only once that server has connected. So MCP startup adds directly to the critical path instead of overlapping the database work.
- **MCP server cold start, measured alone:** about 700–800 ms from `dist/main.js`, all of it module loading. Node's compile cache (`NODE_COMPILE_CACHE`) did not help. An esbuild bundle (`mcp-server/dist/bundle/server.mjs`) starts in about 450–550 ms, so the backend now spawns the bundle (D41).
- **Net cost of attaching MCP with the bundle:** about +1.0 s at p50 first token on a KB-only turn. About 0.9 s of that is the later `init`; the rest is the doubled input (the six tool schemas).
- **Not done** (would need an architecture change): pre-warming MCP processes, or a long-lived MCP server over HTTP. The stdio server per turn is locked.

## Batch 2D Part B: laptop vs deployed (Railway EU West / Amsterdam), 2026-09-30

- **Deployed:** `relaypay-backend-production-aa34.up.railway.app`, service in `europe-west4-drams3a`, Supabase in eu-central-1 (Frankfurt). The model is Haiku 4.5 with the MCP bundle.
- **Laptop:** the same code, run from Lagos.
- All times are ms from request receipt, **server-side**: turn rows plus the turn log's marks (`railway logs`). Client-observed times include the laptop → Railway network and are listed separately.
- Deployed runs: `npm run test:deployed -- --kb-runs 10 --s4-runs 10`, interleaved, 0 errors. Laptop numbers are from this morning's runs (Batch 2C step 1, run B, and step 6 run 2).

**KB-only (the fees question), p50 / p95**

| | Laptop (MCP bundle) | Deployed |
| --- | --- | --- |
| `db_done` (attempt + retrieval) | 500–1900 ms | **73 ms** |
| `init` (CLI + MCP ready) | ~2.5 s | **391 ms** |
| First token | 3752 / 4333 | **1329 / 1437** |
| Total | 4039 / 4526 | **1598 / 1690** |
| Client-observed (deployed) | n/a | 1728 p50 (≈ +130 ms network from Lagos) |

**Tool-backed: S4 "Can you check transaction TXN-9001?", p50 (p95 where measured)**

| | Laptop (step 6 run 2, median of 4 tool turns) | Deployed (10 runs) |
| --- | --- | --- |
| Filler ("One moment while I check that.") | 4116 | **1171 / 1236** |
| First answer sentence | 6161 | **2512 / 2557** |
| Total | 6534 | **2971 / 3053** |
| Client-observed | n/a | 3194 p50 |

**S3 (lookup_customer) ×3 per model, deployed vs laptop ×5, p50**

| | Haiku, laptop | Haiku, deployed | Sonnet 5.5, laptop | Sonnet 5.5, deployed |
| --- | --- | --- | --- | --- |
| Pass rate | 5/5 | 3/3 | 5/5 | 3/3 |
| Filler | 2544 | 1295 | 2732 | 1785 |
| First answer sentence | 5167 | **3033** | 6465 | **3520** |
| Total | 5430 | 3292 | 6521 | 3542 |
| Cost per turn (mean; cache warm) | $0.0031 (0.0018) | $0.0023 (0.0018) | $0.0076 (0.0043) | $0.0098 (0.0043) |

Sonnet was measured deployed by setting the service's `AGENT_MODEL=claude-sonnet-5-5` and redeploying; it was then set back to Haiku. `conversation_turns.model` confirms which model answered each turn.

**Reading:**
- D24's hypothesis holds. Most of the laptop latency was the laptop:
  - database round trips Lagos → Frankfurt (`db_done` 73 ms vs up to 1.9 s);
  - process start (`init` 391 ms vs about 2.5 s: CLI and MCP spawn on a fast Linux host vs a Windows laptop).
- Deployed, a KB answer starts at about 1.3 s, and a tool-backed answer's filler at about 1.2 s, with the answer at about 2.5 s.
- The model gap stays about 0.5 s at the first answer sentence (Haiku 3.0 s vs Sonnet 3.5 s on S3), at 2.4–4× the cost. This supports the Haiku decision (docs/model-choice.md).
- The long-lived session (D24) is not needed on these numbers.
- The p95s are tight (n = 10). Re-measure under real call traffic (the Vapi webhook stores `performanceMetrics` per call, D50).

**Also seen in the deployed runs (grounding, not latency):**
- In 9 of the 10 KB runs, the runtime filter (D37) dropped Haiku's embellished second sentence, e.g. "…so you'll see **exactly** what applies to **your specific payment**". The caller heard only the grounded first sentence. The filter is doing its job, but the model still does this unprompted.
- One answer was lost entirely: "International payouts usually take 2 to 5 business days, depending on the destination and **your** banking partners." That one invented word dropped the only sentence, and the caller got the safe decline. This is the precision cost of dropping whole sentences; kept as is for now, a Task 6 eval item.

## Deployed voice baseline: first live end-to-end call (2026-09-30)

Call `01a0f455…` from the deployed web page: Railway EU West, Haiku, Soniox STT RT v5. The numbers are Vapi's `artifact.performanceMetrics`, stored in `conversations.vapi_metrics` by the end-of-call webhook (D50). They cover the whole pipeline: speech end → transcriber → endpointing → our backend → TTS → audio.

| Turn | Kind | Turn latency | Model latency | Voice latency | Transcriber | Endpointing |
|---|---|---|---|---|---|---|
| 0 | KB answer (fees) | 2070 ms | 1656 ms | 358 ms | 52 ms | 1 ms |
| 1 | tool answer (`lookup_transaction`), with the filler line | 4076 ms | 1658 ms | 1963 ms | 428 ms | 3 ms |
| 2 | social (model path, before the D56 fix) | 1818 ms | 1513 ms | 284 ms | 16 ms | 2 ms |
| **Average** | | **2655 ms** | **1609 ms** | 868 ms | 165 ms | 2 ms |

- **This is the deployed voice baseline.** Later changes are compared against these numbers.
- "Model latency" is Vapi's time to our first streamed token, including the network hop to Railway. Our own `ms_first_token` for the same turns was 1386 / 1359 / 1206 ms, so there is about 0.25–0.3 s of network and Vapi overhead per turn.
- Turn 1's voice latency (1963 ms) most likely includes the "One moment while I check that." filler being synthesised before the answer. This is an inference and has not been checked against Vapi's per-segment timings.
- Turn 2 is now a fast-path social reply (D56: `declined_offer` / `goodbye` with no model call). Its model latency should drop to the network overhead alone. Re-measure on the next live call.
- n = 3. This is one call, not a distribution.

## The init regression in the AFTER eval run: before, after and cause (2026-10-01)

| Deployment | Code | `init` p50 (CLI + MCP start) | First token p50 | Sample |
| --- | --- | ---: | ---: | --- |
| `113953b2` (BEFORE eval) | `c948bf1` | **412 ms** (343–537) | 1332 ms | 52 eval turns, mixed types |
| `61844fd9` (AFTER eval) | `3639936` (fixes D64–D68) | **1043 ms** (840–1756) | 1944 ms | 52 eval turns, mixed types |
| `328f527e` (re-measure) | `8d23e32` (+ mcp_entry log, D69) | **456 ms** (407–557) | **1431 ms** (p95 2274) | 10 KB-only runs (`test:deployed --kb-runs 10`) |

- **Hypothesis tested: rejected.** The hypothesis was that file timestamps in the Docker build made the bundle look older than the compiled code, so the slower unbundled `main.js` was spawned.
  - The backend now logs the entry file once per process (`event="mcp_entry"`).
  - Both deployments since (`77d59c10`, `328f527e`) log `kind="bundle" path="/app/mcp-server/dist/bundle/server.mjs"`.
  - Neither earlier deployment logged the main.js fallback line, which is printed whenever the fallback happens.
  - So the bundle was used throughout, and the timestamp rule was not replaced.
  - Inspecting the container's files directly (`railway ssh`) would need an SSH key added to the Railway account; that wasn't done.
- **Cause: the container, not the code.** The same MCP bundle code on a fresh container measures `init` at 456 ms, against 412 ms before the fixes. Only `61844fd9` was slow.
  - Retrieval and model time were unchanged throughout, so the +630 ms was host or container variance in process start.
  - **Risk that remains:** Railway can place a deployment on a slower host, and per-turn process spawn (D24) makes that visible on every turn.
  - Re-measure after each deploy (`test:deployed --kb-runs 10`). A long-lived MCP process (D24) would remove the dependency.
- The original note follows.

### Original note: regression found in the AFTER eval run (2026-10-01)

The scenario eval (docs/testing-evidence.md) measured the same deployed service before and after the Batch 3C fixes, 52 turns each:

- **`init`** (Claude CLI + MCP server start) went from a median of **412 ms** (343–537) to **1043 ms** (840–1756).
- **`ms_first_token`** went from 1332 ms to **1944 ms**.
- Retrieval (73 ms) and model time (sdk_duration_ms 1544 → 1504) didn't change.

The fix round changed the MCP server bundle and redeployed onto a new container (`113953b2` → `61844fd9`). The cause, code or host, is **not determined**. First step: redeploy the same commit and re-measure `init`.
