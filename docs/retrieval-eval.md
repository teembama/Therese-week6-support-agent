# Retrieval Evaluation (2026-09-29)

Evidence for the retrieval settings in `shared/src/config.ts`. It is a before-and-after record:

- **Run 1 (before):** the initial settings, and the analysis that showed a rank threshold can't detect unsupported questions.
- **Runs 2 and 3 (after):** recall-first tuning under decision D16.

| | Run 1 (before) | Runs 2–3 (after) |
| --- | --- | --- |
| Normalization | 32 | 34 |
| Match count at runtime | 4 | 6 |
| Synonyms | none | `crypto → cryptocurrency` |
| `KB_MIN_RANK` | 0.1 (placeholder) | 0.05 |

- **Command:** `npm run eval:retrieval` (add `-- --min-rank <n>` for a confirmation run).
- **Data:** 37 chunks in `kb_chunks`. Excluded words: `relaypay`.
- **Logging:** each run logs one `retrieval_logs` row per question under its own conversation (channel `test`).

**✓** marks the chunk I judged correct: the one whose text actually answers, or safely frames, the question. "Tool path" means the answer comes from a lookup tool, not the knowledge base, so retrieval only supplies framing.

## Run 1 (before): normalization 32, min_rank 0, match_count 6, no synonyms

Conversation: `test-retrieval-eval-2026-09-29T13-54-53-156Z`.

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

### Run 1 findings

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

### Run 1: other normalizations (read-only what-if, not logged)

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

### Run 1 proposal (superseded: see "Decision" below)

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

## Decision (D16): recall first, with the agent and grounding gate handling precision

- Retrieval optimises for recall.
- The rank threshold is a noise floor, not a detector for unsupported questions.
- `insufficient_knowledge` means zero chunks above the floor. Deciding that retrieved chunks don't answer the question is the agent's job (`type = decline`).
- Changes:
  - normalization changed from 32 to 34;
  - match count changed from 4 to 6;
  - one synonym added, `crypto → cryptocurrency`, justified by X1;
  - no prefix matching, so no migration 003.

## Run 2 (after): normalization 34, min_rank 0, match_count 6, synonyms on

Conversation: `test-retrieval-eval-2026-09-29T14-08-14-394Z`. Ranks are to 4 decimal places; normalization 34 produces much smaller values than 32.

| Q | Returned chunks (rank) | Correct chunk | Top rank | Before (Run 1) |
| --- | --- | --- | --- | --- |
| S1 | **How Does RelayPay Charge Fees? .1379 ✓** · Can RelayPay Guarantee Payment Timelines? .0854 · Does RelayPay Automatically Collect Invoice Payments? .0789 · International Payments .0720 · Why Is My Payment Delayed? .0526 · How Long Do Payments Take To Process? .0493 | **#1** .1379 | .1379 | #2 |
| S2 | Can RelayPay Guarantee Payment Timelines? .0854 · Does RelayPay Automatically Collect Invoice Payments? .0789 · **Why Is My Payment Delayed? .0526 ✓** · International Payments .0429 · How Long Do Payments Take To Process? .0357 · Multi-Currency Invoicing .0278 | **#3** .0526 | .0854 | #6 |
| S3 (tool path) | How Do I Create A RelayPay Account? .0805 · Why Is My Account Under Review? .0761 · What Should I Do If My Account Is Restricted? .0714 · Account And Team Access .0643 · Account Restrictions And Suspensions .0377 · Can RelayPay Guarantee Payment Timelines? .0260 | Data Security And Privacy: **not in results** | .0805 | #6 |
| S4 (tool path) | **Transaction Tracking And Reporting .0558 ✓** · Transaction Monitoring And Risk Reviews .0536 · How Does RelayPay Charge Fees? .0385 · Can RelayPay Guarantee Payment Timelines? .0260 · Disputes, Refunds, And Cancellations .0212 · What Issues Require Human Support? .0179 | **#1** .0558 | .0558 | #2 |
| S5 (tool path) | Payout And Beneficiary Management .0546 · Version 2.3 .0306 · How Long Do Payments Take To Process? .0288 · Product Features Overview (intro) .0217 · What Is RelayPay? .0179 · Ongoing Known Limitations .0113 | Why Is My Payment Delayed?: **not matched** | .0546 | not matched |
| S6 | **Does RelayPay Automatically Collect Invoice Payments? .1322 ✓** · Can I Create Invoices In Multiple Currencies? .0972 · Can RelayPay Guarantee Payment Timelines? .0854 · Multi-Currency Invoicing .0759 · Why Do I Need To Verify My Identity Or Business? .0556 · Why Is My Payment Delayed? .0526 | **#1** .1322 | .1322 | #2 |
| S7 | What Should I Do If My Account Is Restricted? .1333 (also relevant) · **Account Restrictions And Suspensions .0873 ✓** · How Do I Create A RelayPay Account? .0805 · Why Is My Account Under Review? .0761 · Account And Team Access .0643 · What Issues Require Human Support? .0179 | #2 .0873 | .1333 | #1 |
| S8 | **Can RelayPay Guarantee Payment Timelines? .0625 ✓** · Payout And Beneficiary Management .0546 · Version 2.3 .0306 · How Long Do Payments Take To Process? .0288 · How Long Does Verification Take? .0217 · Product Features Overview (intro) .0217 | **#1** .0625 | .0625 | #3 |
| X1 (searched as "… cryptocurrency") | How Do I Contact RelayPay Support? .1216 · Which Regions Does RelayPay Support? .0625 · What Issues Require Human Support? .0598 · What Should I Do If My Account Is Restricted? .0580 · Can I Create Invoices In Multiple Currencies? .0299 · Product Features Overview (intro) .0217 | Feature Availability And Limitations: **#8, .0206, outside top 6** | .1216 | #11 |
| X2 | (no chunk) | none expected; none returned | none | same |
| X3 | **How Long Do Payments Take To Process? .1176 ✓** · How Long Does Verification Take? .1000 · Payout And Beneficiary Management .0546 · Version 2.3 .0306 · Product Features Overview (intro) .0217 · What Is RelayPay? .0179 | **#1** .1176 | .1176 | #1 |

