# Pre-submission checklist

Things that must be done or undone before the project is submitted.

## Tomorrow morning (2026-10-02), before the presentation

- [ ] **Remove the debug structure log** (TEMPORARY, D26/D28). Remove `backend/src/debug-shape.ts`, the `RELAYPAY_DEBUG_REQUEST_SHAPE` handling in `backend/src/server.ts`, its `.env.example` entry, and the debug checks in `scripts/test-endpoint.ts`. Run the unit suites, then redeploy (EU West).
- [ ] **Check Claude Haiku 4.5's deprecation status** at https://platform.claude.com/docs/en/about-claude/model-deprecations (retirement floor "not sooner than October 15, 2026"). Record the date and status in docs/model-choice.md. If a retirement date falls before or during grading, set `AGENT_MODEL=claude-sonnet-5-5` on Railway.
- [ ] **Delete the old Vapi public key** in the Vapi dashboard (the user does this). The Railway-origin key, created 2026-09-30, is the one in use.
- [x] **Fixed on 2026-10-01 (D72, after4 S7 3/3):** ~~Decide on the after3 S7 regression~~ (docs/testing-evidence.md, After3): fix `create_escalation`'s description so it is called only after the email read-back and the preferred-time question, then rerun S7 ×3 with a cap of at least $0.12.

## After the presentation

- [ ] **Rotate `VAPI_LLM_SECRET`** (D26):
  1. Generate a new value of at least 32 URL-safe characters.
  2. Set it on Railway (`railway variable set VAPI_LLM_SECRET --stdin`) and in `.env`.
  3. Update the Vapi assistant's **Custom LLM URL** (`https://<host>/v/<new>`) and **Server URL** (`https://<host>/v/<new>/vapi/events`).
  4. Redeploy, then make one test call.
  5. Old-token requests should now get 404.

## Earlier items (kept for history; the open ones are covered above)

- [ ] **Remove the debug structure log** (TEMPORARY, D26/D28).
  - Remove `backend/src/debug-shape.ts`, the `RELAYPAY_DEBUG_REQUEST_SHAPE` handling in `backend/src/server.ts`, and its entry in `.env.example`.
  - Remove the debug checks in `scripts/test-endpoint.ts`.
  - Until then it logs only structure: the redacted path, header names, two OpenAI-SDK header values, key types, role sequence, `numModelRequestInTurn`, and a short hash and length of the last caller message. Never content or the token.
- [ ] **Rotate `VAPI_LLM_SECRET` after the demo** (D26). Generate a new value, then update `.env`, the host's environment and the Vapi base URL.
- [ ] **Delete the old Vapi public key in the Vapi dashboard** (the user does this).
  - The Railway-origin public key is already in use: it was created 2026-09-30 with allowed origin = the Railway https origin, restricted to our assistant, transient assistants OFF.
  - The old key (no allowed origins) is no longer used and should be deleted.
- [ ] **Check Claude Haiku 4.5's deprecation status before grading** (D49, docs/model-choice.md). Its retirement floor is "not sooner than October 15, 2026".
  - Check https://platform.claude.com/docs/en/about-claude/model-deprecations.
  - If a retirement date is announced before or during the grading window, set `AGENT_MODEL=claude-sonnet-5-5` in Railway, instead of relying on the automatic fallback: that costs one failed attempt (~2.4 s) per turn.
  - Record the check (date, status) in docs/model-choice.md.
