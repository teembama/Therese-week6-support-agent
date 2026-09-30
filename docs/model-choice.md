# Model Choice: Evidence for the Agent Model

**Status:** no decision yet. The agent runs `claude-haiku-4-5` (`backend/src/config.ts`, `DEFAULT_AGENT_MODEL`). This page collects the evidence for the choice. It is not the decision.

## The candidates

From the models overview (https://platform.claude.com/docs/en/about-claude/models/overview, read 2026-09-30):

| | Claude Haiku 4.5 | Claude Sonnet 5.5 |
| --- | --- | --- |
| API model ID used | `claude-haiku-4-5` (alias of `claude-haiku-4-5-20251001`) | `claude-sonnet-5-5` |
| Price per MTok, input / output | $1 / $5 | $2 / $10 |
| Comparative latency (Anthropic) | Fastest | Fast |
| Retirement (Claude API) | **Not sooner than October 15, 2026** | Not sooner than September 28, 2027 |

Haiku 4.5's retirement floor is about two weeks after this measurement. It is a floor, not an announced date, but a voice agent submitted now should not depend on it staying available.

## Experiment 1: identity gatekeeping (scenario S3), 2026-09-30

**Why:** with the Batch 2C prompt, Haiku intermittently refused to call `lookup_customer` for "I am Amara from LagosLedger. Can you check my account?". It asked for an email or customer ID instead, although the tool enforces the identity rule in code (D42).

Before the worked example (Haiku; same scenario or the same first turn, across several prompt versions, so this is indicative only):
- the tool was called in 1 of 6 observed turns;
- 3 of them came before the tool-description fix (D42).

**Method:**
- The worked example was added to the prompt: "I'm Amara from LagosLedger. Can you check my account?" → call `lookup_customer` immediately.
- Then `npm run test:agent -- --only "S3 AMARA" --repeat 5 --model <model>`: 5 fresh conversations per model, one caller turn each, through the real `/chat/completions` endpoint.
- The backend ran on a laptop in Lagos, with Supabase in eu-central-1.
- The model is selected with the test-only `RELAYPAY_TEST_AGENT_MODEL` (limited to these two IDs).
- Everything else is identical: prompt, tools, `thinking: disabled`, SDK defaults.
- **Pass:** `lookup_customer` returned success (CUS-1001 verified) in that turn.
- **Latency:** ms from request receipt. The filler is the backend's "One moment while I check that." at the tool call; the first answer sentence is the first sentence of the model's reply after the tool result.
- **Cost:** the conversation's recomputed `total_cost_usd` (a client-side estimate from the SDK).

| Model | Pass rate | Filler, median | First answer sentence, median | Total, median | Cost per turn, mean | Cost per turn, cache warm |
| --- | --- | --- | --- | --- | --- | --- |
| claude-haiku-4-5 | **5/5** | 2544 ms | **5167 ms** | 5430 ms | **$0.0031** | $0.0018 |
| claude-sonnet-5-5 | **5/5** | 2732 ms | 6465 ms | 6521 ms | $0.0076 | $0.0043 |

Raw runs:
- **Haiku:**
  - first answer sentence: 5598, 5612, 5049, 4912, 5167 ms;
  - cost: 0.0082, 0.0021, 0.0018, 0.0018, 0.0018.
- **Sonnet:**
  - first answer sentence: 6269, 6549, 6465, 6519, 5639 ms;
  - cost: 0.0205, 0.0048, 0.0043, 0.0043, 0.0043.
- The first run of each model pays the prompt-cache write.

What was spoken was almost identical for both models: "Thanks, Amara. Your account is active, on the Growth plan. What would you like to know about it?". It is close to the worked example's wording. No sentences were filtered.

## Reading

- **With the worked example, both models pass S3 5/5.** The gatekeeping is fixed by the prompt and the tool description (D42), not by the model. On this evidence, reliability does not force a switch to Sonnet.
- **Haiku is about 1.3 s faster to the first answer sentence** on a tool-backed turn (median 5.2 s vs 6.5 s), and **about 2.4× cheaper** per turn with a warm cache ($0.0018 vs $0.0043).
  - On a voice call the filler covers the tool time, but the caller still waits for the answer. Sonnet adds about 1.3 s of that wait on every tool-backed turn.
- **Against Haiku:** the retirement floor of October 15, 2026, and the earlier nondeterminism on S3. Sonnet was not measured on the pre-example prompt, so we don't know whether it would have gatekept too.

## Caveats

- n = 5 per model, one scenario (S3), one caller turn each. A pass rate of 5/5 is compatible with a true rate well below 100%.
- Laptop network: absolute latencies include the Lagos → Frankfurt path, and will change after the Batch 2D deployment. The Haiku-vs-Sonnet difference is the useful number.
- `thinking` is disabled for both. Sonnet 5.5's default effort is `high` (per the models overview). The effort setting was not varied.
- Scenario coverage for the choice should come from the Task 6 eval set (all scenarios, several runs each), not from S3 alone.

## Total spend for this experiment

- Haiku: $0.0156.
- Sonnet: $0.0382.
