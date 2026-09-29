# Retrieval Evaluation (2026-09-29)

Evidence for `KB_MIN_RANK` (`shared/src/config.ts`).

## Setup

- **Command:** `npm run eval:retrieval`
- **Query:** `search_kb` with `min_rank = 0` and `match_count = 6`, so results are **not** pre-filtered. The runtime value `KB_MIN_RANK = 0.1` is not applied here.
- **Search settings:** normalization 32, which is rank / (rank + 1), in the range 0..1. Excluded words: `relaypay`.
- **Data:** 37 chunks in `kb_chunks`.
- **Logging:** each query is logged to `retrieval_logs` under conversation `test-retrieval-eval-2026-09-29T13-54-53-156Z` (channel `test`), one turn per question.

**✓** marks the chunk I judged correct: the one whose text actually answers, or safely frames, the question. "Tool path" means the answer comes from a lookup tool, not the knowledge base, so retrieval only supplies framing.

## Results (normalization 32)

| Q | Question | Returned chunks (rank) | Correct chunk |
| --- | --- | --- | --- |
| S1 | What fees does RelayPay charge for international payments? | International Payments .839 · **How Does RelayPay Charge Fees? .762 ✓** · Does RelayPay Automatically Collect Invoice Payments? .643 · Multi-Currency Invoicing .615 · Can RelayPay Guarantee Payment Timelines? .583 · How Long Do Payments Take To Process? .583 | #2 |
| S2 | My payment is stuck. | International Payments .750 · Does RelayPay Automatically Collect Invoice Payments? .643 · Multi-Currency Invoicing .615 · Can RelayPay Guarantee Payment Timelines? .583 · How Long Do Payments Take To Process? .500 · **Why Is My Payment Delayed? .500 ✓** | #6: **outside top 4** |
| S3 | I am Amara from LagosLedger. Can you check my account? | Account And Team Access .688 · Account Restrictions And Suspensions .643 · How Do I Create A RelayPay Account? .583 · Why Is My Account Under Review? .583 · What Should I Do If My Account Is Restricted? .500 · Data Security And Privacy .444 | Tool path. Best framing is Data Security And Privacy (#6) |
| S4 | Can you check transaction TXN-9001? | Transaction Monitoring And Risk Reviews .750 · **Transaction Tracking And Reporting .722 ✓** · How Does RelayPay Charge Fees? .444 · Disputes, Refunds, And Cancellations .444 · Policies And Compliance (intro) .444 · Version 2.4 .444 | Tool path; framing #2 |
| S5 | What is happening with payout PAY-7002? | Payout And Beneficiary Management .722 · Version 2.3 .545 · How Long Do Payments Take To Process? .444 · What Is RelayPay? .286 · International Payments .286 · Product Features Overview (intro) .286 | Tool path. Best framing is Why Is My Payment Delayed? (compliance reviews): **not matched** |
| S6 | My invoice payment failed and I need someone to look at it. | Multi-Currency Invoicing .821 · **Does RelayPay Automatically Collect Invoice Payments? .762 ✓** · International Payments .750 · Can I Create Invoices In Multiple Currencies? .583 · Can RelayPay Guarantee Payment Timelines? .583 · How Long Do Payments Take To Process? .500 | #2 |
| S7 | My account was restricted and nobody is helping me. | **Account Restrictions And Suspensions .815 ✓** · Account And Team Access .688 · What Should I Do If My Account Is Restricted? .667 (also relevant) · How Do I Create A RelayPay Account? .583 · Why Is My Account Under Review? .583 · Data Security And Privacy .444 | #1 |
| S8 | Can RelayPay guarantee my payout arrives by 9am tomorrow? | Payout And Beneficiary Management .722 · Version 2.3 .545 · **Can RelayPay Guarantee Payment Timelines? .500 ✓** · How Long Do Payments Take To Process? .444 · How Long Does Verification Take? .286 · What Is RelayPay? .286 | #3 |
| X1 | do you support crypto wallets | How Do I Contact RelayPay Support? .643 · What Issues Require Human Support? .583 · Which Regions Does RelayPay Support? .583 · International Payments .545 · What Should I Do If My Account Is Restricted? .444 · Version 2.2 .444 | Feature Availability And Limitations: **not in top 6** (#11, .286) |
| X2 | what is the weather in Lagos | (no chunk matched any word) | None: correctly empty |
| X3 | how long do payouts to kenya take | **How Long Do Payments Take To Process? .783 ✓** · Payout And Beneficiary Management .722 · How Long Does Verification Take? .667 · Version 2.3 .545 · What Is RelayPay? .286 · International Payments .286 | #1 |

## Findings

1. **X1 is not off-KB.** "Feature Availability And Limitations" says RelayPay does not support "Cryptocurrency payments". Retrieval misses it because the English stemmer keeps `crypto` and `cryptocurr` apart. The query then matches only on "support", which is a real KB word, and pulls up the support-contact chunks at .643.
2. **There is no rank gap between correct chunks and off-target matches.**
   - Correct-chunk ranks within the top 6 are .500 to .815.
   - X1's wrong top chunk is .643, above the correct chunks for S2 (.500) and S8 (.500).
   - The only query with no match at all is the fully off-topic X2. Any rank threshold that flags X1 also removes correct chunks.
3. **The threshold filters chunks, not just a yes/no decision.** A high threshold doesn't only set `insufficient_knowledge`; it also removes lower-ranked correct chunks from the result.
   - Example: at 0.65, S8 keeps only "Payout And Beneficiary Management" and loses "Can RelayPay Guarantee Payment Timelines?". That is exactly the chunk scenario 8 needs.
4. **Ordering, separate from the threshold.**
   - S2's correct chunk ranks #6, so at `KB_MATCH_COUNT = 4` it isn't returned.
   - S1, S4, S6 and S8 have their correct chunk at #2 or #3, behind a longer, general chunk that repeats query words.

## Other normalizations (read-only what-if, not logged)

These are correct-chunk position and rank per question, looking at the top 40. The last line is X1's top rank, which is a wrong chunk.

| Q | 32 (current) | 33 (1\|32, log length) | 34 (2\|32, per unique word) | 36 (4\|32, extent distance) |
| --- | --- | --- | --- | --- |
| S1 | #2 .762 | #2 .512 | **#1** .138 | #2 .598 |
| S2 | #6 .500 | #5 .254 | #3 .053 | #2 .500 |
| S4 | #2 .722 | #2 .406 | **#1** .056 | #6 .231 |
| S5 | not matched | not matched | not matched | not matched |
| S6 | #2 .762 | #2 .509 | **#1** .132 | #1 .531 |
| S7 | #1 .815 | #1 .533 | #2 .087 | #1 .535 |
| S8 | #3 .500 | #2 .265 | **#1** .063 | #1 .500 |
| X1 correct | #11 .286 | #11 .098 | #11 .010 | #6 .286 |
| X1 top (wrong chunk) | .643 | .405 | .122 | .412 |

- **Normalization 34** gives the best ordering: 5 of 7 answerable questions have the correct chunk at #1, and all are within the top 4.
- **No normalization gives a separating gap.** X1's wrong top chunk always outranks the correct chunk of at least two scenario questions.

## Proposal

1. **`KB_MIN_RANK = 0.30` at normalization 32, as a noise floor, not an "unsupported question" detector.**
   - It keeps every correct chunk: the lowest correct-chunk rank seen in the top 6 is .500.
   - It drops the .286 tail of weak single-word matches, such as "What Is RelayPay?" returned for S5, S8 and X3.
   - `insufficient_knowledge` then fires only when nothing clears the floor. X2 is the example.
2. **At 0.30 with `KB_MATCH_COUNT = 4`, these questions fail:**
   - **S2:** the correct chunk is at #6, so it isn't returned. S2's expected behaviour is a clarifying question, so the impact is low.
   - **S5:** the "compliance review" framing chunk is never matched. It is a tool-path question, and the lookup plus escalation carry it.
   - **X1:** the crypto chunk isn't retrieved. The agent gets support-contact chunks and `insufficient_knowledge = false`, so the answer depends on the agent recognising that none of them answers the question.
   - S3 and S4 are tool-path questions; retrieval only supplies framing for them.
   - **These pass:** S1 (#2), S4 (#2), S6 (#2), S7 (#1), S8 (#3), X3 (#1), and X2 (correctly insufficient).
3. **The trade-off, if you want a threshold that flags X1:**
   - 0.65 flags X1 and still passes every scenario's top chunk (the lowest is S3 at .688), but the margin is .045.
   - It removes the correct chunks for S2 and S8, which breaks scenario 8's "no guarantee" answer.
   - Recommendation: don't do this.
4. **Actual fixes, each needing your decision and some belonging in a later migration:**
   - Switch to normalization 34 for better ordering. The threshold would then have to be re-derived: the rerun costs one `eval:retrieval`, and no migration is needed.
   - Prefix-match lexemes (`crypto:*`) so partial words match longer ones. This needs migration 003.
   - Rely on the agent's instruction to answer only when a returned chunk actually contains the answer. This is needed in any case, because a rank can't tell "on-topic" from "shares a word".
