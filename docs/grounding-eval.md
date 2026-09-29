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
