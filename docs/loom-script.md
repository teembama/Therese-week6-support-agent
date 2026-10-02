# Loom script (6–7 minutes, at least 80% live)

Each beat follows: **what the user does → what the system does → what happens → why it matters.**

- **[CLICK]** is a screen action. **SAY** is the narration. Caller lines are in quotes; speak them naturally.
- The model's wording varies a little between calls. Keep going: the points hold, and the database rows are the evidence.

## Before recording (5 minutes of prep)

1. **Audio:** wired earphones with a mic. Not the laptop speakers: the agent's voice feeds back into the microphone and is transcribed as the caller.
2. **Quiet:** Do Not Disturb on, a quiet room, and Zoom, Teams and WhatsApp closed.
3. **Warm-up:** run one throwaway guest call ("Hello?", then hang up) to warm the container.
4. **Tabs:**
   - (1) https://relaypay-backend-production-aa34.up.railway.app (the landing page);
   - (2) Discord, the support channel;
   - (3) `/staff`, signed in as `care@relaypay.example`, on **Scheduled callbacks**;
   - (4) Supabase → **SQL Editor**, with the snippets below;
   - (5) `docs/testing-evidence.md` on GitHub.
5. **Supabase snippets.** Replace `<ID>` with the call ID: snippet A lists the newest `voice` calls.
   ```sql
   -- A. latest calls
   select conversation_id, final_status, ended_reason from conversations where channel = 'voice' order by started_at desc limit 3;
   -- B. what was said, and the gate's notes
   select turn_index, user_transcript, answer_type, assistant_response, confidence_note from conversation_turns where conversation_id = '<ID>' order by turn_index;
   -- C. tool calls
   select turn_index, tool_name, status, result_summary from tool_calls where conversation_id = '<ID>' order by id;
   -- D. the booked callback (call 2)
   select escalation_id, ticket_id, user_name, user_email, preferred_time_text, callback_slot, call_booked, status from escalations where conversation_id = '<ID>';
   ```

---

## 0:00–0:30 · The problem, and what it does

**[CLICK]** Tab 1, the landing page.

**SAY:** "RelayPay's support team is overloaded, and a lot of what they answer is repetitive: fees, payout times, where's my transaction. This is a voice agent that answers those from approved information only, checks records safely, and hands risky cases to a person with a real callback booked. The model proposes; code decides what's spoken and written."

## 0:30–2:00 · Call 1, as a guest: answers, a lookup and a ticket

**[CLICK]** **Customer support** → **Continue as a guest** → **Start call**. You hear the ringback until it connects.

**1. A knowledge answer**
- **Caller:** "What fees does RelayPay charge for international payments?"
- **You hear:** "Fees vary based on transaction type, corridor, and payment method. RelayPay displays the applicable fees before you confirm a transaction."
- **SAY:** "Retrieval runs in the backend before the model, and every sentence is checked against the knowledge it cited before it's spoken."

**2. A lookup, with the filler line**
- **Caller:** "Can you check transaction TXN-9001?"
- **You hear:** "One moment while I check that." straight away, then "…TXN-9001 is a payout that's currently processing. The estimated arrival date on the record has passed. Would you like me to log a ticket?"
- **SAY:** "The filler is a fixed backend line, spoken the moment it hears a reference, before the model runs. The lookup tool never returns amounts."

**3. A ticket**
- **Caller:** "Yes, please."
- **You hear:** "One moment while I set that up. …A support ticket has been logged and the support team will follow up. Is there anything else I can help you with?"

**4. Goodbye**
- **Caller:** "No, that's all, thanks."
- **You hear:** "Thanks for calling RelayPay. Goodbye."
- **SAY:** "That goodbye is a fixed line from code. No model call."

## 2:00–4:15 · Call 2, as an existing customer: identity, refusals and a booked callback

**[CLICK]** **Customer support** → **I'm an existing customer** → Name "Amara", Email "amara@lagosledger.example" → **Start call**.
- **You hear:** "Hi Amara, this is RelayPay support…"
- **SAY:** "The form matched one customer, so the call is identified from its first turn. That's identification, not authentication: name and email aren't secrets."