**X1 and the synonym.** It **did not** bring the "Cryptocurrency payments" chunk into the top 6. It fixed matching but not ranking:

- Before the synonym, the chunk matched only through "support", at #11 with rank .0104.
- With the synonym it also matches on "cryptocurrency". Its rank doubles to .0206 and it moves to #8. Searched alone, "cryptocurrency" matches only this chunk, at #1.
- It stays below six short FAQ chunks that have "Support" in their heading. Headings are weighted A, and normalization 34 divides by chunk length, which penalises this long list chunk.
- I did not force it further, for two reasons. Excluding "support" would break "How do I contact support". A larger match count, which would be 8 here, is your call.

**Summary, before → after:**

- The correct chunk is **#1** for S1, S4, S6, S8 and X3. Before, only S7 and X3 were #1.
- S2's correct chunk moved from #6 to #3.
- S7 dropped from #1 to #2, behind the equally relevant FAQ "What Should I Do If My Account Is Restricted?".
- S3's framing chunk dropped out of the top 6. That question is answered by a lookup tool, so the impact is low.
- **Correct chunks still not in the results: S3, S5 and X1.**

## Run 3 (confirmation): normalization 34, min_rank 0.05, match_count 6, synonyms on

Conversation: `test-retrieval-eval-2026-09-29T14-09-09-721Z`.

**Choosing the floor.**

- Correct chunks in the results rank: S1 .1379, S2 .0526, S4 .0558, S6 .1322, S7 .0873, S8 .0625, X3 .1176.
- The lowest is **S2 at .0526**. The highest round value that keeps all of them is **`KB_MIN_RANK = 0.05`**, a **margin of .0026**.

| Q | Chunks at min 0 | Chunks at 0.05 | Correct chunk at 0.05 |
| --- | --- | --- | --- |
| S1 | 6 | 5 | #1 kept |
| S2 | 6 | 3 | #3 kept |
| S3 | 6 | 4 | not in results (as at min 0) |
| S4 | 6 | 2 | #1 kept |
| S5 | 6 | 1 | not matched (as at min 0) |
| S6 | 6 | 6 | #1 kept |
| S7 | 6 | 5 | #2 kept |
| S8 | 6 | 2 | #1 kept |
| X1 | 6 | 4 | not in results (as at min 0) |
| X2 | 0 | 0, `insufficient_knowledge = true` | none expected |
| X3 | 6 | 3 | #1 kept |

**Result: no correct chunk lost.** The same three are missing at 0.05 as at min 0 (S3, S5 and X1). `insufficient_knowledge` is true only for X2.

## Caveats

1. **The margin is thin (.0026, about 5% of S2's rank).** A knowledge-base edit that lengthens "Why Is My Payment Delayed?", or changes its wording, could push it under the floor. Rerun `npm run eval:retrieval` after any KB or retrieval change.
2. **The floor interacts with X1.** X1's correct chunk ranks .0206, below 0.05. Raising the match count to 8 would not bring it back while the floor is 0.05. Fixing X1 means changing both settings: roughly match count 8 and a floor at or below .02, which would let far more noise through. Or the agent handles it: X1 still gets `insufficient_knowledge = false` with support-contact chunks, and should decline because none of them answers.
3. **The judgments of "correct chunk" are mine**, made from the chunk text. The Task 6 evals should check them end to end.
