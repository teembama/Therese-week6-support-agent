// Batch 2C: tool-backed grounding (step 2, D41) and outcome/timeline promise checks (step 3, D38).

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SentenceFilter } from "@relaypay/shared";
import { parseHeader, StreamingGate, validateHeader, type GateEvidence, type MessageOutcome, type ObservedTools } from "./gate.js";

const PAYOUTS = "frequently-asked-questions--how-long-do-payments-take-to-process";
const RESTRICT = "policies-and-compliance--account-restrictions";
const CHUNKS = new Map([
  [PAYOUTS, "How Long Do Payments Take To Process?\nLocal payouts typically take 1 to 2 business days. International payouts usually take 2 to 5 business days, depending on destination and banking partners."],
  [RESTRICT, "Account Restrictions\nRelayPay may restrict accounts when verification steps are incomplete, compliance reviews are ongoing, or suspicious activity is detected. Restricted users should contact support through official channels."],
]);
const RETRIEVED = new Set(CHUNKS.keys());
const TXN_9001 = JSON.stringify({ status: "success", found: true, transaction_id: "TXN-9001", type: "outgoing payout", transaction_status: "processing", support_summary: "Payout is processing within the normal expected window.", estimated_arrival: "2026-08-19", past_estimated_arrival: true, requires_escalation: false });

function observed(results: Array<[string, string, string?]>): ObservedTools {
  return {
    succeeded: (name) => results.some(([n, s]) => n === name && s === "success"),
    records: () => results.filter(([, s]) => s === "success").map(([, , r]) => r ?? "{}"),
  };
}

function run(deltas: string[], tools: ObservedTools = observed([]), callerText = "") {
  const evidence: GateEvidence = { chunks: CHUNKS, callerText, tools };
  const g = new StreamingGate(RETRIEVED, undefined, evidence);
  g.start();
  const spoken: string[] = [];
  for (const d of deltas) spoken.push(...g.text(d));
  const outcome: MessageOutcome = g.end("end_turn");
  if (outcome.kind === "final") spoken.push(...outcome.speak);
  return { spoken, outcome, filtered: g.takeFiltered() };
}

describe("header with tool=", () => {
  it("parses tool names, with or without the MCP prefix; absent means none", () => {
    assert.equal(parseHeader("[[type=answer; kb=none; tool=lookup_transaction]] x")?.tool, "lookup_transaction");
    assert.equal(parseHeader("[[type=answer; kb=none; tool=mcp__relaypay__lookup_payout]] x")?.tool, "lookup_payout");
    assert.equal(parseHeader(`[[type=answer; kb=${PAYOUTS}]] x`)?.tool, null);
    assert.equal(parseHeader("[[type=escalate; kb=none; tool=none]] x")?.type, "escalate");
  });
});

describe("type=answer grounding (verified from observed tool results, never the claim)", () => {
  const h = (text: string) => parseHeader(text)!;
  it("a lookup that returned success in this attempt grounds an answer with kb=none", () => {
    const v = validateHeader(h("[[type=answer; kb=none; tool=lookup_transaction]] x"), RETRIEVED, observed([["lookup_transaction", "success", TXN_9001]]));
    assert.equal(v.ok, true);
  });
  it("a claimed tool with no successful result is blocked (not_found, denied or never called)", () => {
    for (const results of [[], [["lookup_transaction", "not_found"]], [["lookup_transaction", "denied"]], [["lookup_payout", "success"]]] as Array<Array<[string, string]>>) {
      const v = validateHeader(h("[[type=answer; kb=none; tool=lookup_transaction]] x"), RETRIEVED, observed(results));
      assert.equal(v.ok, false, JSON.stringify(results));
    }
  });
  it("a false tool claim blocks even when a valid chunk is cited", () => {
    const v = validateHeader(h(`[[type=answer; kb=${PAYOUTS}; tool=lookup_customer]] x`), RETRIEVED, observed([]));
    assert.equal(v.ok, false);
  });
  it("log_conversation_event is not a grounding tool", () => {
    const v = validateHeader(h("[[type=answer; kb=none; tool=log_conversation_event]] x"), RETRIEVED, observed([["log_conversation_event", "success"]]));
    assert.equal(v.ok, false);
  });
  it("answer with neither kb nor tool is blocked; escalate needs neither", () => {
    assert.equal(validateHeader(h("[[type=answer; kb=none; tool=none]] x"), RETRIEVED).ok, false);
    assert.equal(validateHeader(h("[[type=escalate; kb=none; tool=none]] x"), RETRIEVED).ok, true);
  });
  it("a ticket the backend saw created grounds the confirmation", () => {
    const v = validateHeader(h("[[type=answer; kb=none; tool=create_support_ticket]] x"), RETRIEVED, observed([["create_support_ticket", "success", "{}"]]));
    assert.equal(v.ok, true);
  });
});

