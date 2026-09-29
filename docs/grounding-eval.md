# Grounding Evaluation: Before and After the Prompt Change (2026-09-29)

Reflection evidence for D30 and D32. The failure pattern is **claims not directly supported by evidence**, the same one the Week 5 instructor feedback named. It was observed in live call `01a0ef14-d79b-7000-9a36-90b444cbecd9`.

## Method

- **Command:** `npm run eval:grounding -- --label <before|after>`.
- **Questions:** 10 fixed ones through the real endpoint in text mode: scenarios S1–S8, K1 ("How long do payouts to Kenya take?") and T1 ("Thank you."). Each is a fresh single-turn conversation (channel `test`).
- **Checks:** each `type=answer` reply goes through the **deterministic grounding checks** (`shared/src/grounding-check.ts`), compared with the chunks it cited, heading plus content:
  - strengthening words;
  - dropped hedges;
  - unsupported specifics;
  - invented attribution.
- **Checks flag only.** They never fail a case; the Task 6 Sonnet judge decides (D32).
- **Not checked:** clarify and decline replies cite no chunk. T1 must speak the backend's fixed social line (D31).
- **Checker regression cases:** the live Kenya and fees answers must be flagged, and cleaned versions must pass. 12/12 unit tests.

**Checker changes before the recorded baseline.** A first baseline run, `before-2026-09-29T21-59-52-306Z` at $0.0128, surfaced two false positives, which were fixed with tests before the baseline below was recorded:

- "can't **guarantee**": a negated intensifier. The chunk heading ("Can RelayPay Guarantee Payment Timelines?") also wasn't yet counted as evidence.
- "**your** account" echoing the caller's "my account".

That run also lost S4's turn row. The laptop's DNS returned `ENOTFOUND`, which wasn't in the retry list, so the attempt's closing call failed and left it `active`. `ENOTFOUND` is now retried once, and that test attempt was closed manually as `failed`.

## Run: before (current prompt), `before-2026-09-29T22-10-07-304Z`

| Q | Answer type | Flags | Spoken |
| --- | --- | --- | --- |
| S1 | answer | strengthening_word: `exact`<br>strengthening_word: `upfront` | Fees vary based on the transaction type, corridor, and payment method you use. RelayPay will show you the applicable fees before you confirm any transaction, so you'll know the exact cost upfront. |
| S2 | clarify | not checked | Are you waiting for a payment to arrive, or trying to send a payment out? |
| S3 | clarify | not checked | What specifically would you like me to help you with regarding your account? Are you having trouble signing in, or do you have a question about your account status? |
| S4 | clarify | not checked | I'd be happy to help. Are you asking about the status of that transaction, or do you need something else like a report or receipt? |
| S5 | decline | not checked | I don't have access to specific payout details or transaction histories. To help you with payout PAY-7002, I'll need to connect you with RelayPay support who can look that up for you. |
| S6 | clarify | not checked | Can you tell me a bit more about what happened—did you try to send an invoice to a client, or are you waiting to receive a payment? |
| S7 | answer | invented_attribution: `your specific situation and` | I understand that's frustrating. Account restrictions are usually temporary while we complete required verification or compliance reviews. The best next step is to reach out to RelayPay support through our official support channels, and they'll be able to look into your specific situation and help get this resolved. |
| S8 | answer | none | No, we can't guarantee a specific arrival time like 9am tomorrow. Payment timelines depend on external banking systems and regulatory checks that are outside our control. |
| K1 | answer | strengthening_word: `exact`<br>unsupported_specific: `kenya (echoed from the caller)`<br>invented_attribution: `your specific banking setup` | International payouts usually take two to five business days, depending on the destination and banking partners. Kenya would fall into that timeline, but the exact speed can vary based on your specific banking setup. |
| T1 | social | not checked | You're welcome. Is there anything else I can help you with? |

**Summary:**

- 4 answers checked, **3 flagged, 6 flags**. T1 was `social` with the fixed line.
- Cost $0.0142 (estimate). 0 server errors.
- **K1 reproduces the live failure almost word for word**: a general policy applied to Kenya, "exact", and an invented "your specific banking setup".
- **S1 repeats "exact … upfront"**, which is also the unsupported "know the cost" inference; exchange rates "are not locked until processing".
- **S7's flag is probably benign** ("your specific situation" refers to the caller's own situation). It is left for the judge.

## Prompt change (commit `ec44e7d`)

Rule 6 of the system prompt now says:

