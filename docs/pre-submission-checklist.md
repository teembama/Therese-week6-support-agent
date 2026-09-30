# Pre-submission checklist

Things that must be done or undone before the project is submitted.

- [ ] **Remove the debug structure log** (TEMPORARY, D26/D28).
  - Remove `backend/src/debug-shape.ts`, the `RELAYPAY_DEBUG_REQUEST_SHAPE` handling in `backend/src/server.ts`, and its entry in `.env.example`.
  - Remove the debug checks in `scripts/test-endpoint.ts`.
  - Until then it logs only structure: the redacted path, header names, two OpenAI-SDK header values, key types, role sequence, `numModelRequestInTurn`, and a short hash and length of the last caller message. Never content or the token.
- [ ] **Rotate `VAPI_LLM_SECRET` after the demo** (D26). Generate a new value, then update `.env`, the host's environment and the Vapi base URL.
- [ ] **Replace the Vapi public key once the deployed origin exists** (Batch 2D). The current key is restricted to our assistant with transient assistants OFF, but has NO allowed origins, because the dashboard rejected every localhost format.
  - After deploying, create a NEW public key with allowed origin = the Railway https origin (scheme + host, no path or trailing slash, e.g. `https://<service>.up.railway.app`), restricted to our assistant, transient assistants OFF.
  - Replace `VAPI_PUBLIC_KEY` in `.env` and in the Railway service variables, then redeploy.
  - Check that the page at `/` still starts a call from the deployed origin, and is rejected from any other origin.
  - Delete the old key in the Vapi dashboard.
- [ ] **Check Claude Haiku 4.5's deprecation status before grading** (D49, docs/model-choice.md). Its retirement floor is "not sooner than October 15, 2026".
  - Check https://platform.claude.com/docs/en/about-claude/model-deprecations.
  - If a retirement date is announced before or during the grading window, set `AGENT_MODEL=claude-sonnet-5-5` in Railway, instead of relying on the automatic fallback: that costs one failed attempt (~2.4 s) per turn.
  - Record the check (date, status) in docs/model-choice.md.
