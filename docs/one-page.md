# RelayPay Voice Support Agent: one-page guide

**Live:** https://relaypay-backend-production-aa34.up.railway.app · **Records:** Supabase (project in `.env`) · **Logs:** Railway service `relaypay-backend`

## What it does, and doesn't do

**It does:**
- answers general RelayPay questions (fees, payout times, supported features) from the approved knowledge base only;
- checks a customer's account status, once the caller gives two identifiers (e.g. name and company);
- checks a transaction (`TXN-####`) or payout (`PAY-####`) status;
- logs a support ticket for a failed or delayed payment;
- escalates to a human specialist (restricted account, compliance, disputes, frustration), collecting name, email and a preferred callback time.

**It doesn't:**
- state amounts, balances, stored emails or internal notes;
- explain compliance decisions;
- promise outcomes or timelines;
- discuss another customer's records;
- answer anything the knowledge base doesn't cover. It says it can't confirm and offers a specialist.

## How to use it (a call)

1. Open the live link, click **Start call**, and allow the microphone.
2. Speak normally, for example: "What fees do you charge for international payments?" or "Can you check transaction TXN-9001?"
3. On lookups you hear "One moment while I check that." while it works.
4. Accept or decline offers ("Would you like me to log a ticket?"). Declining an offer doesn't end the call.
5. Say "No, that's all" after "Is there anything else?" and it says goodbye, or hang up.

## How it works

```
Caller ─► Vapi (speech ⇄ text) ─► Backend /chat/completions ─► Claude (Haiku 4.5) ─► MCP tools ─► Supabase
                                     │  retrieves KB chunks first; checks every sentence before speaking
                                     └─► spoken reply streamed back to Vapi ─► Caller
```

- Vapi turns speech into text and sends each caller turn to our backend.
- The backend fetches matching knowledge-base text, then runs one Claude turn that may use six tools. The tools are lookups, ticket, escalation and an event log; there is no shell, file or web access.
- Code, not the model, enforces the rules: the two-identifier check, "another customer's record isn't available", at most 2 tickets and 1 escalation per call, and no amounts.
- Every reply starts with a hidden header (answer, clarify, decline, escalate or social). The backend checks it, then checks each sentence against this turn's evidence. Unsupported sentences are dropped, trimmed or repaired.
- Thanks, goodbye and declined offers get fixed lines without calling the model.

## Where to look when something goes wrong

| Question | Look at |
| --- | --- |
| How did a call end? | `conversations.final_status` (`completed`, `failed`, or `abandoned` if the call never reported its end) and `ended_reason` (Vapi's reason). `summary` has turn counts by type; `vapi_metrics` has Vapi's latency and cost. |
| What did the agent say, and why? | `conversation_turns`: `assistant_response`, `answer_type` (answer, clarify, decline, escalate, social, blocked, error) and `confidence_note`. The note shows `grounding_filtered`, `grounding_trimmed`, `decline_fixed_line`, timeouts and the tools used. |
| Did a lookup or write work? | `tool_calls.status` (success, not_found, invalid_input, denied, error) with `input_summary` and `result_summary`. `event_write_failed` in the summary means the action succeeded but its event row didn't. |
| Was a ticket or escalation created? | `support_tickets` and `escalations`, for the `conversation_id` |
| What happened, in order? | `conversation_events`: identity_verified or identity_failed, ticket_created, escalation_created |
| Speculative or replaced requests? | `turn_attempts.status` (completed, replaced, aborted, failed) |
| Did the tests pass? | `evaluations` (`run_id`, `scenario`, `passed`, `notes`) and docs/testing-evidence.md |
| Is it up? | `GET /health` → `{"status":"ok"}`. Railway logs: `event="turn"` per turn, `request_error`, `shutdown_*`. |

## Failure behaviour

- **The database, the model or the tools are unavailable, or there's no reply within 8 s:** the caller hears "Sorry, I'm having trouble checking that right now. Could you try again in a moment?" The turn is recorded as `error`. The endpoint never returns a 500 to Vapi.
- **A reply fails the grounding check:** that sentence isn't spoken. If nothing is left, the caller hears the safe decline: "I'm sorry, I can't confirm that from our support information…"
- **More than 3 turns are running at once, or a deploy is in progress:** the caller hears "We're getting a lot of calls right now. Please try again in a moment." On deploys, in-flight turns get up to 10 s to finish.
- **Duplicate or partial requests from Vapi** are joined or replaced. Only the latest attempt can write.
- **A crash:** Railway restarts the service, and a sweep marks stale calls as `abandoned` within about 15 minutes.

## Key limits and costs

- **Limits:**
  - 1 replica;
  - 3 concurrent agent turns per process;
  - 20 s maximum per turn;
  - 4 model turns and $0.05 maximum per caller turn;
  - 2 tickets and 1 escalation per call.
- **Speed (deployed):** the first spoken sentence of a knowledge answer arrives about 1.4 s after the backend receives the turn (p50). Including Vapi speech, a turn averages about 2.7 s (one live call).
- **Cost:**
  - about $0.003 of model spend per turn (measured mean $0.0028);
  - Vapi about $0.06 per minute (one 66 s call cost $0.067);
  - Railway about $1–2 a month at idle.
- **Known gaps:**
  - a plausible claim with no number in a knowledge answer can slip through (caught offline by the eval judge);
  - unusual paraphrases can miss the knowledge base;
  - the end-call phrase has never been seen to hang up;
  - name plus company is enough to verify, by the scenario's design.

  Details are in docs/limitations.md.
