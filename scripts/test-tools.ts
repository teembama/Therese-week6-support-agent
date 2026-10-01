// Batch 2B tool tests: the six support tools through the real MCP client and stdio server,
// against Supabase, in a fresh 'test-tools-…' conversation with a real active attempt.
// Requires migration 005 and a built mcp-server (npm run build). No agent involved.
//
// Order matters: the conversation is unverified at first, then verified as CUS-1001, then its
// attempt is replaced and every write tool must be denied.

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { createServiceClient, newAttemptId, transcriptHash } from "@relaypay/shared";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SERVER = resolve(REPO, "mcp-server", "dist", "main.js");

type Structured = Record<string, unknown>;

async function main(): Promise<number> {
  process.loadEnvFile(resolve(REPO, ".env"));
  const db = createServiceClient();
  const conversationId = `test-tools-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  const attemptId = newAttemptId();
  let failures = 0;
  const check = (ok: boolean, label: string, detail = "") => {
    console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail && !ok ? `  -> ${detail}` : ""}`);
    if (!ok) failures++;
  };
  const count = async (table: string) => {
    const { count: n, error } = await db.from(table).select("*", { count: "exact", head: true }).eq("conversation_id", conversationId);
    if (error) throw new Error(`${table} count failed: ${error.message}`);
    return n ?? 0;
  };

  const { error: beginError } = await db.rpc("begin_turn_attempt", {
    p_conversation_id: conversationId, p_channel: "test", p_caller: "scripts/test-tools.ts", p_turn_index: 0,
    p_attempt_id: attemptId, p_transcript_hash: transcriptHash("tools test"), p_user_transcript: "tools test",
  });
  if (beginError) throw new Error(`could not register test attempt: ${beginError.message}`);
  console.log(`test conversation: ${conversationId} (channel=test), attempt ${attemptId}`);

  const client = new Client({ name: "relaypay-test-tools", version: "0.1.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER],
    env: {
      ...getDefaultEnvironment(),
      SUPABASE_URL: process.env["SUPABASE_URL"]!,
      SUPABASE_SERVICE_ROLE_KEY: process.env["SUPABASE_SERVICE_ROLE_KEY"]!,
      CONVERSATION_ID: conversationId,
      TURN_INDEX: "0",
      ATTEMPT_ID: attemptId,
    },
    stderr: "pipe",
  });
  transport.stderr?.on("data", (d: Buffer) => process.stderr.write(`  [server stderr] ${d}`));
  await client.connect(transport);

  const expectedStatuses: string[] = [];
  let newer: string | null = null; // the attempt that replaces ours in the guard test
  // D40: no lookup ever returns an amount or currency, verified or not.
  const noAmounts = (s: Structured) => !/"(amount|currency|amount_withheld)"|2400|5300|USD|GBP/.test(JSON.stringify(s));
  const call = async (tool: string, args: Structured, expectStatus: string): Promise<Structured> => {
    const r = await client.callTool({ name: tool, arguments: args });
    const s = (r.structuredContent ?? {}) as Structured;
    console.log(`  ${tool}(${JSON.stringify(args)})\n    -> ${JSON.stringify(s)}`);
    expectedStatuses.push(expectStatus);
    return s;
  };

  try {
    console.log("\n== Customer identity");
    const companyOnly = await call("lookup_customer", { company_name: "Lagos Ledger" }, "denied");
    check(companyOnly["status"] === "denied" && companyOnly["reason"] === "needs_second_identifier", "company name only -> denied, needs_second_identifier");
    const conflicting = await call("lookup_customer", { contact_name: "Daniel", company_name: "Lagos Ledger" }, "not_found");
    const conflictText = JSON.stringify(conflicting).toLowerCase();
    check(conflicting["reason"] === "no_match" && conflicting["verified"] === false, "conflicting identifiers (Daniel + Lagos Ledger) -> no_match");
    check(!/daniel|lagos|contact_name|company_name|name was|company was/.test(conflictText), "no_match does not reveal which identifier was wrong");

    console.log("\n== Transaction before verification");
    const txnUnverified = await call("lookup_transaction", { transaction_id: "TXN-9001" }, "success");
    check(txnUnverified["found"] === true && noAmounts(txnUnverified), "TXN-9001 unverified -> amount and currency ABSENT");
    check(txnUnverified["status"] === "success" && txnUnverified["transaction_status"] === "processing", "tool status 'success' is not overwritten by the record's own status (transaction_status)");

    const reviewTxn = await call("lookup_transaction", { transaction_id: "TXN-9003" }, "success");
    const spokenFields = (x: Structured) => JSON.stringify([x["transaction_status"], x["payout_status"], x["support_summary"], x["failure_reason"]]);
    check(reviewTxn["transaction_status"] === "under review" && reviewTxn["support_summary"] === "The transaction is under review.", "unverified TXN-9003 -> 'under review', seed compliance summary replaced");
    check(!/compliance|escalate/i.test(spokenFields(reviewTxn)), "TXN-9003: no 'compliance' in any spoken field", spokenFields(reviewTxn));
    const malformed = await call("lookup_transaction", { transaction_id: "TXN-12" }, "invalid_input");
    check(malformed["status"] === "invalid_input", "malformed ID TXN-12 -> invalid_input");
    const unknown = await call("lookup_transaction", { transaction_id: "TXN-0000" }, "not_found");
    check(unknown["status"] === "not_found" && unknown["found"] === false, "unverified: unknown TXN-0000 -> found:false");

    console.log("\n== Payout before verification");
    const payout = await call("lookup_payout", { payout_id: "PAY-7002" }, "success");
    check(payout["status"] === "success" && payout["requires_escalation"] === true && payout["escalation_category"] === "compliance", "PAY-7002 -> requires_escalation, category compliance");
    check(noAmounts(payout), "PAY-7002 (5300 GBP) -> amount and currency ABSENT");
    check(payout["payout_status"] === "under review" && !/compliance|escalate/i.test(spokenFields(payout)), "PAY-7002: 'under review', no 'compliance' in any spoken field", spokenFields(payout));
    check(payout["failure_reason"] === "The payout is under review." && !String(payout["support_summary"]).includes("undefined"), "PAY-7002 failure_reason is the customer-safe text");
    const byTxn = await call("lookup_payout", { transaction_id: "TXN-9004" }, "success");
    check(byTxn["payout_id"] === "PAY-7003" && byTxn["failure_reason"] === "The beneficiary details need review.", "lookup by transaction_id TXN-9004 -> PAY-7003");
    check(byTxn["offer_ticket"] === true && byTxn["requires_escalation"] === false, "failed payout PAY-7003 -> offer_ticket, no escalation (D69)");
    const failedTxn = await call("lookup_transaction", { transaction_id: "TXN-9004" }, "success");
    check(failedTxn["offer_ticket"] === true && failedTxn["requires_escalation"] === false && failedTxn["escalation_category"] === undefined, "failed TXN-9004 -> offer_ticket, no escalation (D69)");
    check(!/"(amount|currency)"|800|USD/.test(JSON.stringify(byTxn)), "PAY-7003 (800 USD) -> amount and currency ABSENT");
    const noPayout = await call("lookup_payout", { payout_id: "PAY-0000" }, "not_found");
    check(noPayout["found"] === false, "unverified: unknown PAY-0000 -> found:false");

    const verified = await call("lookup_customer", { contact_name: "Amara", company_name: "Lagos Ledger" }, "success");
    const verifiedText = JSON.stringify(verified);
    check(verified["verified"] === true && verified["customer_id"] === "CUS-1001", "'Amara' + 'Lagos Ledger' verifies CUS-1001");
    check(!/support_notes|contact_email|amara@|normal support access/.test(verifiedText), "output never contains support_notes or contact_email");
    check(verified["requires_escalation"] === false, "CUS-1001 (active, approved) -> requires_escalation false");
    const { data: conv } = await db.from("conversations").select("verified_customer_id").eq("conversation_id", conversationId).single();
    check((conv as Structured | null)?.["verified_customer_id"] === "CUS-1001", "conversations.verified_customer_id = CUS-1001");

    console.log("\n== After verification: ownership rule (D44)");
    const txnVerified = await call("lookup_transaction", { transaction_id: "txn 9001" }, "success");
    check(txnVerified["found"] === true && noAmounts(txnVerified), "own TXN-9001 -> success, amount and currency still ABSENT");
    check(txnVerified["past_estimated_arrival"] === true && txnVerified["type"] === "outgoing payout", "past_estimated_arrival true; type mapped from transaction_type");
    const otherTxn = await call("lookup_transaction", { transaction_id: "TXN-9003" }, "denied");
    const noRecordFields = (x: Structured) => !/transaction_status|payout_status|support_summary|failure_reason|scheduled_for|estimated_arrival|review|compliance|TXN-9003|PAY-7002/i.test(JSON.stringify(x));
    check(otherTxn["status"] === "denied" && otherTxn["reason"] === "not_available" && noRecordFields(otherTxn), "CUS-1003's TXN-9003 -> denied not_available, no status or summary");
    const unknownVerified = await call("lookup_transaction", { transaction_id: "TXN-0000" }, "denied");
    check(JSON.stringify(unknownVerified) === JSON.stringify(otherTxn), "verified: unknown TXN-0000 gets the identical result (existence not confirmed)");
    const otherPayout = await call("lookup_payout", { payout_id: "PAY-7002" }, "denied");
    check(otherPayout["status"] === "denied" && otherPayout["reason"] === "not_available" && noRecordFields(otherPayout), "CUS-1003's PAY-7002 -> denied not_available, no status or summary");
    const otherPayoutByTxn = await call("lookup_payout", { transaction_id: "TXN-9004" }, "denied");
    check(JSON.stringify(otherPayoutByTxn) === JSON.stringify(otherPayout), "CUS-1004's payout via TXN-9004 -> the same denial");
    const ownPayout = await call("lookup_payout", { payout_id: "PAY-7001" }, "success");
    check(ownPayout["status"] === "success" && ownPayout["payout_id"] === "PAY-7001", "own PAY-7001 -> success");

    console.log("\n== Support ticket");
    // F3: a verified caller can't file a ticket on another customer's record, and the denial is
    // identical to a reference that doesn't exist (no existence, status or priority leak).
    const ticketsBefore = await count("support_tickets");
    const foreignTxn = await call("create_support_ticket", { category: "payment", summary: "Caller asks about transaction TXN-9003", transaction_id: "TXN-9003" }, "denied");
    check(foreignTxn["status"] === "denied" && foreignTxn["reason"] === "not_available" && foreignTxn["priority"] === undefined && noRecordFields(foreignTxn), "verified CUS-1001 + CUS-1003's TXN-9003 -> denied not_available, no priority");
    const foreignPayout = await call("create_support_ticket", { category: "payout", summary: "Caller asks why payout PAY-7002 is on hold", payout_id: "PAY-7002" }, "denied");
    check(foreignPayout["status"] === "denied" && foreignPayout["reason"] === "not_available", "verified CUS-1001 + CUS-1003's PAY-7002 -> denied not_available");
    const missingTxn = await call("create_support_ticket", { category: "payment", summary: "Caller asks about transaction TXN-0000", transaction_id: "TXN-0000" }, "denied");
    check(JSON.stringify(missingTxn) === JSON.stringify(foreignTxn), "verified: unknown TXN-0000 gets the identical denial (existence not confirmed)");
    check((await count("support_tickets")) === ticketsBefore, "denied ticket calls wrote nothing");

    const t1 = await call("create_support_ticket", { category: "payout", summary: "Caller asks when contractor payout PAY-7001 will land", payout_id: "PAY-7001", customer_id: "CUS-1003", priority: "high" }, "success");
    const { data: t1Row } = await db.from("support_tickets").select("customer_id, priority, payout_id, status").eq("ticket_id", String(t1["ticket_id"])).single();
    check(t1["status"] === "success" && t1["ticket_status"] === "open" && t1["duplicate"] === false && t1["priority"] === "normal", "own PAY-7001 -> ticket created; model-supplied priority ignored (computed normal)");
    check((t1Row as Structured | null)?.["customer_id"] === "CUS-1001", "model-supplied customer_id CUS-1003 ignored; ticket customer = verified CUS-1001", JSON.stringify(t1Row));
    const t1again = await call("create_support_ticket", { category: "payout", summary: "Same issue, asked again", payout_id: "PAY-7001" }, "success");
    check(t1again["ticket_id"] === t1["ticket_id"] && t1again["duplicate"] === true, "duplicate returns the same ticket");
    const t2 = await call("create_support_ticket", { category: "payment", summary: "Caller asks about payout TXN-9001 arrival", transaction_id: "TXN-9001" }, "success");
    check(t2["priority"] === "normal" && t2["ticket_id"] !== t1["ticket_id"], "processing transaction -> separate ticket, priority normal");

    console.log("\n== Escalation");
    const badEmail = await call("create_escalation", { user_name: "Amara Okafor", user_email: "amara at lagos ledger", category: "payment", reason: "Payout past its estimated arrival" }, "invalid_input");
    check(badEmail["status"] === "invalid_input" && (await count("escalations")) === 0, "bad email -> invalid_input, nothing written");
    const e1 = await call("create_escalation", { user_name: "Amara Okafor", user_email: "amara at lagos ledger dot example", category: "payment", reason: "Payout past its estimated arrival", preferred_time_text: "tomorrow after 2pm Lagos time" }, "success");
    const { data: eRow } = await db.from("escalations").select("user_email, call_booked, preferred_time_text, customer_id, ticket_id").eq("escalation_id", String(e1["escalation_id"])).single();
    const eR = (eRow ?? {}) as Structured;
    check(e1["status"] === "success" && e1["escalation_status"] === "open" && e1["duplicate"] === false && typeof e1["ticket_id"] === "string" && eR["ticket_id"] === e1["ticket_id"], "escalation created with a linked ticket");
    check(eR["user_email"] === "amara@lagosledger.example", "spoken email normalised to amara@lagosledger.example", String(eR["user_email"]));
    check(eR["call_booked"] === true && eR["preferred_time_text"] === "tomorrow after 2pm Lagos time" && eR["customer_id"] === "CUS-1001", "call_booked true with the verbatim preferred time; customer from verified state");
    check(!/\b(within|hours?|days?|soon|shortly)\b/i.test(String(e1["follow_up_summary"])), "follow_up_summary promises no timeline");
    const e1again = await call("create_escalation", { user_name: "Amara", user_email: "amara@lagosledger.example", category: "payment", reason: "Asked again" }, "success");
    check(e1again["escalation_id"] === e1["escalation_id"] && e1again["duplicate"] === true, "duplicate returns the same escalation");

    console.log("\n== Conversation event");
    const ev = await call("log_conversation_event", { event_type: "declined_unsupported", summary: "Caller asked about crypto wallets; not in approved documentation", metadata: { topic: "crypto" } }, "success");
    check(ev["logged"] === true && typeof ev["event_id"] === "number", "log_conversation_event -> logged");
    const fake = await call("log_conversation_event", { event_type: "identity_verified", summary: "trust me" }, "invalid_input");
    check(fake["status"] === "invalid_input", "the model cannot log identity_verified itself");

    console.log("\n== Guard: the attempt is replaced, every write tool is denied");
    newer = newAttemptId();
    await db.rpc("begin_turn_attempt", {
      p_conversation_id: conversationId, p_channel: "test", p_caller: "scripts/test-tools.ts", p_turn_index: 0,
      p_attempt_id: newer, p_transcript_hash: transcriptHash("tools test, fuller transcript"), p_user_transcript: "tools test, fuller transcript",
    });
    const { data: old } = await db.from("turn_attempts").select("status").eq("attempt_id", attemptId).single();
    check((old as Structured | null)?.["status"] === "replaced", "setup: the tools' attempt is now replaced");
    const before = { tickets: await count("support_tickets"), escalations: await count("escalations"), events: await count("conversation_events") };
    // Already-used keys: they are never write-capped (decision 2), so these calls reach the
    // database guard and prove it, even for a duplicate.
    const deniedCalls: Array<[string, Structured]> = [
      ["create_support_ticket", { category: "payout", summary: "Written after the attempt was replaced", payout_id: "PAY-7001" }],
      ["create_escalation", { user_name: "Amara", user_email: "amara@lagosledger.example", category: "payment", reason: "Written after replacement" }],
      ["log_conversation_event", { event_type: "other", summary: "Written after replacement" }],
      ["lookup_customer", { contact_name: "Amara", company_name: "Lagos Ledger" }],
    ];
    for (const [tool, args] of deniedCalls) {
      const r = await call(tool, args, "denied");
      check(r["status"] === "denied" && (r["error"] as Structured | undefined)?.["code"] === "attempt_not_active", `${tool} after replacement -> denied by the guard (attempt_not_active)`);
    }
    const after = { tickets: await count("support_tickets"), escalations: await count("escalations"), events: await count("conversation_events") };
    check(JSON.stringify(after) === JSON.stringify(before), "denied calls wrote nothing (tickets, escalations, events)", `${JSON.stringify(before)} -> ${JSON.stringify(after)}`);
  } finally {
    await client.close();
  }

  console.log("\n== conversation_events");
  const { data: events } = await db.from("conversation_events").select("event_type, attempt_id, summary").eq("conversation_id", conversationId).order("id");
  for (const e of events ?? []) console.log(`  ${JSON.stringify(e)}`);
  const types = (events ?? []).map((e) => (e as Structured)["event_type"]).join(",");
  check(types === "identity_failed,identity_verified,ticket_created,ticket_created,escalation_created,declined_unsupported", "events: identity_failed, identity_verified, 2 tickets, escalation, declined_unsupported", types);

  console.log("\n== tool_calls");
  const { data: calls } = await db.from("tool_calls").select("tool_name, status, attempt_id, result_summary").eq("conversation_id", conversationId).order("id");
  for (const c of calls ?? []) console.log(`  ${JSON.stringify(c)}`);
  const rows = (calls ?? []) as Structured[];
  check(rows.length === expectedStatuses.length, `one tool_calls row per call (${expectedStatuses.length})`, String(rows.length));
  check(rows.every((c) => c["attempt_id"] === attemptId), "every row carries the spawning attempt_id");
  check(rows.map((c) => c["status"]).join(",") === expectedStatuses.join(","), "every row has the expected status", rows.map((c) => c["status"]).join(","));

  console.log("\n== Per-conversation write cap (decision 2): 2 tickets, 1 escalation, counted from the database");
  const capConversation = `${conversationId}-cap`;
  const capAttempt = newAttemptId();
  await db.rpc("begin_turn_attempt", {
    p_conversation_id: capConversation, p_channel: "test", p_caller: "scripts/test-tools.ts", p_turn_index: 0,
    p_attempt_id: capAttempt, p_transcript_hash: transcriptHash("write cap"), p_user_transcript: "write cap",
  });
  const capClient = new Client({ name: "relaypay-test-tools-cap", version: "0.1.0" });
  await capClient.connect(new StdioClientTransport({
    command: process.execPath,
    args: [SERVER],
    env: {
      ...getDefaultEnvironment(),
      SUPABASE_URL: process.env["SUPABASE_URL"]!,
      SUPABASE_SERVICE_ROLE_KEY: process.env["SUPABASE_SERVICE_ROLE_KEY"]!,
      CONVERSATION_ID: capConversation,
      TURN_INDEX: "0",
      ATTEMPT_ID: capAttempt,
    },
    stderr: "pipe",
  }));
  const capCall = async (tool: string, args: Structured): Promise<Structured> => {
    const s = ((await capClient.callTool({ name: tool, arguments: args })).structuredContent ?? {}) as Structured;
    console.log(`  ${tool}(${JSON.stringify(args)})\n    -> ${JSON.stringify(s)}`);
    return s;
  };
  try {
    const a = await capCall("create_support_ticket", { category: "other", summary: "Write cap test: first ticket" });
    // Unverified conversation: the current behaviour (D44 applies only once verified), including
    // the computed priority.
    const b = await capCall("create_support_ticket", { category: "payment", summary: "Write cap test: second ticket", transaction_id: "TXN-9003" });
    check(a["status"] === "success" && b["status"] === "success" && a["ticket_id"] !== b["ticket_id"], "tickets 1 and 2 created");
    check(b["priority"] === "high", "unverified + TXN-9003 (review required) -> ticket created, priority computed high (unchanged behaviour)");
    const c = await capCall("create_support_ticket", { category: "payout", summary: "Write cap test: third ticket", payout_id: "PAY-7003" });
    check(c["status"] === "denied" && c["reason"] === "conversation_write_limit", "third ticket -> denied, conversation_write_limit");
    const aAgain = await capCall("create_support_ticket", { category: "other", summary: "Write cap test: first ticket, asked again" });
    check(aAgain["status"] === "success" && aAgain["ticket_id"] === a["ticket_id"] && aAgain["duplicate"] === true, "a repeat of an existing ticket is not capped (returns it)");
    const e1 = await capCall("create_escalation", { user_name: "Amara Okafor", user_email: "amara@lagosledger.example", category: "payment", reason: "Write cap test: first escalation" });
    check(e1["status"] === "success" && e1["duplicate"] === false, "escalation 1 created (its own ticket doesn't count toward the 2)");
    const e2 = await capCall("create_escalation", { user_name: "Amara Okafor", user_email: "amara@lagosledger.example", category: "account", reason: "Write cap test: second escalation" });
    check(e2["status"] === "denied" && e2["reason"] === "conversation_write_limit", "second escalation in a different category -> denied, conversation_write_limit");
    const { data: capTickets } = await db.from("support_tickets").select("idempotency_key").eq("conversation_id", capConversation);
    const { data: capEscalations } = await db.from("escalations").select("escalation_id").eq("conversation_id", capConversation);
    const plain = ((capTickets ?? []) as Structured[]).filter((t) => String(t["idempotency_key"]).startsWith("ticket:")).length;
    check(plain === 2 && (capEscalations ?? []).length === 1 && (capTickets ?? []).length === 3, `rows: 2 plain tickets + 1 escalation with its ticket (got ${plain} plain, ${(capTickets ?? []).length} total, ${(capEscalations ?? []).length} escalations)`);
    const { data: capCalls } = await db.from("tool_calls").select("status").eq("conversation_id", capConversation).order("id");
    check(((capCalls ?? []) as Structured[]).map((r) => r["status"]).join(",") === "success,success,denied,success,success,denied", "cap tool_calls statuses: success,success,denied,success,success,denied");
  } finally {
    await capClient.close();
  }
  await db.rpc("finish_turn_attempt", { p_attempt_id: capAttempt, p_status: "failed", p_status_reason: "tools test harness (no agent)", p_metrics: {}, p_turn: null });
  await db.from("conversations").update({ ended_at: new Date().toISOString(), final_status: "completed", summary: "Write cap test run" }).eq("conversation_id", capConversation);

  // Close whichever attempt is still active (the replacing one, if the guard test ran).
  await db.rpc("finish_turn_attempt", { p_attempt_id: newer ?? attemptId, p_status: "failed", p_status_reason: "tools test harness (no agent)", p_metrics: {}, p_turn: null });
  await db.from("conversations").update({ ended_at: new Date().toISOString(), final_status: "completed", summary: "Batch 2B tool test run" }).eq("conversation_id", conversationId);
  console.log(`\n${failures === 0 ? "TEST-TOOLS OK" : `TEST-TOOLS FAILED (${failures})`}`);
  return failures === 0 ? 0 : 1;
}

main().then((code) => process.exit(code), (err: unknown) => {
  console.error(err);
  process.exit(1);
});
