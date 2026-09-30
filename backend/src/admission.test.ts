// Agent-turn admission (D59) and drain (D60).

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Admission, type Slot } from "./admission.js";

const slot = (x: Slot | string): Slot => {
  assert.equal(typeof x, "object", `expected a slot, got ${String(x)}`);
  return x as Slot;
};

describe("Admission", () => {
  it("admits up to the cap, then refuses with 'busy'; a release frees a slot", () => {
    const a = new Admission(3);
    const s1 = slot(a.tryAcquire("c1#0"));
    slot(a.tryAcquire("c2#0"));
    slot(a.tryAcquire("c3#0"));
    assert.equal(a.tryAcquire("c4#0"), "busy");
    s1.release();
    slot(a.tryAcquire("c4#0"));
    assert.equal(a.running, 3);
  });
  it("a replacement of the same turn reuses its slot (partial transcripts never lock out others)", () => {
    const a = new Admission(1);
    const first = slot(a.tryAcquire("c1#0"));
    const replacement = slot(a.tryAcquire("c1#0"));
    assert.equal(a.tryAcquire("c2#0"), "busy");
    first.release(); // the replaced attempt finishes: the replacement still holds the turn
    assert.equal(a.tryAcquire("c2#0"), "busy");
    replacement.release();
    slot(a.tryAcquire("c2#0"));
  });
  it("release is idempotent", () => {
    const a = new Admission(1);
    const s = slot(a.tryAcquire("c1#0"));
    const t = slot(a.tryAcquire("c1#0"));
    s.release();
    s.release();
    assert.equal(a.running, 1, "a double release must not free the other holder's slot");
    t.release();
    assert.equal(a.running, 0);
  });
  it("drain refuses every new turn with 'shutting_down', even under the cap", () => {
    const a = new Admission(3);
    const s = slot(a.tryAcquire("c1#0"));
    a.drain();
    assert.equal(a.tryAcquire("c2#0"), "shutting_down");
    assert.equal(a.tryAcquire("c1#0"), "shutting_down");
    s.release();
    assert.equal(a.running, 0);
  });
});
