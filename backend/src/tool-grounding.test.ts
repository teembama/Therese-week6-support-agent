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
    called: (name) => results.some(([n]) => n === name),
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
  it("decline/clarify accept a tool that was CALLED, whatever its status (D48; live 'can't share details' case)", () => {
    const denied = observed([["lookup_customer", "success", "{}"], ["lookup_transaction", "denied"]]);
    const r = run(["[[type=decline; kb=none; tool=mcp__relaypay__lookup_transaction]] I can't share details on that transaction reference over the phone. ", "Would you like me to connect you with a RelayPay specialist who can help?"], denied, "Can you check transaction TXN-9003?");
    assert.equal(r.outcome.kind, "final");
    assert.equal(r.spoken.length, 2);
    assert.equal(validateHeader(h("[[type=clarify; kb=none; tool=lookup_payout]] x"), RETRIEVED, observed([["lookup_payout", "not_found"]])).ok, true);
    // Not called at all: still a false claim.
    assert.equal(validateHeader(h("[[type=decline; kb=none; tool=lookup_payout]] x"), RETRIEVED, denied).ok, false);
    // type=answer still needs success (the live header was type=answer and stays blocked).
    assert.equal(validateHeader(h("[[type=answer; kb=none; tool=lookup_transaction]] x"), RETRIEVED, denied).ok, false);
  });
  it("a ticket the backend saw created grounds the confirmation", () => {
    const v = validateHeader(h("[[type=answer; kb=none; tool=create_support_ticket]] x"), RETRIEVED, observed([["create_support_ticket", "success", "{}"]]));
    assert.equal(v.ok, true);
  });
});

