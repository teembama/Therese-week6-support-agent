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
