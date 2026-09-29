// Gate unit tests with fixture model outputs. Run: npm run test:gate -w @relaypay/backend

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { evaluateReply, parseHeader, sentences, StreamingGate, stripForSpeech } from "./gate.js";

const FEES = "frequently-asked-questions--how-does-relaypay-charge-fees";
const RETRIEVED = new Set([FEES, "product-features-overview--international-payments"]);

describe("evaluateReply", () => {
  it("accepts a valid answer header citing a retrieved chunk, and strips the header", () => {
    const v = evaluateReply(`[[type=answer; kb=${FEES}]] Fees depend on the transaction type, corridor and payment method.`, RETRIEVED);
    assert.equal(v.ok, true);
    if (!v.ok) return;
    assert.equal(v.type, "answer");
    assert.deepEqual(v.validKbIds, [FEES]);
    assert.equal(v.spoken, "Fees depend on the transaction type, corridor and payment method.");
    assert.ok(!v.spoken.includes("[["));
  });

  it("blocks an answer citing a kb id that was NOT retrieved", () => {
    const v = evaluateReply("[[type=answer; kb=policies-and-compliance--identity-verification]] You need a passport.", RETRIEVED);
    assert.equal(v.ok, false);
  });

  it("accepts an answer when at least one cited id was retrieved, and reports the unknown one", () => {
    const v = evaluateReply(`[[type=answer; kb=${FEES},made-up-chunk]] Fees vary.`, RETRIEVED);
    assert.equal(v.ok, true);
    if (v.ok) assert.deepEqual(v.unknownKbIds, ["made-up-chunk"]);
  });

  it("blocks type=answer with kb=none", () => {
    assert.equal(evaluateReply("[[type=answer; kb=none]] Fees are two percent.", RETRIEVED).ok, false);
  });

  it("blocks a reply with no header", () => {
    assert.equal(evaluateReply("RelayPay charges a 2% fee on international payments.", RETRIEVED).ok, false);
  });

  it("blocks a header that appears after 200 characters", () => {
    const late = `${"Let me explain how this works in some detail. ".repeat(5)}[[type=answer; kb=${FEES}]] Fees vary.`;
    assert.ok(late.indexOf("[[") > 200);
    assert.equal(evaluateReply(late, RETRIEVED).ok, false);
  });

  it("blocks a header that is not at the start of the reply, even if early", () => {
    assert.equal(evaluateReply(`Sure! [[type=answer; kb=${FEES}]] Fees vary.`, RETRIEVED).ok, false);
  });

  it("blocks a header whose own length exceeds the 200-character window", () => {
    const ids = Array.from({ length: 12 }, (_, i) => `${FEES}-${i}`).join(",");
    assert.equal(evaluateReply(`[[type=answer; kb=${FEES},${ids}]] Fees vary.`, RETRIEVED).ok, false);
  });

  it("blocks malformed headers and malformed kb ids", () => {
    assert.equal(evaluateReply("[[type=guess; kb=none]] Maybe.", RETRIEVED).ok, false);
    assert.equal(evaluateReply("[type=decline; kb=none] Sorry.", RETRIEVED).ok, false);
    assert.equal(evaluateReply("[[type=answer; kb=fees chunk]] Fees vary.", RETRIEVED).ok, false);
  });

  it("blocks a valid header followed by nothing speakable", () => {
    assert.equal(evaluateReply("[[type=decline; kb=none]]   **  ", RETRIEVED).ok, false);
  });

  it("accepts clarify and decline with kb=none, tolerating spacing and case", () => {
    const c = evaluateReply("  [[ TYPE = Clarify ; KB = none ]] Is this an outgoing payout or an incoming transfer?", RETRIEVED);
    assert.equal(c.ok && c.type, "clarify");
    const d = evaluateReply("[[type=decline; kb=none]] I can't confirm that, but I can connect you with support.", RETRIEVED);
    assert.equal(d.ok && d.type, "decline");
  });

  it("strips stray markdown, lists, tags and extra headers from the spoken text", () => {
    const v = evaluateReply(
      `[[type=answer; kb=${FEES}]] **Fees** vary by:\n- transaction _type_\n- corridor\n\n## Note\nSee [our pricing](https://x.example) <search_knowledge_base>q</search_knowledge_base> [[type=answer; kb=x]] and \`fees\`.`,
      RETRIEVED,
    );
    assert.equal(v.ok, true);
    if (!v.ok) return;
    assert.equal(v.spoken, "Fees vary by: transaction type corridor Note See our pricing q and fees.");
    assert.doesNotMatch(v.spoken, /[*#_`[\]<>]/);
  });
});

describe("parseHeader / helpers", () => {
  it("parses kb id lists", () => {
    assert.deepEqual(parseHeader(`[[type=answer; kb= ${FEES} , b-2 ]] x`)?.kbIds, [FEES, "b-2"]);
  });
  it("stripForSpeech keeps plain sentences intact", () => {
    assert.equal(stripForSpeech("Local payouts take 1 to 2 business days."), "Local payouts take 1 to 2 business days.");
  });
  it("splits sentences for streaming", () => {
    assert.deepEqual(sentences("One. Two? Three!"), ["One.", "Two?", "Three!"]);
  });
});

describe("StreamingGate (lever 4: sentence streaming after a valid header)", () => {
  // Feeds one message as a list of deltas; returns what would be spoken and the outcome.
  const feed = (gate: StreamingGate, deltas: string[], opts: { toolUseAfter?: number; stop?: string } = {}) => {
    gate.start();
    const spokenLive: string[] = [];
    let tool: ReturnType<StreamingGate["toolUse"]> | null = null;
    deltas.forEach((d, i) => {
      spokenLive.push(...gate.text(d));
      if (opts.toolUseAfter === i) tool = gate.toolUse();
    });
    const outcome = gate.end(opts.stop ?? (opts.toolUseAfter !== undefined ? "tool_use" : "end_turn"));
    const spokenAtEnd = outcome.kind === "final" ? outcome.speak : [];
    return { spoken: [...spokenLive, ...spokenAtEnd], spokenLive, outcome, tool: tool as ReturnType<StreamingGate["toolUse"]> | null };
  };

  it("streams sentences only after the header is complete and valid; the header is never spoken", () => {
    const g = new StreamingGate(RETRIEVED);
    g.start();
    assert.deepEqual(g.text("[[type=answer; kb"), []);
    assert.deepEqual(g.text(`=${FEES}]]\n\nFees vary by corridor`), []);
    assert.deepEqual(g.text(" and payment method. RelayPay shows"), ["Fees vary by corridor and payment method."]);
    assert.deepEqual(g.text(" applicable fees before you confirm."), []);
    const end = g.end("end_turn");
    assert.equal(end.kind, "final");
    if (end.kind === "final") {
      assert.deepEqual(end.speak, ["RelayPay shows applicable fees before you confirm."]);
      assert.deepEqual(end.validKbIds, [FEES]);
    }
  });

  it("header then tool_use after a sentence was spoken: output stops, violation reports what was sent", () => {
    const r = feed(new StreamingGate(RETRIEVED), ["[[type=clarify; kb=none]] One moment. ", "Let me check that for you."], { toolUseAfter: 0 });
    assert.deepEqual(r.tool, { violation: true, spokenBeforeToolUse: ["One moment."] });
    assert.deepEqual(r.spoken, ["One moment."]); // nothing after the tool_use start
    assert.equal(r.outcome.kind, "discarded");
  });

  it("header then tool_use before any sentence completed: nothing spoken, no violation", () => {
    const r = feed(new StreamingGate(RETRIEVED), ["[[type=clarify; kb=none]] One moment while I"], { toolUseAfter: 0 });
    assert.deepEqual(r.tool, { violation: false, spokenBeforeToolUse: [] });
    assert.deepEqual(r.spoken, []);
  });

  it("text before the header is never spoken and blocks the turn", () => {
    const r = feed(new StreamingGate(RETRIEVED), ["Sure! ", `[[type=answer; kb=${FEES}]] `, "Fees vary. By corridor. "]);
    assert.deepEqual(r.spoken, []);
    assert.equal(r.outcome.kind, "blocked");
  });

  it("headerless thinking aloud before a tool call is discarded silently; the next valid message streams", () => {
    const g = new StreamingGate(RETRIEVED);
    const pre = feed(g, ["Let me look that up. ", "Searching now. "], { toolUseAfter: 1 });
    assert.deepEqual(pre.spoken, []);
    assert.deepEqual(pre.tool, { violation: false, spokenBeforeToolUse: [] });
    const fin = feed(g, [`[[type=answer; kb=${FEES}]] Fees vary.`]);
    assert.deepEqual(fin.spoken, ["Fees vary."]);
  });

  it("an answer citing a kb id that was not retrieved streams nothing and is blocked", () => {
    const r = feed(new StreamingGate(RETRIEVED), ["[[type=answer; kb=made-up-chunk]] You pay two percent. ", "Always."]);
    assert.deepEqual(r.spoken, []);
    assert.equal(r.outcome.kind, "blocked");
  });

  it("no header within 200 characters: nothing spoken, blocked", () => {
    const r = feed(new StreamingGate(RETRIEVED), ["[[type=answer; kb=" + "x".repeat(220), "]] Fees vary."]);
    assert.deepEqual(r.spoken, []);
    assert.equal(r.outcome.kind, "blocked");
  });

  it("strips markdown split across deltas and never speaks it", () => {
    const r = feed(new StreamingGate(RETRIEVED), [`[[type=answer; kb=${FEES}]] **Fe`, "es** vary by _corridor_. ", "- See the `dashboard`."]);
    assert.deepEqual(r.spoken, ["Fees vary by corridor.", "See the dashboard."]);
  });

  it("valid header with an empty body is blocked", () => {
    const r = feed(new StreamingGate(RETRIEVED), ["[[type=decline; kb=none]]", "  "]);
    assert.equal(r.outcome.kind, "blocked");
  });
});
