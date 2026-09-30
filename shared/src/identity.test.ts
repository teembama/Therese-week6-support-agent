import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { contactNameMatches, normaliseEmail, normaliseName, normaliseReference } from "./identity.js";

describe("normaliseName", () => {
  it("ignores case, spaces and punctuation", () => {
    assert.equal(normaliseName("Lagos Ledger"), "lagosledger");
    assert.equal(normaliseName("LagosLedger"), normaliseName("lagos-ledger."));
    assert.equal(normaliseName("  Nairobi  Ops, "), "nairobiops");
  });
  it("strips diacritics", () => {
    assert.equal(normaliseName("Efúa Mensah"), "efuamensah");
  });
  it("keeps different names different", () => {
    assert.notEqual(normaliseName("Lagos Ledger"), normaliseName("Lagos Ledgers"));
  });
});

describe("contactNameMatches", () => {
  it("matches the full name or exactly one of its words", () => {
    assert.ok(contactNameMatches("Amara", "Amara Okafor"));
    assert.ok(contactNameMatches("okafor", "Amara Okafor"));
    assert.ok(contactNameMatches("Amara Okafor", "Amara Okafor"));
    assert.ok(contactNameMatches("amaraokafor", "Amara Okafor"));
  });
  it("does not match prefixes, other names or empty input", () => {
    assert.ok(!contactNameMatches("Ama", "Amara Okafor"));
    assert.ok(!contactNameMatches("Daniel", "Amara Okafor"));
    assert.ok(!contactNameMatches("  ", "Amara Okafor"));
    assert.ok(!contactNameMatches("Amara Mwangi", "Amara Okafor"));
  });
});

describe("normaliseEmail", () => {
  it("normalises spoken emails", () => {
    assert.equal(normaliseEmail("amara at lagos ledger dot example"), "amara@lagosledger.example");
    assert.equal(normaliseEmail("Efua dot Mensah at accra stack dot example"), "efua.mensah@accrastack.example");
    assert.equal(normaliseEmail("daniel underscore m at nairobi ops dot example"), "daniel_m@nairobiops.example");
    assert.equal(normaliseEmail("amina dash j at cape cloud dot co dot za"), "amina-j@capecloud.co.za");
  });
  it("normalises written emails", () => {
    assert.equal(normaliseEmail(" Amara@LagosLedger.example "), "amara@lagosledger.example");
    assert.equal(normaliseEmail("<patrick@kigaliworks.example>"), "patrick@kigaliworks.example");
  });
  it("rejects invalid formats after normalising", () => {
    for (const bad of ["amara", "amara at lagos ledger", "amara at at lagos dot example", "amara@lagos..example", ".amara@lagos.example", "amara@.example", "at dot", "", "a@b"]) {
      assert.equal(normaliseEmail(bad), null, bad);
    }
  });
});

describe("normaliseReference", () => {
  it("accepts the prefix plus four digits, any case or separator", () => {
    assert.equal(normaliseReference("TXN-9001", "TXN"), "TXN-9001");
    assert.equal(normaliseReference("txn 9001", "TXN"), "TXN-9001");
    assert.equal(normaliseReference("TXN9001", "TXN"), "TXN-9001");
    assert.equal(normaliseReference("pay_7002", "PAY"), "PAY-7002");
  });
  it("rejects anything else", () => {
    for (const bad of ["9001", "TXN-901", "TXN-90011", "PAY-7002", "TXN-9001; drop table", "TXN--9001"]) {
      assert.equal(normaliseReference(bad, "TXN"), null, bad);
    }
  });
});
