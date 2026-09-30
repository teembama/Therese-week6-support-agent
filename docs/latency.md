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