describe("gate violation mid-reply (D47)", () => {
  it("live case: 'I'd be happy to help, Amara.' then tool_use, then a valid answer -> the answer is spoken", () => {
    const customer = JSON.stringify({ status: "success", found: true, verified: true, customer_id: "CUS-1001", company_name: "LagosLedger", contact_name: "Amara Okafor", plan: "Growth", account_status: "active", kyc_status: "approved", requires_escalation: false });
    const results: Array<[string, string, string?]> = [];
    const g = new StreamingGate(RETRIEVED, undefined, { chunks: CHUNKS, callerText: "I am Amara from LagosLedger. Can you check my account?", tools: observed(results) });
    // Message 1: text, then a tool call. The first sentence already went out; the rest is dropped.
    g.start();
    const first = g.text("[[type=clarify; kb=none; tool=none]] I'd be happy to help, Amara. Could you give me your");
    const cut = g.toolUse();
    assert.deepEqual(first, ["I'd be happy to help, Amara."]);
    assert.equal(cut.violation, true);
    assert.deepEqual(g.text(" account email?"), []);
    assert.equal(g.end("tool_use").kind, "discarded");
    // The tool runs; message 2 has its own valid header and is spoken.
    results.push(["lookup_customer", "success", customer]);
    g.start();
    const spoken = g.text("[[type=answer; kb=none; tool=lookup_customer]] I've found your account, and it's active. ");
    const end = g.end("end_turn");
    assert.equal(end.kind, "final");
    assert.deepEqual([...spoken, ...(end.kind === "final" ? end.speak : [])], ["I've found your account, and it's active."]);
  });
  it("if nothing valid follows, the final message is blocked (the turn then appends the safe line)", () => {
    const g = new StreamingGate(RETRIEVED, undefined, { chunks: CHUNKS, callerText: "", tools: observed([]) });
    g.start();
    g.text("[[type=clarify; kb=none; tool=none]] I'd be happy to help, Amara. ");
    g.toolUse();
    g.end("tool_use");
    g.start();
    assert.equal(g.end("end_turn").kind, "blocked"); // empty final message, as in the live run
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
  it("a preferred time is spoken as noted, never as a commitment, even in the caller's own words", () => {
    const escalation = JSON.stringify({ status: "success", escalation_id: "ESC-1", ticket_id: "TKT-1", escalation_status: "open", call_booked: true, duplicate: false, follow_up_summary: 'A RelayPay support specialist will follow up with you at efua@accrastack.example, and your preferred time, "tomorrow morning", has been noted.' });
    const r = run([
      "[[type=escalate; kb=none; tool=create_escalation]] I've noted tomorrow morning as your preferred callback time. ",
      "A representative will call you tomorrow morning. ",
      "A representative will follow up.",
    ], observed([["create_escalation", "success", escalation]]), "Yes, that's correct. Tomorrow morning would be good for a callback.");
    assert.deepEqual(r.spoken, ["I've noted tomorrow morning as your preferred callback time.", "A representative will follow up."]);
    assert.deepEqual(r.filtered.map((f) => f.flags.map((x) => x.kind)), [["timeline_promise"]]);
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

describe("full filter on decline, clarify and escalate (D58, audit G2/G3)", () => {
  const S7 = "My account is restricted and nobody is helping me. This is really frustrating.";
  it("escalate: an invented diagnosis is filtered, even when the caller said 'my account'", () => {
    const r = run(["[[type=escalate; kb=none; tool=none]] I'm sorry this has been frustrating. ", "Your account was likely flagged because of unusual activity. ", "A RelayPay specialist needs to review it, and I can arrange a callback."], observed([]), S7);
    assert.deepEqual(r.spoken, ["I'm sorry this has been frustrating.", "A RelayPay specialist needs to review it, and I can arrange a callback."]);
    assert.deepEqual(r.filtered.map((f) => f.flags.map((x) => x.kind)), [["speculative_diagnosis", "speculative_diagnosis", "speculative_diagnosis"]]);
  });
  it("escalate: evidence is tool results + caller words, not cited chunks ('suspicious activity' from a chunk can't be pinned on the caller)", () => {
    const r = run([`[[type=escalate; kb=${RESTRICT}; tool=none]] Your account was restricted due to suspicious activity. `, "A specialist can help."], observed([]), S7);
    assert.deepEqual(r.spoken, ["A specialist can help."]);
  });
  it("decline: an unsupported number is filtered (previously only promises were checked)", () => {
    const r = run(["[[type=decline; kb=none; tool=none]] Transfers to Kenya cost 3 percent, but I can't confirm that. ", "I can connect you with a RelayPay specialist if you'd like."]);
    assert.deepEqual(r.spoken, ["I can connect you with a RelayPay specialist if you'd like."]);
    assert.equal(r.filtered[0]!.flags[0]!.kind, "unsupported_specific");
  });
  it("decline: an invented strengthening word and attribution are filtered", () => {
    const r = run(["[[type=decline; kb=none; tool=none]] Your bank always delays these. ", "I can connect you with a specialist."]);
    assert.deepEqual(r.spoken, ["I can connect you with a specialist."]);
  });
  it("clarify: reference-format descriptions are spoken", () => {
    const r = run(["[[type=clarify; kb=none; tool=none]] Could you give me the reference? ", "It's TXN followed by four digits, like TXN-9001. ", "A payout reference is PAY followed by exactly four numbers."]);
    assert.equal(r.filtered.length, 0, JSON.stringify(r.filtered));
    assert.equal(r.spoken.length, 3);
  });
  it("clarify: an invented number outside a format description is still filtered", () => {
    const r = run(["[[type=clarify; kb=none; tool=none]] Payments over 5000 dollars need extra checks. ", "Which payment is it?"]);
    assert.deepEqual(r.spoken, ["Which payment is it?"]);
  });
  it("clarify: 'your X' in a question asks rather than claims; 'one' as a pronoun is not a number", () => {
    const r = run(["[[type=clarify; kb=none; tool=none]] Is your payment incoming or outgoing? ", "Is it one you're sending, or one you're expecting to receive?"], observed([]), "A payment is stuck.");
    assert.equal(r.filtered.length, 0, JSON.stringify(r.filtered));
  });
  it("escalate: 'your name and email' and 'your preferred time' stay allowed", () => {
    const r = run(["[[type=escalate; kb=none; tool=none]] Could I have your name and email? ", "I'll also note your preferred time for the callback."], observed([]), S7);
    assert.equal(r.filtered.length, 0, JSON.stringify(r.filtered));
  });
  it("decline: 'your service' is allowed (test:agent SEC-notes reply, 2026-10-01)", () => {
    const r = run(["[[type=decline; kb=none; tool=none]] I can't share internal notes over the phone. ", "I'm happy to help with questions about your service or look into a specific transaction for you."]);
    assert.equal(r.filtered.length, 0, JSON.stringify(r.filtered));
  });
  it("a denied diagnosis is not a diagnosis: \"I can't say why it was flagged\"", () => {
    const f = new SentenceFilter([], "", { mode: "full", nonAnswer: true });
    assert.deepEqual(f.check("I can't say why it was flagged."), []);
  });
  it("answers are unchanged: no diagnosis check (a cited chunk may explain causes)", () => {
    const f = new SentenceFilter(["Delays can happen due to bank processing times."], "", { mode: "full" });
    assert.deepEqual(f.check("Delays can happen due to bank processing times."), []);
  });
});