- say only what the chunks say, as close to their own words as possible;
- don't apply a general policy to a named country, account or transaction; give the general policy and say you can't confirm the specifics;
- never attribute anything to the caller unless a chunk does;
- don't add strengthening words (exact, always, guaranteed, up front…), and keep the chunk's hedges;
- no conclusions or reassurances of your own ("so you'll know the cost", "the good news is").

It also includes two good-vs-bad examples taken from the live call (Kenya and fees).

## Run: after (new prompt), `after-2026-09-29T22-12-12-034Z`

| Q | Answer type | Flags | Spoken |
| --- | --- | --- | --- |
| S1 | answer | none | Fees vary based on transaction type, corridor, and payment method. RelayPay displays the applicable fees before you confirm a transaction, so you can see what they are. |
| S2 | clarify | not checked | Can you tell me which payment you're referring to—is it one you're sending out, or a payment you're expecting to receive? |
| S3 | clarify | not checked | Hi Amara, I'd be happy to help. What would you like me to check on your account—is there a specific issue or question? |
| S4 | clarify | not checked | I can tell you about how to track transactions in your RelayPay dashboard, but I'm not able to look up specific transactions for you. What would you like to know about that transaction? |
| S5 | decline | not checked | I don't have access to information about specific payout transactions or their status. To help you with payout PAY-7002, I'll need to connect you with RelayPay support so they can look into that for you. |
| S6 | clarify | not checked | Can you tell me which invoice failed — is this one you sent to collect payment from a client, or a payment you were trying to make to someone else? |
| S7 | answer | none | I'm sorry to hear your account is restricted. You'll need to contact RelayPay support through official support channels, and they can help you work through this. |
| S8 | answer | none | No, RelayPay can't guarantee payment timelines because they depend on external banking systems and regulatory checks. |
| K1 | answer | none | International payouts usually take 2 to 5 business days, depending on destination and banking partners. I can't confirm the exact timeline for Kenya specifically. |
| T1 | **error** | not checked | Sorry, I'm having trouble checking that right now. Could you try again in a moment? |

**Summary:**

- 4 answers checked, **0 flagged, 0 flags**. Cost $0.0157 (estimate). 0 server errors.
- **T1 regressed to the error fallback.** Its stored note is `timeout: no speakable reply within 8000ms; aborted: first-token timeout`. There was no model output at all (no tokens, no result), so this was a latency outlier, not a misclassification.
- **T1 repeated 3 times alone:** `social` with the fixed line each time, first speech at 1860 / 2114 / 1530ms, cost $0.0036.

## Before vs after, per question

| Q | Before: answer type / flags | After: answer type / flags | Change |
| --- | --- | --- | --- |
| S1 fees | answer / `exact`, `upfront` | answer / none | **Fixed:** chunk wording kept, and "know the exact cost upfront" removed. The residual "so you can see what they are" restates "displays" and is not flagged. |
| S2 stuck | clarify | clarify | same behaviour |
| S3 Amara | clarify | clarify | same |
| S4 TXN-9001 | clarify | clarify | Now also says it can't look up specific transactions: more honest |
| S5 PAY-7002 | decline | decline | same |
| S6 invoice failed | clarify | clarify | same |
| S7 restricted | answer / `your specific situation` (likely benign) | answer / none | Shorter; the "usually temporary" paraphrase is gone, so it now says less |
| S8 9am guarantee | answer / none | answer / none | same |
| K1 Kenya | answer / `exact`, `kenya (echoed)`, `your specific banking setup` | answer / none | **Fixed:** general policy stated, Kenya explicitly not confirmed. "exact" now appears only inside the "can't confirm" sentence, so it isn't a claim. |
| T1 thank you | social (fixed line) | error (8s timeout); 3/3 social on repeat | **No regression in behaviour.** One latency outlier. |

**Totals:**

| | Answers flagged | Total flags |
| --- | --- | --- |
| Before | 3 of 4 | 6 |
| After | 0 of 4 | 0 |

**Eval spend:** $0.0463 (estimate) across all runs: the first baseline with lost rows ($0.0128), the recorded baseline ($0.0142), the after-run ($0.0157) and the T1 repeats ($0.0036). That is under the $0.05 cap.

## Caveats

- **One run per prompt.** LLM output varies between runs, so "0 flags after" is evidence, not proof. The Task 6 evals should repeat each question several times.
- **The deterministic checks catch known patterns only.** The S1 "so you can see what they are" clause was not flagged, and a subtler unsupported claim would slip through too. The Sonnet judge with verified quotes (D32) is the real decider.
- **The prompt now includes the Kenya and fees examples,** so K1 and S1 are partly tested on examples the model has seen. New questions of the same kind should be added to the Task 6 set to check that the rule generalises.
