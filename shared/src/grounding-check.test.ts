// Regression cases from live call 01a0ef14… (D30): the checker must flag both real answers, and
// must NOT flag cleaned versions that say only what the chunks support.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { checkGrounding, type GroundingFlagKind } from "./grounding-check.js";

const FEES_CHUNK = "Fees vary based on transaction type, corridor, and payment method. RelayPay displays applicable fees before a transaction is confirmed.";
const TIMING_CHUNK = "Local payouts typically take 1 to 2 business days. International payouts usually take 2 to 5 business days, depending on destination and banking partners.";

const kinds = (flags: ReturnType<typeof checkGrounding>) => new Set(flags.map((f) => f.kind));
const terms = (flags: ReturnType<typeof checkGrounding>, kind: GroundingFlagKind) => flags.filter((f) => f.kind === kind).map((f) => f.term);

describe("regression: fees answer from the live call", () => {
  const ANSWER = "Fees vary based on the specific transaction type, corridor, and payment method you're using. The good news is RelayPay will show you the exact applicable fees before you confirm any transaction, so you'll know the cost upfront.";

  it("flags 'exact' and 'upfront' as strengthening", () => {
    const flags = checkGrounding(ANSWER, [FEES_CHUNK], "What fees does Relay Pay charge for international. Payments?");
    assert.deepEqual(terms(flags, "strengthening_word").sort(), ["exact", "upfront"]);
  });

  it("a cleaned version passes with no flags", () => {
    const clean = "Fees vary based on transaction type, corridor, and payment method. RelayPay displays the applicable fees before you confirm a transaction.";
    assert.deepEqual(checkGrounding(clean, [FEES_CHUNK], "What fees does RelayPay charge?"), []);
  });
});

describe("regression: Kenya answer from the live call", () => {
  const ANSWER = "International payouts usually take 2 to 5 business days depending on the destination and banking partners. Kenya would fall within that range, but the exact time depends on your specific banking partners there.";
  const CALLER = "So how long do. Payouts to. Kenya?";

  it("flags the Kenya claim, the invented attribution and 'exact'", () => {
    const flags = checkGrounding(ANSWER, [TIMING_CHUNK], CALLER);
    assert.ok(kinds(flags).has("unsupported_specific"));
    assert.deepEqual(terms(flags, "unsupported_specific"), ["kenya (echoed from the caller)"]);
    assert.deepEqual(terms(flags, "invented_attribution"), ["your specific banking partners"]);
    assert.deepEqual(terms(flags, "strengthening_word"), ["exact"]);
  });

  it("a cleaned version passes: general policy stated, Kenya explicitly not confirmed", () => {
    const clean = "Local payouts typically take one to two business days, and international payouts usually take two to five business days, depending on destination and banking partners. I can't confirm the timeline for Kenya specifically.";
    assert.deepEqual(checkGrounding(clean, [TIMING_CHUNK], CALLER), []);
  });
});

describe("individual checks", () => {
  it("dropped hedge: the chunk's numbers stated without 'usually'", () => {
    const flags = checkGrounding("International payouts take 2 to 5 business days.", [TIMING_CHUNK]);
    assert.deepEqual(terms(flags, "dropped_hedge"), ["2 to 5"]);
  });

  it("unsupported specific: a number or percentage not in the chunks (the earlier invented '2% fee')", () => {
    const flags = checkGrounding("RelayPay charges a 2% fee on international payments.", [FEES_CHUNK]);
    assert.deepEqual(terms(flags, "unsupported_specific"), ["2%"]);
  });

  it("number words are normalised: 'one to two' matches '1 to 2'", () => {
    assert.deepEqual(checkGrounding("Local payouts typically take one to two business days.", [TIMING_CHUNK]), []);
  });

  it("a word the chunk itself uses is not strengthening", () => {
    assert.deepEqual(checkGrounding("RelayPay does not guarantee dispute outcomes.", ["RelayPay does not guarantee dispute outcomes or resolution timelines."]), []);
  });
});
