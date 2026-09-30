# Known Limitations and Future Work

Known limitations of the submitted system, and what we would do next. Details are in `docs/decisions.md` (D-numbers).

## Limitations

| Area | Limitation | Why it's accepted now | Future work |
| --- | --- | --- | --- |
| Web voice page | `@vapi-ai/web` **2.7.1** (the latest, published 2026-09-18) pins **`@daily-co/daily-js ^0.87.0`** (published 2026-01-29). Chrome warns that "daily-js version 0.87.0 is nearing end of support". Daily is at 0.92.2 (checked 2026-09-30), and **no published Vapi SDK version uses a newer daily-js**. | The pinned pair works once the CSP allows what Daily needs (D55). Changing the transport right before submission is riskier than the warning. | Watch for a Vapi SDK release on a supported daily-js, then upgrade both pins together and re-run a live call. Don't override Daily's version under the SDK: it's untested against it. |
| Web voice page | The CSP allows `'unsafe-eval'` and `blob:` in `script-src`, because Daily's bundle and its Krisp worklet need them (D55). | There are no inline scripts, no user-generated content, pinned sources and a short source list. | Drop both if a Daily/Vapi release stops needing eval or blob: worklets. |
| CSP visibility | Our `/csp-report` route recorded the eval block, but **not** the `blob:` worklet block (that one was seen only in Chrome's console). | The console gave the evidence. | Add the `Reporting-Endpoints` / `report-to` header, and check whether worklet violations are reported there. |
| Grounding | The runtime filter drops **whole sentences** (D37). In deployed runs it correctly dropped Haiku's embellished second fees sentence 9 times out of 10. But it also dropped a correct payouts answer over one invented word ("…and **your** banking partners"), so the caller got the safe decline. | A lost sentence is safer than a spoken unsupported claim. | Measure this in the Task 6 evals. Consider one targeted retry ("rephrase without …"), or trimming the offending clause, before falling back to decline. |
| Grounding | The deterministic checks catch known patterns only (promises, attributions, strengthening, numbers, statuses). Paraphrase that adds meaning without those markers can pass (D32, D41). | The Task 6 LLM judge decides. | The judge, with verified quotes, run on every scenario several times. |
| Retrieval | The crypto question (X1) doesn't retrieve its answer chunk (D17). | It's a known lexical-retrieval gap and is documented. | Add synonyms or embeddings. |
| Scaling | Identical concurrent retries are joined in-process, which is correct only while **one instance** serves a call (D29). | We deploy one replica. | Route by call ID, or move the in-flight map to shared state, before scaling out. |
| Write caps | The per-conversation cap (2 tickets, 1 escalation) is counted in the tool, not enforced by a database constraint (D43). | Writes within a turn are serialised, and a replaced attempt can't write. | Add a database constraint or trigger (a migration). |
| Model | Claude Haiku 4.5 has a retirement floor of **2026-10-15**. It is mitigated by the env-only model choice and an automatic fallback on `model_not_found` (D49). | The deprecation status is checked before grading (checklist). | Move to the successor model once it's measured. |
| Vapi metrics | The units of `performanceMetrics`, and whether it is always present, aren't fully documented (D50). | Stored as received, with `null` when absent. | Confirm against real calls. |
| Hosting config | Railway's config-as-code (`railway.json`) is deprecated and keeps working until 2026-12-01. The first deploy also ignored its region (D53). | The region was fixed with `railway scale`, and the file still states it. | Migrate to `.railway/railway.ts`. |