**1. Account status**
- **Caller:** "Can you check my account status?"
- **You hear:** "…your account is active, on the Growth plan."
- **SAY:** "It didn't ask who I am again: the backend told it."

**2. Another customer's transaction**
- **Caller:** "Can you check TXN-9003?"
- **You hear:** a refusal: the agent can't share that reference and offers a specialist.
- **SAY:** "TXN-9003 belongs to a different customer. It gets the same answer as a reference that doesn't exist."

**3. No amounts**
- **Caller:** "How much was it?"
- **You hear:** a refusal: it can't share amounts.

**4. Escalation with a booked callback**
- **Caller:** "My account is blocked and I need to speak to someone."
- **You hear:** an offer of a specialist callback, and a check that it should contact amara@lagosledger.example. **Caller:** "Yes."
- **You hear:** "What day and time would you like the callback?"
- **Caller:** "Saturday at 5 PM."
- **You hear:** "One moment while I set that up." Then the refusal ("Saturday is outside our callback hours" or "Callbacks can't be booked at the weekend"), "Callbacks are available Monday to Friday, 9 AM to 5 PM Lagos time", and three weekday slots.
- **SAY:** "The tool refused it, not the prompt. Weekdays nine to five, half-hour slots, and the database blocks invalid and double bookings."
- **Caller:** repeat the first slot it offered, e.g. "Monday 5 October at 9 AM works."
- **You hear:** "Your callback is booked for Monday 5 October at 9 AM Lagos time."

**[CLICK]** End the call.

## 4:15–4:45 · The team side

**[CLICK]** Tab 2, Discord.
- **[POINT]** at the new escalation: "Callback booked: Mon 5 Oct, 09:00 WAT", the customer as verified, the caller's words.

**[CLICK]** Tab 3, `/staff` → **Refresh** on **Scheduled callbacks**.
- **[POINT]** at the card with the booked slot.

**SAY:** "The notification is written in the same database transaction as the escalation, then posted. Staff see booked callbacks sorted by time."

## 4:45–5:45 · What happened in Supabase (about 60 seconds)

**[CLICK]** Tab 4.

1. **Snippet A:** copy call 1's `conversation_id`.
2. **Snippet B** (call 1):
   - **[POINT]** at `answer_type` per turn and the fees turn's `confidence_note`.
   - If it shows `grounding_trimmed`, **SAY:** "The model added an unsupported clause, and the gate cut just that clause." Otherwise point at the `grounded on` note.
3. **Snippet C** (call 1):
   - **[POINT]** at `lookup_transaction | success` and `create_support_ticket | success`.
   - **SAY:** "Every tool call is logged with its status."
4. **Snippet D** (call 2):
   - **[POINT]** at `callback_slot`, `call_booked = true`, and Amara's name and email taken from the account.
   - **SAY:** "The refused Saturday isn't anywhere: nothing is written until a slot is booked."

## 5:45–6:30 · Evidence

**[CLICK]** Tab 5, `docs/testing-evidence.md`.

**SAY:** "We test the 8 PRD scenarios three times each, plus security and robustness cases, against the deployed system, with database checks and an LLM judge whose quotes are verified in code. The first run passed 15 of 34. After one round of fixes, 31 of 34. The known limit: a plausible claim with no number can slip past the runtime filter; the offline judge catches it."

## 6:30–6:50 · Close

**SAY:** "In one sentence: Vapi does the speech, our backend is its language model, Claude runs with six MCP tools, and code gates every sentence and enforces every rule in Supabase. Setup, tests and every decision are in the README and the decisions log. Thanks."

---

## After recording

Close the demo escalations to free their callback slots (replace the IDs with call 2's, and any warm-up call that created one):

```sql
update escalations set status = 'closed' where conversation_id in ('<CALL 2 ID>');
```

**If something goes wrong while recording:**
- **No audio, or the agent hears itself:** check the earphones; see the README's Troubleshooting section.
- **"We're getting a lot of calls right now":** wait 10 seconds and retry.
- **The slot it offers is already taken by an earlier test:** pick another offered slot, or close old demo escalations first.