describe("sentence filter with tool records", () => {
  const tools = observed([["lookup_transaction", "success", TXN_9001]]);
  it("speaks a status and date that the record contains", () => {
    const r = run(["[[type=answer; kb=none; tool=lookup_transaction]] Your transaction TXN-9001 is processing. ", "It was estimated to arrive on August 19, 2026, and that date has passed."], tools, "Can you check transaction TXN-9001?");
    assert.equal(r.filtered.length, 0, JSON.stringify(r.filtered));
    assert.equal(r.spoken.length, 2);
  });
  it("drops an invented status, an invented date and an arrival promise", () => {
    const r = run([
      "[[type=answer; kb=none; tool=lookup_transaction]] Your transaction TXN-9001 is processing. ",
      "It has been delayed by the partner bank. ",
      "It should arrive on August 25. ",
      "It will arrive by tomorrow.",
    ], tools, "Can you check transaction TXN-9001?");
    assert.deepEqual(r.spoken, ["Your transaction TXN-9001 is processing."]);
    assert.deepEqual(r.filtered.map((f) => f.flags[0]!.kind), ["unsupported_status", "unsupported_specific", "timeline_promise"]);
  });
  it("speaks the verified account's own fields (live S3: 'your KYC status is approved')", () => {
    const customer = JSON.stringify({ status: "success", found: true, verified: true, customer_id: "CUS-1001", company_name: "LagosLedger", contact_name: "Amara Okafor", plan: "Growth", account_status: "active", kyc_status: "approved", requires_escalation: false });
    const r = run(["[[type=answer; kb=none; tool=lookup_customer]] Your account is active and your KYC status is approved."], observed([["lookup_customer", "success", customer]]), "I am Amara from LagosLedger. Can you check my account?");
    assert.equal(r.filtered.length, 0, JSON.stringify(r.filtered));
  });
  it("without a tool result, 'your transaction' is still an invented attribution", () => {
    const r = run([`[[type=answer; kb=${PAYOUTS}]] International payouts usually take 2 to 5 business days. `, "Your transaction is on track."]);
    assert.deepEqual(r.spoken, ["International payouts usually take 2 to 5 business days."]);
  });
});

