// Pure parts of the Batch 2B tools. The database behaviour is tested by scripts/test-tools.ts.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { callBookedFor, escalationKeys, escalationPreconditions, followUpSummary, inputSchema as escalationInput } from "./tools/create-escalation.js";
import { inputSchema as ticketInput, ticketIdempotencyKey } from "./tools/create-support-ticket.js";
import { inputSchema as eventInput } from "./tools/log-conversation-event.js";
import { accountEscalation, ALREADY_VERIFIED_OTHER, matchesCustomer } from "./tools/lookup-customer.js";
import { customerSafeStatus, customerSafeSummary, logEventBestEffort } from "./tools/common.js";
import { payoutSupportSummary, safeFailureReason } from "./tools/lookup-payout.js";
import { pastEstimatedArrival, transactionEscalation } from "./tools/lookup-transaction.js";

describe("lookup_customer", () => {
  it("requires escalation for restricted accounts and KYC review (compliance wins)", () => {
    assert.deepEqual(accountEscalation({ account_status: "active", kyc_status: "approved" }), { requires_escalation: false });
    assert.deepEqual(accountEscalation({ account_status: "restricted", kyc_status: "approved" }), { requires_escalation: true, escalation_category: "account" });
    assert.deepEqual(accountEscalation({ account_status: "restricted", kyc_status: "review required" }), { requires_escalation: true, escalation_category: "compliance" });
  });
});

describe("lookup_transaction", () => {
  it("past_estimated_arrival: set, not completed, and today is after it", () => {
    assert.equal(pastEstimatedArrival("processing", "2026-08-19", "2026-09-30"), true);
    assert.equal(pastEstimatedArrival("completed", "2026-08-15", "2026-09-30"), false);
    assert.equal(pastEstimatedArrival("processing", "2026-09-30", "2026-09-30"), false);
    assert.equal(pastEstimatedArrival("failed", null, "2026-09-30"), false);
  });
  it("failed -> offer_ticket (no escalation), review required -> compliance", () => {
    // D69: failed -> offer a ticket, not a specialist (only "review required" escalates).
    assert.deepEqual(transactionEscalation("failed"), { requires_escalation: false, offer_ticket: true });
    assert.deepEqual(transactionEscalation("review required"), { requires_escalation: true, escalation_category: "compliance" });
    assert.deepEqual(transactionEscalation("delayed"), { requires_escalation: false });
  });
});

describe("lookup_payout", () => {
  it("never passes an unknown failure reason through verbatim", () => {
    assert.equal(safeFailureReason("beneficiary details need review"), "The beneficiary details need review.");
    assert.equal(safeFailureReason("compliance review"), "The payout is under review.");
    assert.equal(safeFailureReason("sanctions screening hit on beneficiary"), "The payout could not be completed.");
    assert.equal(safeFailureReason(null), null);
  });
  it("support summary = status sentence + the transaction's summary", () => {
    assert.equal(payoutSupportSummary("processing", "Payout is processing within the normal expected window."), "The payout is processing. Payout is processing within the normal expected window.");
    assert.equal(payoutSupportSummary("review required", null), "The payout is under review.");
  });
});

describe("customer-safe status and summary (D45)", () => {
  it("review required is spoken as under review; seed summaries with compliance are replaced", () => {
    assert.equal(customerSafeStatus("review required"), "under review");
    assert.equal(customerSafeStatus("processing"), "processing");
    assert.equal(customerSafeSummary("Transaction requires compliance review. Escalate account-specific questions.", "transaction", "review required"), "The transaction is under review.");
    assert.equal(customerSafeSummary("Payout is processing within the normal expected window.", "transaction", "processing"), "Payout is processing within the normal expected window.");
  });
  it("a payout's embedded transaction summary is mapped too (PAY-7002 via TXN-9003)", () => {
    const s = payoutSupportSummary("review required", "Transaction requires compliance review. Escalate account-specific questions.");
    assert.equal(s, "The payout is under review.");
    assert.doesNotMatch(s, /compliance|escalate/i);
  });
});

describe("create_support_ticket", () => {
  it("idempotency key: conversation + category + transaction/payout id or none", () => {
    assert.equal(ticketIdempotencyKey("c1", "payout", null, "PAY-7002"), "ticket:c1:payout:PAY-7002");
    assert.equal(ticketIdempotencyKey("c1", "other", null, null), "ticket:c1:other:none");
    assert.equal(ticketIdempotencyKey("c1", "payment", "TXN-9004", "PAY-7003"), "ticket:c1:payment:TXN-9004");
  });
  it("strips a model-supplied customer_id, priority and conversation_id", () => {
    const r = ticketInput.parse({ category: "payment", summary: "Payout failed for a contractor", customer_id: "CUS-1003", priority: "low", conversation_id: "other" });
    assert.deepEqual(Object.keys(r).sort(), ["category", "summary"]);
  });
  it("rejects an unknown category", () => {
    assert.equal(ticketInput.safeParse({ category: "refund", summary: "Wants a refund please" }).success, false);
  });
});

