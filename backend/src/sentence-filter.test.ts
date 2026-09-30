// Runtime grounding sentence filter (D37): flagged answer sentences are dropped before speech.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { performance } from "node:perf_hooks";
import { SentenceFilter } from "@relaypay/shared";
import { StreamingGate, type GateEvidence, type MessageOutcome } from "./gate.js";

const PAYOUTS = "frequently-asked-questions--how-long-do-payments-take-to-process";
const FEES = "frequently-asked-questions--how-does-relaypay-charge-fees";
const GUARANTEE = "frequently-asked-questions--can-relaypay-guarantee-payment-timelines";
const CHUNKS = new Map([
  [PAYOUTS, "How Long Do Payments Take To Process?\nLocal payouts typically take 1 to 2 business days. International payouts usually take 2 to 5 business days, depending on destination and banking partners."],
  [FEES, "How Does RelayPay Charge Fees?\nFees vary based on transaction type, corridor, and payment method. RelayPay displays applicable fees before a transaction is confirmed."],
  [GUARANTEE, "Can RelayPay Guarantee Payment Timelines?\nNo. Payment timelines depend on external banking systems and regulatory checks."],
]);
const RETRIEVED = new Set(CHUNKS.keys());

function run(deltas: string[], callerText = "") {
  const evidence: GateEvidence = { chunks: CHUNKS, callerText };
  const g = new StreamingGate(RETRIEVED, undefined, evidence);
  g.start();
  const spoken: string[] = [];
  for (const d of deltas) spoken.push(...g.text(d));
  const outcome: MessageOutcome = g.end("end_turn");
  if (outcome.kind === "final") spoken.push(...outcome.speak);
  return { spoken, outcome, filtered: g.takeFiltered(), stats: g.filterStats };
}

describe("runtime sentence filter", () => {
  it("drops the live Kenya sentence and still speaks the range sentence", () => {
    const r = run([
      `[[type=answer; kb=${PAYOUTS}]] International payouts usually take 2 to 5 business days, depending on destination and banking partners. `,
      "I can't confirm a specific timeline for Kenya without more details about your banking setup there.",
    ], "How long do payouts to Kenya take?");
    assert.deepEqual(r.spoken, ["International payouts usually take 2 to 5 business days, depending on destination and banking partners."]);
    assert.equal(r.filtered.length, 1);
    assert.deepEqual(r.filtered[0]!.flags.map((f) => f.kind), ["invented_attribution"]);
    assert.equal(r.outcome.kind, "final");
  });

  it("drops the fees 'exact ... up front' sentence", () => {
    const r = run([
      `[[type=answer; kb=${FEES}]] Fees vary based on transaction type, corridor, and payment method. `,
      "RelayPay will show you the exact applicable fees before you confirm, so you'll know the cost up front.",
    ]);
    assert.deepEqual(r.spoken, ["Fees vary based on transaction type, corridor, and payment method."]);
    assert.deepEqual(r.filtered[0]!.flags.map((f) => f.term).sort(), ["exact", "up front"]);
  });

  it("leaves a clean answer untouched", () => {
    const text = "International payouts usually take 2 to 5 business days, depending on destination and banking partners. I can't confirm a specific timeline for Kenya.";
    const r = run([`[[type=answer; kb=${PAYOUTS}]] `, text], "How long do payouts to Kenya take?");
    assert.equal(r.spoken.join(" "), text);
    assert.equal(r.filtered.length, 0);
  });

  it("an answer whose every sentence is dropped is blocked (the turn speaks SAFE_DECLINE_LINE)", () => {
    const r = run([`[[type=answer; kb=${FEES}]] You'll always see the exact fee. `, "It is usually 3 percent for your account."]);
    assert.deepEqual(r.spoken, []);
    assert.equal(r.outcome.kind, "blocked");
    assert.match(r.outcome.kind === "blocked" ? r.outcome.reason : "", /every sentence dropped by the grounding filter \(2\)/);
  });

  it("filters mid-stream: a sentence split across deltas is checked whole", () => {
    const r = run([`[[type=answer; kb=${PAYOUTS}]] Local payouts typically take 1 to 2 business `, "days. Yours will arri", "ve in 3 days."]);
    assert.deepEqual(r.spoken, ["Local payouts typically take 1 to 2 business days."]);
    assert.deepEqual(r.filtered[0]!.flags.map((f) => [f.kind, f.term]), [["unsupported_specific", "3"]]);
  });

  it("allows numbers the caller said, negated intensifiers and echoed attributions", () => {
    const r = run([
      `[[type=answer; kb=${GUARANTEE}]] No, RelayPay can't guarantee that it arrives within 7 days. `,
      "Payment timelines for your payout depend on external banking systems and regulatory checks.",
    ], "Can you guarantee my payout arrives within 7 days?");
    assert.equal(r.filtered.length, 0, JSON.stringify(r.filtered));
    assert.equal(r.spoken.length, 2);
  });

  it("does not filter clarify or decline (no cited evidence to compare against)", () => {
    const r = run(["[[type=clarify; kb=none]] Is this about your payout or your invoice?"]);
    assert.deepEqual(r.spoken, ["Is this about your payout or your invoice?"]);
    const d = run(["[[type=decline; kb=none]] I can't look up your account, but I can connect you with RelayPay support."]);
    assert.equal(d.spoken.length, 1);
  });

  it("without evidence the gate does not filter (fixtures, replay)", () => {
    const g = new StreamingGate(RETRIEVED);
    g.start();
    const out = [...g.text(`[[type=answer; kb=${FEES}]] You'll always see the exact fee.`)];
    const end = g.end("end_turn");
    assert.equal(end.kind, "final");
    assert.deepEqual([...out, ...(end.kind === "final" ? end.speak : [])], ["You'll always see the exact fee."]);
  });

  it("adds well under 5ms per sentence", () => {
    const f = new SentenceFilter([...CHUNKS.values()], "How long do payouts to Kenya take? My invoice INV-2041 for 1,250 USD failed.");
    const sentence = "International payouts usually take 2 to 5 business days, depending on destination and banking partners, and I can't confirm your exact timeline for Kenya today.";
    f.check(sentence); // warm-up
    // Asserted on the mean and p99: the single worst sample can include a GC pause or a busy
    // laptop (seen up to ~5ms when the test files run in parallel), which is not filter cost.
    const times: number[] = [];
    for (let i = 0; i < 500; i++) {
      const t = performance.now();
      f.check(sentence);
      times.push(performance.now() - t);
    }
    times.sort((a, b) => a - b);
    const avg = times.reduce((a, b) => a + b, 0) / times.length;
    const p99 = times[Math.floor(times.length * 0.99)]!;
    const max = times[times.length - 1]!;
    console.log(`# filter cost per sentence: avg ${avg.toFixed(3)}ms, p99 ${p99.toFixed(3)}ms, max ${max.toFixed(3)}ms`);
    assert.ok(avg < 5 && p99 < 5, `avg ${avg}ms p99 ${p99}ms`);
  });
});
