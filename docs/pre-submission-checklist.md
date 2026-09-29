# Pre-submission checklist

Things that must be done or undone before the project is submitted.

- [ ] **Remove the debug structure log** (TEMPORARY, D26/D28).
  - Remove `backend/src/debug-shape.ts`, the `RELAYPAY_DEBUG_REQUEST_SHAPE` handling in `backend/src/server.ts`, and its entry in `.env.example`.
  - Remove the debug checks in `scripts/test-endpoint.ts`.
  - Until then it logs only structure: the redacted path, header names, two OpenAI-SDK header values, key types, role sequence, `numModelRequestInTurn`, and a short hash and length of the last caller message. Never content or the token.
- [ ] **Rotate `VAPI_LLM_SECRET` after the demo** (D26). Generate a new value, then update `.env`, the host's environment and the Vapi base URL.