describe("create_escalation", () => {
  it("idempotency keys: conversation + category, namespaced apart from plain tickets", () => {
    assert.deepEqual(escalationKeys("c1", "account"), { ticket: "escalation-ticket:c1:account", escalation: "escalation:c1:account" });
  });
  it("follow-up summary: a representative will follow up; no channel, address or time (D70)", () => {
    const s = followUpSummary();
    assert.match(s, /will follow up/);
    assert.doesNotMatch(s, /[^\s@]+@[^\s@]+/, "no email address");
    assert.doesNotMatch(s, /\bby (e-?mail|phone|call|text)\b|\be-?mail\b|\bphone\b/i, "no channel");
    assert.doesNotMatch(s, /\b(within|hours?|days?|minutes?|today|tonight|tomorrow|morning|afternoon|evening|soon|shortly|asap|am|pm|guarantee)\b/i, "no time words");
  });
  it("requires category and reason; name and email are optional in the schema (D90: filled from the account on form calls, required by the handler otherwise)", () => {
    assert.equal(escalationInput.safeParse({ user_email: "a@b.co", category: "account", reason: "Account restricted" }).success, true);
    assert.equal(escalationInput.safeParse({ category: "account" }).success, false);
    assert.equal(escalationInput.safeParse({ user_name: "Efua", user_email: "a@b.co", category: "refund", reason: "Account restricted" }).success, false);
  });
});

describe("log_conversation_event", () => {
  it("the model cannot log identity, ticket, escalation or gate events", () => {
    for (const t of ["identity_verified", "identity_failed", "identity_ambiguous", "ticket_created", "escalation_created", "gate_blocked"]) {
      assert.equal(eventInput.safeParse({ event_type: t, summary: "x" }).success, false, t);
    }
    assert.equal(eventInput.safeParse({ event_type: "declined_unsupported", summary: "Asked about crypto" }).success, true);
  });
});

describe("logEventBestEffort (D68: an event failure never turns a committed action into a tool error)", () => {
  const ctx = { conversationId: "test-conv", turnIndex: 0, attemptId: "ATT-TEST" };
  type FakeDb = Parameters<typeof logEventBestEffort>[0];
  it("BEFORE-eval M5 shape: the event RPC reports 'fetch failed' -> a note, no throw", async () => {
    const db = { rpc: async () => ({ data: null, error: { code: "", message: "TypeError: fetch failed" } }) } as unknown as FakeDb;
    const note = await logEventBestEffort(db, ctx, "identity_verified", "Caller verified as CUS-1001");
    assert.match(note, /^; event_write_failed \(identity_verified\): .*fetch failed/);
  });
  it("the RPC itself throws -> a note, no throw", async () => {
    const db = { rpc: async () => { throw new TypeError("fetch failed"); } } as unknown as FakeDb;
    assert.match(await logEventBestEffort(db, ctx, "ticket_created", "Ticket TKT-1"), /event_write_failed \(ticket_created\)/);
  });
  it("success -> empty note", async () => {
    const db = { rpc: async () => ({ data: 1, error: null }) } as unknown as FakeDb;
    assert.equal(await logEventBestEffort(db, ctx, "escalation_created", "Escalation ESC-1"), "");
  });
});

describe("create_escalation flow preconditions (D72)", () => {
  const base = { email_confirmed_by_caller: true };
  it("D98: no time -> refused: an escalation needs a booked callback; create a ticket instead, never say a callback is arranged", () => {
    for (const r of [escalationPreconditions({ ...base }), escalationPreconditions({ ...base, preferred_time_declined: false })]) {
      assert.match(r ?? "", /needs a booked callback day and time/);
      assert.match(r ?? "", /create a support ticket instead/);
      assert.match(r ?? "", /specialist will review it/);
      assert.match(r ?? "", /Never say a callback is arranged, booked or noted\./);
    }
  });
  it("D98: a DECLINED time is no longer an escalation (the same refusal: create a ticket)", () => {
    assert.match(escalationPreconditions({ ...base, preferred_time_declined: true }) ?? "", /create a support ticket instead/);
    assert.equal(callBookedFor({}), false);
  });
  it("preferred time given -> allowed, call_booked true", () => {
    assert.equal(escalationPreconditions({ ...base, preferred_time_text: "tomorrow morning" }), null);
    assert.equal(callBookedFor({ preferred_time_text: "tomorrow morning" }), true);
  });
  it("email not confirmed (missing or false) -> invalid_input reason: read it back first, checked before the time", () => {
    assert.match(escalationPreconditions({ preferred_time_text: "tomorrow morning" }) ?? "", /^Read the email back to the caller/);
    assert.match(escalationPreconditions({ email_confirmed_by_caller: false, preferred_time_declined: true }) ?? "", /^Read the email back/);
  });
  it("the reasons say nothing was written", () => {
    assert.match(escalationPreconditions({}) ?? "", /Nothing was written\.$/);
    assert.match(escalationPreconditions(base) ?? "", /Nothing was written\./);
  });
});

describe("lookup_customer identity matching and the one-account rule (D74)", () => {
  const amara = { customer_id: "CUS-1001", contact_email: "amara@lagosledger.example", company_name: "LagosLedger", contact_name: "Amara Okafor" };
  it("every given identifier must match the customer", () => {
    assert.equal(matchesCustomer(amara, { customerId: null, email: null, company_name: "Lagos Ledger", contact_name: "Amara" }), true);
    assert.equal(matchesCustomer(amara, { customerId: null, email: null, company_name: "AccraStack", contact_name: "Efua" }), false);
    assert.equal(matchesCustomer(amara, { customerId: null, email: null, company_name: "Acrostic", contact_name: "FY" }), false);
    assert.equal(matchesCustomer(amara, { customerId: null, email: null, contact_name: "Efua" }), false);
    assert.equal(matchesCustomer(amara, { customerId: "CUS-1001", email: "amara@lagosledger.example" }), true);
  });
  it("already_verified_other tells the agent: one account per call, offer a specialist, don't ask for more details", () => {
    assert.equal(ALREADY_VERIFIED_OTHER.reason, "already_verified_other");
    assert.match(ALREADY_VERIFIED_OTHER.message, /one account per call/);
    assert.match(ALREADY_VERIFIED_OTHER.message, /specialist/);
    assert.match(ALREADY_VERIFIED_OTHER.message, /Do not ask for more details/);
  });
});
