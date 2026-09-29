// Gate unit tests with fixture model outputs. Run: npm run test:gate -w @relaypay/backend

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { evaluateReply, parseHeader, SegmentTracker, sentences, stripForSpeech } from "./gate.js";

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

describe("SegmentTracker (multi-step turns)", () => {
  const run = (t: SegmentTracker, text: string, toolUse: boolean, stop: string) => {
    t.start();
    t.textDelta(text);
    if (toolUse) t.toolUseStart();
    t.messageDelta(stop);
    return t.finish();
  };

  it("discards pre-tool thinking aloud and speaks only the final segment", () => {
    const t = new SegmentTracker();
    assert.equal(run(t, "Let me look that up for you.", true, "tool_use"), null);
    const final = run(t, `[[type=answer; kb=${FEES}]] Fees vary.`, false, "end_turn");
    assert.equal(final?.text, `[[type=answer; kb=${FEES}]] Fees vary.`);
    assert.deepEqual(t.discarded, ["Let me look that up for you."]);
  });

  it("discards a segment that has a valid header but also calls a tool", () => {
    const t = new SegmentTracker();
    assert.equal(run(t, `[[type=clarify; kb=none]] One moment while I check.`, true, "tool_use"), null);
    assert.equal(t.discarded.length, 1);
  });

  it("does not release a segment that ended without a terminal stop reason", () => {
    const t = new SegmentTracker();
    t.start();
    t.textDelta("[[type=decline; kb=none]] Sorry.");
    assert.equal(t.finish(), null);
  });
});
