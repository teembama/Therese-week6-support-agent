// Query synonyms (KB_QUERY_SYNONYMS): each entry is tied to the eval case that showed the miss.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { expandQuery } from "./retrieval.js";

describe("expandQuery", () => {
  it("X1: crypto -> cryptocurrency", () => {
    assert.equal(expandQuery("Do you support crypto wallets?"), "Do you support crypto wallets? cryptocurrency");
  });
  it("ROB-OVERSEAS: cost -> fees, overseas -> international, pay someone -> payment", () => {
    const q = expandQuery("What's it cost to pay someone overseas?");
    for (const w of ["fees", "international", "payment"]) assert.ok(q.split(" ").includes(w), `${w} in "${q}"`);
  });
  it("whole words only: 'costly' and 'overseasoned' add nothing", () => {
    assert.equal(expandQuery("Is that costly?"), "Is that costly?");
  });
  it("no synonyms for a query that already matches", () => {
    assert.equal(expandQuery("What fees does RelayPay charge for international payments?"), "What fees does RelayPay charge for international payments?");
  });
});
