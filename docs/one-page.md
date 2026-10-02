# RelayPay Voice Support Agent: one-page guide

**Live:** https://relaypay-backend-production-aa34.up.railway.app · **Records:** Supabase · **Logs:** Railway `relaypay-backend` · **Production:** commit `292b66b`, migrations 001–009

## Why it exists

RelayPay's support team is overloaded, and much of its volume is repetitive: fees, payout times, "where is my transaction?". This voice agent answers those from approved information and checks records safely. It hands risky cases (a restricted account, compliance, a dispute, a frustrated caller) to a human specialist, with a real callback booked.

## How to use it

- **Customers:** open the live link, choose **Customer support**, then **I'm an existing customer** (the account's name and email, e.g. Amara / amara@lagosledger.example) or **Continue as a guest**.
  - Press **Start call** (a ringback plays until it connects) and ask, e.g., "What fees do you charge?" or, as a guest, "Can you check TXN-9001? My customer ID is CUS-1001."
- **Staff:** **Staff sign in**, then the dashboard: **Raised tickets** and **Scheduled callbacks**; **Close** frees a callback slot.

## What it does, and doesn't

- **It does:**
  - answer general questions only from the approved knowledge base;
  - check account, transaction (`TXN-####`) and payout (`PAY-####`) status once identified; a guest also gives the owner's customer ID (2 misses lock lookups);
  - log a ticket for a failed or delayed payment;
  - escalate with a booked callback (no time → a ticket a specialist will review).
- **It never** states amounts, balances, stored emails or internal notes, explains compliance decisions, promises outcomes, or discusses another customer's records. When it can't confirm something, it offers a specialist.

## Callback booking (D97)

- **Slots:** Monday–Friday, 09:00–16:30 Lagos time, 30-minute slots, at least 30 minutes ahead.
- **Refusals:** the caller's words are parsed in code. A weekend, out-of-hours, past, taken or vague time ("tomorrow morning") is refused with the reason and **3 free slots**; nothing is written until a slot is booked.
- **Database:** a check constraint blocks invalid slots, and a unique index blocks double bookings.
- **Confirmation:** "booked for Monday 5 October at 11 AM Lagos time".

## How it works

Caller → Vapi (speech ⇄ text) → backend `/chat/completions` → Claude Haiku 4.5 → six MCP tools → Supabase.

- **One-time call pass:** each call needs one (5 minutes, one call). Without it the caller hears only "Please log in on the RelayPay page…".
- **Knowledge retrieval** is a backend step before the model. The model has **six MCP tools** (three lookups, ticket, escalation, event log) and no shell, file or web access.
- **Code, not the model, enforces the rules:** identity, "another customer's record isn't available", 2 tickets and 1 escalation per call, no amounts, the slot rules.
- **The gate:** each sentence is checked against this turn's evidence; unsupported text is dropped or trimmed.
- **Notifications:** new tickets and escalations go to an **outbox** in the same transaction, then to **Discord** ("Callback booked: Mon 5 Oct, 10:00 WAT"). Booked callbacks appear under **Scheduled callbacks**, by slot time.

## Where to look, and failures

**Records:** `conversations` (`final_status`, `ended_reason`, `vapi_metrics`), `conversation_turns` (`answer_type`, `confidence_note`), `tool_calls` (`status`, `result_summary`, e.g. `callback refused: weekend`), `escalations.callback_slot`, `notification_outbox.status`.

**Failures:** a database, model or tool failure gets "Sorry, I'm having trouble checking that right now…" (never a 500). Overload (more than 3 turns) gets "We're getting a lot of calls right now…". A call that doesn't connect in 15 s shows "Connection problem".

## Limits, speed and cost

- **Limits:** **8 s** to the first spoken sentence (then the fallback line, so the caller isn't left in silence); a **20 s** hard cap per turn (then it is stopped and recorded, so a stuck turn can't hold a slot); 3 concurrent turns, 1 replica, $0.05 and 4 model turns per caller turn.
- **Speed:** about **1.4 s** (p50, deployed) from the backend receiving a turn to its first spoken sentence. **3.0–5.4 s** average Vapi turn latency across today's 4 live calls with metrics, which measures the caller's end of speech to the agent's audio, including transcription, endpointing and speech synthesis.
- **Cost:** about $0.003 of model spend per turn; Vapi about $0.06 per minute.

## Known gaps

- **Identification:** name plus company verifies only on the guest path (the form checks name and email). The form is **identification, not authentication**: a name and an email aren't secrets.
- **Grounding:** a plausible claim with no number can slip through (the offline eval judge catches it).
- **D78:** a filler like "uh" before "no thanks" gets one more "anything else?". It fails safe; the fix is deferred.
- **D81:** the failure messages by type weren't triggered live (unit-tested only).
- **Calendar and hang-up:** no public holidays, one shared calendar, fixed 30-minute slots; calls end when the caller hangs up (a backend hang-up after the goodbye line is future work).
- **Code comments:** docs/system-overview.md §14 items 3, 4 and 9.

Details: docs/limitations.md and docs/decisions.md.
