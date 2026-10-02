# Pre-submission checklist

Things that must be done or undone before the project is submitted.

## Submission day (2026-10-02), before the presentation

- [ ] **FIRST: live smoke test** (unit-tested and deployed; live check pending; D78–D81, D83, D84). Do it before recording.
  0. **Log in** as `customer@relaypay.example` (D86). Check that the first call's `call_access` log line shows `status="ok"` with `pass_source="call.assistantOverrides.variableValues.callPass"` (`railway logs | grep call_access`): this confirms Vapi forwards the pass. Then try **Log out**: the login form returns.
  1. Start a call with the weather as the **first** question ("What's the weather in Lagos like?") → "That's outside what I can help with. I can only help with RelayPay payments and accounts. Is there anything RelayPay-related I can help you with?"
  2. Say "No thanks" → "Thanks for calling RelayPay. Goodbye."
  3. During the call, press **Hide captions** and then **Show captions**: the panel must disappear and come back, with the label changing.
  4. In a second call, ask for an escalation (verify, confirm the email, give "tomorrow morning"). "Your references" should show the escalation within about 3 s, Copy should say "Copied", and Discord should get the message with "Callback: requested", the caller's preference and the Action line.
  5. Record the result in docs/testing-evidence.md (the "Web page round and D78" table).
- [ ] **Delete the old Vapi public key** in the Vapi dashboard (the user does this). The Railway-origin key, created 2026-09-30, is the one in use.

## After the presentation

- [ ] **Rotate `VAPI_LLM_SECRET`** (D26):
  1. Generate a new value of at least 32 URL-safe characters.
  2. Set it on Railway (`railway variable set VAPI_LLM_SECRET --stdin`) and in `.env`.
  3. Update the Vapi assistant's **Custom LLM URL** (`https://<host>/v/<new>`) and **Server URL** (`https://<host>/v/<new>/vapi/events`).
  4. Redeploy, then make one test call.
  5. Old-token requests should now get 404.

## Done

- [x] **Removed the debug structure log** (TEMPORARY, D26/D28) on 2026-10-02: `backend/src/debug-shape.ts`, the `RELAYPAY_DEBUG_REQUEST_SHAPE` handling in `backend/src/server.ts`, its `.env.example` entry, its unit tests in `routing.test.ts`, and the debug checks in `scripts/test-endpoint.ts`. The variable was never set on Railway. Unit suites rerun, redeployed (EU West).
- [x] **Checked Claude Haiku 4.5's deprecation status** on 2026-10-02: Active, not deprecated, "Not sooner than October 15, 2026", with at least 60 days' notice before any retirement. Recorded in docs/model-choice.md. No model change.
- [x] **Fixed on 2026-10-01 (D72, after4 S7 3/3):** the after3 S7 regression. `create_escalation` is called only after the email read-back and the preferred-time question.
