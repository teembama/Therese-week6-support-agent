# Next session (not built yet)

1. ~~**`final_status` for calls with no interaction.**~~ Done in code (D61, 2026-10-01); the existing rows are previewed and wait for approval.
2. ~~**Attribution repair in the runtime filter.**~~ Done (D62, 2026-10-01).
3. **Paraphrase and noisy-speech eval set.** Measure retrieval and answer quality on:
   - rephrasings: "how much do you guys charge to send money abroad", "what's it cost to pay someone overseas";
   - disfluent transcripts: "what fees does really ch- really pay charge for international payment" (and the live "What phase does relay pay charge for. International. Payments?");
   - a half question from a mid-sentence pause: "what fees does".
   Add synonyms ONLY where a test shows a miss, each tied to its case (as with crypto).
4. **Vapi endpointing and vocabulary for Soniox (stt-rt-v5, English):** the user sets these in the dashboard (settings and citations were given in chat on 2026-09-30). The transcriber fields are `maxEndpointDelayMs`, `endpointSensitivity`, `endpointLatencyAdjustmentLevel`, `customVocabulary` (→ Soniox `context.terms`) and `contextGeneral` (→ `context.general`), from the `SonioxTranscriber` schema in https://api.vapi.ai/api-json. The ID rule goes in `startSpeakingPlan.customEndpointingRules`.
5. **End the call from the backend, only if End Call Phrases is saved and still doesn't fire** (research only; nothing built). So far no call has ended with `assistant-said-end-call-phrase` (D36, D56). Documented options, most to least preferred:
   - **a. Live Call Control, say-then-end** (https://docs.vapi.ai/calls/call-features): after the goodbye turn, the backend POSTs `{"type": "say", "content": "Thanks for calling RelayPay. Goodbye.", "endCallAfterSpoken": true}` to `call.monitor.controlUrl`. The spec says `endCallAfterSpoken` is "the flag to end call after content is spoken".
     - This way the line is guaranteed to be spoken before the hangup, and no tool call goes through the model stream.
     - A bare `{"type": "end-call"}` also exists.
     - `monitorPlan.controlEnabled` must be on: the spec says both "Defaults to true" and "set … to `true`", so check it.
     - Unconfirmed: that the Custom LLM request's `call` object carries `monitor.controlUrl`, and which endedReason results (probably `assistant-ended-call-after-message-spoken`).
     - The goodbye turn would then stream an empty reply and let the control message speak the line. Otherwise the line is spoken twice.
   - **b. An `endCall` tool call in the SSE stream** (https://docs.vapi.ai/tools/default-tools, https://docs.vapi.ai/customization/tool-calling-integration): add `{"type": "endCall"}` to the assistant's `model.tools`. After the goodbye line, the backend emits a `delta.tool_calls` chunk naming `endCall`, with `finish_reason: "tool_calls"`; endedReason is `assistant-ended-call`.
     - **This would be the single narrow exception to "Vapi never runs tools" (D5):** one tool with no data access, emitted by the backend (never chosen by the model) only after the fixed goodbye line.
     - Unconfirmed: whether the streamed goodbye text is fully spoken before the hangup.
   - `endCallFunctionEnabled` is gone from the current spec, so don't use it.
   - Either way, D50's status mapping already counts `assistant-ended-call*` as `completed`.
6. ~~**`init` latency regression (+630 ms median) after Batch 3C**~~ Resolved: container variance, not code (latency.md, 2026-10-01). Was: (docs/latency.md, last section): redeploy the same commit to separate host variance from the MCP bundle change, then fix whichever it is.
7. ~~**Ticket vs escalation routing on a failed payment**~~ Done (D69). Was: (AFTER eval S6 r3): the "payment category = offer a ticket" rule is prompt-only. Consider enforcing it: on `escalation_category: payment`, create_escalation could be refused with a pointer to create_support_ticket.
8. ~~**Runner check false positive**~~ Done (commit 8d23e32). Was: (AFTER eval S8 r3): the S8 "no arrival promise" regex needs the backend's denial exemption ("I can't confirm when it will arrive" is not a promise).
