// Pure parts of the Batch 2B tools. The database behaviour is tested by scripts/test-tools.ts.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { escalationKeys, followUpSummary, inputSchema as escalationInput } from "./tools/create-escalation.js";
import { inputSchema as ticketInput, ticketIdempotencyKey } from "./tools/create-support-ticket.js";
import { inputSchema as eventInput } from "./tools/log-conversation-event.js";
import { accountEscalation } from "./tools/lookup-customer.js";
import { customerSafeStatus, customerSafeSummary } from "./tools/common.js";
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
  it("failed -> payment, review required -> compliance", () => {
    assert.deepEqual(transactionEscalation("failed"), { requires_escalation: true, escalation_category: "payment" });
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
  it("follow-up summary promises no timeline", () => {
    for (const s of [followUpSummary("a@b.co", undefined), followUpSummary("a@b.co", "tomorrow morning")]) {
      assert.doesNotMatch(s, /\b(within|hours?|days?|today|tonight|soon|shortly|asap|guarantee)\b/i, s);
    }
    assert.match(followUpSummary("a@b.co", "tomorrow morning"), /"tomorrow morning"/);
  });
  it("requires name, email, category and reason", () => {
    assert.equal(escalationInput.safeParse({ user_email: "a@b.co", category: "account", reason: "Account restricted" }).success, false);
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
