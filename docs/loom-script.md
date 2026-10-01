# Loom script (6–7 minutes)

Each beat follows: **what the user does → what the system does → what happens → why it matters.**

- **[CLICK]** is a screen action. **SAY** is the narration.
- Speak caller lines naturally into the mic; they're in quotes.

## Before recording (5 minutes of prep)

1. **Open four tabs:**
   - (1) https://relaypay-backend-production-aa34.up.railway.app;
   - (2) Supabase → **SQL Editor**, with the queries below pasted into separate snippets;
   - (3) `docs/testing-evidence.md` on GitHub, scrolled to "BEFORE vs AFTER per scenario";
   - (4) `docs/decisions.md` on GitHub, scrolled to **D21**.
2. **Audio:** use the laptop's built-in mic and speakers, with no Bluetooth headset, and close Zoom, Teams and WhatsApp. Run one throwaway test call ("Hello?") to warm up the container.
3. **Supabase snippets.** Replace `<ID>` with the call ID after each call; it's the newest `voice` row.
   ```sql
   -- A. latest calls
   select conversation_id, final_status, ended_reason, summary from conversations where channel = 'voice' order by started_at desc limit 3;
   -- B. what was said, and the gate's notes
   select turn_index, user_transcript, answer_type, assistant_response, confidence_note from conversation_turns where conversation_id = '<ID>' order by turn_index;
   -- C. tool calls
   select turn_index, tool_name, status, input_summary, result_summary from tool_calls where conversation_id = '<ID>' order by id;
   -- D. the ticket and the event trail
   select ticket_id, category, priority, transaction_id, status from support_tickets where conversation_id = '<ID>';
   select turn_index, event_type, summary from conversation_events where conversation_id = '<ID>' order by id;
   -- E. evaluation runs
   select run_id, count(*) runs, count(*) filter (where passed) passed from evaluations where run_id in ('eval-2026-10-01T10-57-37-311Z', 'eval-2026-10-01T11-39-53-015Z') group by run_id;
   ```

---

## 0:00–0:30 · What it is

**[CLICK]** Tab 1, the voice page.

**SAY:** "This is a voice support agent for RelayPay, a cross-border payments company. You talk to it in the browser. It answers only from an approved knowledge base, it looks up customers, transactions and payouts through a custom MCP server, and it creates tickets and escalations in Supabase. The part I care most about: the model proposes, and code decides what's actually spoken and written. Let me show you."

## 0:30–2:15 · Live call 1: the happy path

**[CLICK]** **Start call**, then allow the mic.

**1. A knowledge answer**
- **Caller:** "What fees does RelayPay charge for international payments?"
- **The system:** retrieves knowledge-base chunks before the model runs. The model answers with a hidden header citing its chunk, and the gate checks every sentence against that chunk.
- **You hear:** "Fees vary based on transaction type, corridor, and payment method. RelayPay displays the applicable fees before you confirm a transaction."
- **SAY:** "That second sentence used to be lost. The model kept adding 'so you'll see *exactly* what applies to *your* payment', and our filter dropped the whole sentence. Now the filter cuts just the unsupported clause. I'll show you that in the database in a minute."

**2. A lookup, with the filler line**
- **Caller:** "Can you check transaction TXN-9001?"
- **The system:** calls `lookup_transaction` through MCP. While the tool runs, the backend speaks a fixed filler line.
- **You hear:** "One moment while I check that. …TXN-9001 is a payout that's currently processing. The estimated arrival date on the record has passed. Would you like me to log a ticket…?"
- **SAY:** "The filler is a fixed backend line, not model text, so the caller isn't left in silence while the tool runs. The tool returns only customer-safe fields. No amount ever leaves it."

**3. Creating a ticket**
- **Caller:** "Yes, please log a ticket."
- **The system:** calls `create_support_ticket`. The customer and the priority are set by the database, not the model. The ticket is idempotent and capped at 2 per call.
- **You hear:** "…A support ticket has been logged and the support team will follow up. Is there anything else I can help you with?"
- **SAY:** "Notice it says *will follow up*, with no 'we'll get it sorted' and no timeline. Promises like that are filtered in code."

**4. Goodbye**
- **Caller:** "No, that's all, thanks."
- **You hear:** "Thanks for calling RelayPay. Goodbye."
- **SAY:** "A goodbye after 'anything else?' is a deterministic fast path: no model call at all."

**[CLICK]** End the call if it's still connected.

## 2:15–3:45 · Live call 2: edge cases

**[CLICK]** **Start call**.

