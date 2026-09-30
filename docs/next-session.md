# Next session (not built yet)

1. **`final_status` for calls with no interaction.** A call with 0 answered turns maps to `failed` (reason `no_interaction`), whatever Vapi's ended reason says. Today `silence-timed-out` / `customer-ended-call` with 0 turns shows as `completed` (e.g. the 18:46 call on 2026-09-30).
2. **Attribution repair in the runtime filter.** For the "your banking partners" case, repair the sentence ("your X" → "our X" / "RelayPay's X" when the cited chunk says RelayPay's) instead of dropping it (D37/D38 `invented_attribution`).
3. **Paraphrase and noisy-speech eval set.** Measure retrieval and answer quality on:
   - rephrasings: "how much do you guys charge to send money abroad", "what's it cost to pay someone overseas";
   - disfluent transcripts: "what fees does really ch- really pay charge for international payment" (and the live "What phase does relay pay charge for. International. Payments?");
   - a half question from a mid-sentence pause: "what fees does".
   Add synonyms ONLY where a test shows a miss, each tied to its case (as with crypto).
4. **Vapi smart endpointing and keyword boosting:** the user sets these in the dashboard (settings and doc citations were given in chat on 2026-09-30). Also check the assistant's End Call Phrases, because no call has yet ended with `assistant-said-end-call-phrase` (D56).