describe("outcome and timeline promises (every spoken type)", () => {
  it("drops the live S7 sentences", () => {
    const r = run([
      `[[type=answer; kb=${RESTRICT}]] I'm sorry to hear your account is restricted. `,
      "RelayPay may apply restrictions when verification steps are incomplete, compliance reviews are ongoing, or suspicious activity is detected, and in most cases they're lifted once required reviews are completed. ",
      "Please contact RelayPay support through official support channels right away, and they'll help you.",
    ], observed([]), "My account was restricted and nobody is helping me.");
    assert.deepEqual(r.spoken, ["I'm sorry to hear your account is restricted."]);
    // The first also says "compliance reviews are ongoing", so it carries internal_term too (D45).
    assert.deepEqual(r.filtered.map((f) => f.flags.map((x) => x.kind).sort()), [["internal_term", "outcome_promise"], ["timeline_promise"]]);
  });
  it("speaks the hedged range when its chunk is cited", () => {
    const r = run([`[[type=answer; kb=${PAYOUTS}]] International payouts usually take 2 to 5 business days, depending on destination and banking partners.`]);
    assert.equal(r.spoken.length, 1);
    assert.equal(r.filtered.length, 0);
  });
  it("applies to clarify, decline and escalate too", () => {
    for (const header of ["[[type=clarify; kb=none]]", "[[type=decline; kb=none]]", "[[type=escalate; kb=none; tool=none]]"]) {
      const r = run([`${header} I can connect you with a specialist. `, "Your account will be approved right away."], observed([]), "my account");
      assert.deepEqual(r.spoken, ["I can connect you with a specialist."], header);
    }
  });
  it("does not flag ordinary speech, denials, or the escalation requests", () => {
    const f = new SentenceFilter([], "My account was restricted.", { mode: "full", allowedYourNouns: ["name", "email", "preferred", "callback", "time"] });
    for (const s of [
      "What else can I help you with today?",
      "Could I have your name and your email address?",
      "Do you have a preferred time for a callback?",
      "RelayPay can't guarantee that it will be resolved by tomorrow.",
      "A RelayPay support specialist will follow up with you by email.",
      "I'm not able to promise a timeline for the review.",
    ]) assert.deepEqual(f.check(s), [], s);
  });
  it("drops the live S7 confirmation (follow-up 'tomorrow morning' after an email; 'be in touch soon')", () => {
    const f = new SentenceFilter([], "Yes, that's correct. Tomorrow morning would be good for a callback.", { mode: "full", allowedYourNouns: ["name", "email", "preferred", "callback", "time", "account"] });
    const kinds = (x: string) => f.check(x).map((g) => g.kind);
    assert.deepEqual(kinds("A RelayPay support specialist will follow up with you at efua@accrastack.example tomorrow morning at your preferred time."), ["timeline_promise"]);
    assert.deepEqual(kinds("They'll look into your restricted account and be in touch soon."), ["timeline_promise"]);
    // Noting the caller's preferred time, in its own clause, is not a promise (the tool's own wording).
    assert.deepEqual(kinds("A RelayPay support specialist will follow up with you at efua@accrastack.example, and your preferred time, tomorrow morning, has been noted."), []);
  });
  it("never speaks 'compliance' unless the caller said it first (every type)", () => {
    const r = run(["[[type=clarify; kb=none; tool=none]] That transaction is under compliance review. ", "Would you like me to connect you with a specialist?"]);
    assert.deepEqual(r.spoken, ["Would you like me to connect you with a specialist?"]);
    assert.equal(r.filtered[0]!.flags[0]!.kind, "internal_term");
    const echo = run(["[[type=escalate; kb=none; tool=none]] I understand you're worried about the compliance review. ", "A specialist needs to look at this."], observed([]), "Is my account stuck in compliance?");
    assert.equal(echo.filtered.length, 0, JSON.stringify(echo.filtered));
  });
  it("a clause break ends a denial: 'I can't confirm it, but it will be lifted right away' is a promise", () => {
    const f = new SentenceFilter([], "", { mode: "promises" });
    assert.deepEqual(f.check("I can't confirm it, but it will be lifted right away.").map((x) => x.kind).sort(), ["outcome_promise", "timeline_promise"]);
  });
  it("a promise phrase the cited evidence itself contains is allowed", () => {
    const f = new SentenceFilter(["Card payments are processed immediately."], "", { mode: "full" });
    assert.deepEqual(f.check("Card payments are processed immediately."), []);
  });
  it("an escalation reply whose every sentence is dropped is blocked (SAFE_DECLINE_LINE)", () => {
    const r = run(["[[type=escalate; kb=none; tool=none]] Your review will be resolved within 24 hours."]);
    assert.equal(r.outcome.kind, "blocked");
  });
});