**1. Identity, verified in code**
- **Caller:** "I'm Amara from LagosLedger. Can you check my account?"
- **You hear:** "Thanks, Amara. Your account is active, on the Growth plan…"
- **SAY:** "Two identifiers, checked by the tool, not the model. The verified identity is stored in the database for the rest of the call."

**2. Another customer's reference is refused**
- **Caller:** "Can you check transaction TXN-9003?"
- **You hear:** "I can't share details on that reference… I can connect you with a RelayPay specialist."
- **SAY:** "TXN-9003 belongs to a different customer. Once you're verified, someone else's reference gets exactly the same answer as a reference that doesn't exist, so the call can't even confirm it exists."

**3. Amounts are never spoken**
- **Caller:** "Can you check TXN-9001? How much was that payment?"
- **You hear:** "I can't share transaction amounts over the phone…"
- **SAY:** "The model couldn't say the amount even if it wanted to: the tool never returns it."

**4. Declining an offer is not goodbye**
- If it offers a ticket or a specialist, **Caller:** "No, thank you."
- **You hear:** "No problem. Is there anything else I can help you with?"
- **SAY:** "In an earlier live call, 'No, thank you' to a ticket offer ended the call. Now declining an *offer* gets this line, and only a 'no' after 'anything else?' is a goodbye. A goodbye picked by the model is also guarded in code."

**Then:**
- **Caller:** "No, that's all." → "Thanks for calling RelayPay. Goodbye."

## 3:45–5:00 · What happened in Supabase (call 1)

**[CLICK]** Tab 2.
1. **Snippet A:** copy call 1's `conversation_id`.
   - **SAY:** "Every call is a conversation row. The final status comes from Vapi's end-of-call webhook. The summary is built from our own rows, not by an LLM."
2. **Snippet B:**
   - **[POINT]** at `answer_type` per turn, and at the fees turn's `confidence_note`: `grounding_trimmed: strengthening_word(exactly), invented_attribution(your payment): … -> RelayPay displays the applicable fees before you confirm a transaction.`
   - **SAY:** "Here's the gate's decision on record: what the model wrote, why it was flagged, and what was actually spoken."
3. **Snippet C:**
   - **[POINT]** at `lookup_transaction | success` and `create_support_ticket | success`.
   - **SAY:** "Every tool call is logged with its status, including denials, like TXN-9003 in the second call."
4. **Snippet D:**
   - **[POINT]** at the ticket row (category, priority `normal`, TXN-9001) and the `ticket_created` event.
   - **SAY:** "Conversation, turns, tool calls, ticket, events: the whole trail, written by code that's guarded by the current attempt, so a stale duplicate request from Vapi can't write anything."

## 5:00–6:00 · Evidence: what failed, and what changed

**[CLICK]** Tab 4, D21.

**SAY:** "The most important failure we saw: early on, the MCP server failed to start, the model had no tools, and it confidently said 'RelayPay charges a 2% fee'. That's invented. So now a tool-list guard checks the session before the model speaks. If the tools aren't exactly what we expect, the turn fails explicitly with a fallback line, and nothing is made up. That's the pattern throughout: when the model went wrong, we moved the rule into code."

**[CLICK]** Tab 3, the BEFORE vs AFTER table.

**SAY:** "We test it like this: 8 PRD scenarios three times each, plus security and robustness cases, against the deployed system. Checks run on the database rows, and an LLM judge has to quote its evidence, and code verifies each quote. The first run passed 15 of 34. We made one round of targeted fixes: clause trimming, promise patterns, routing, and a fixed line when a decline has no evidence. Then 31 of 34. The remaining failure is a known limit: a plausible claim with no number in it, like 'outside our control', can't be caught by pattern checks. The offline judge catches it."

**[CLICK]** Tab 2, snippet E. **SAY:** "Every run is an evaluations row."

## 6:00–6:30 · Architecture, in 30 seconds

**[CLICK]** The README's architecture diagram.

**SAY:** "Vapi does speech only and runs no tools. Our backend is its custom LLM. Each turn retrieves knowledge first, then runs Claude Haiku through the Agent SDK with exactly six MCP tools and nothing else: no shell, no files. Every sentence is gated before Vapi speaks it, and everything is recorded in Supabase. Haiku is fast enough for voice. The safety comes from the code around it, not from the prompt."

## 6:30–6:45 · Close

**SAY:** "The README has setup, the MCP Inspector commands and the test commands. The decisions log explains every choice, including the failures. Thanks."

---

**If something goes wrong while recording:**
- **No audio:** see the README's Troubleshooting section, then restart the call.
- **The model words a reply differently from the script:** keep going. The points still hold, and the database rows are the evidence.
- **It says "We're getting a lot of calls right now":** wait 10 seconds and retry. That's the concurrency cap or a deploy in progress.
