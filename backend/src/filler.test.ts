// D91: early filler, filler by tool kind, and the anything-else question after a successful write.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { FILLER_LINE, WRITE_FILLER_LINE } from "./config.js";
import { ANYTHING_ELSE_LINE, fillerFor, needsAnythingElse, wantsEarlyFiller } from "./filler.js";
import { matchSocial } from "./social-fast-path.js";

describe("early filler (D91)", () => {
  it("references, written and spoken", () => {
    for (const t of ["Can you check TXN-9001?", "what about txn 9001", "Check T X N nine zero zero one please", "My payout PAY-7002 is stuck", "pay seven zero zero two", "It's TXN9003."]) {
      assert.equal(wantsEarlyFiller(t), true, t);
    }
  });
  it("account / transaction / payout status questions", () => {
    for (const t of ["Can you check my account status?", "What's the status of my payout?", "Where is my transfer?", "Could you look up my transaction?"]) {
      assert.equal(wantsEarlyFiller(t), true, t);
    }
  });
  it("not for general questions, greetings, or 'pay' without a reference", () => {
    for (const t of ["What fees does RelayPay charge for international payments?", "Hi there", "How do I pay an invoice?", "I want to dispute a payment and speak to someone.", "Thanks, that's all.", "How long do payouts take?"]) {
      assert.equal(wantsEarlyFiller(t), false, t);
    }
  });
});

describe("filler by tool (D91)", () => {
  it("lookups: check; writes: set up; log_conversation_event and others: none", () => {
    assert.equal(fillerFor("lookup_customer"), FILLER_LINE);
    assert.equal(fillerFor("lookup_transaction"), FILLER_LINE);
    assert.equal(fillerFor("lookup_payout"), FILLER_LINE);
    assert.equal(fillerFor("create_support_ticket"), "One moment while I set that up.");
    assert.equal(fillerFor("create_escalation"), WRITE_FILLER_LINE);
    assert.equal(fillerFor("log_conversation_event"), null);
    assert.equal(fillerFor("search_knowledge_base"), null);
  });
});

describe("anything-else after a successful write (D91)", () => {
  it("appended only after a write, and only if the reply doesn't already end with a question", () => {
    assert.equal(needsAnythingElse(true, "I've noted tomorrow morning as your preferred callback time. A RelayPay support representative will follow up."), true);
    assert.equal(needsAnythingElse(true, "Your ticket is TKT-1. Is there anything else?"), false);
    assert.equal(needsAnythingElse(false, "Fees vary by corridor."), false);
  });
  it("the appended line is the D73 anything-else context: 'no thanks' after it is a goodbye", () => {
    const line = `A RelayPay support representative will follow up. ${ANYTHING_ELSE_LINE}`;
    assert.equal(matchSocial("No thanks.", line), "goodbye");
  });
});
