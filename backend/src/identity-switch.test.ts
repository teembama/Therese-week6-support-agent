// D89: the identity-switch line. When lookup_customer refused a second identity in this attempt
// (already_verified_other, D74), the gate speaks the FIXED one-account line and discards the
// model's text, whatever its header says (the live D88 case was mislabelled type=answer).

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { IDENTITY_SWITCH_LINE } from "./config.js";
import { StreamingGate, type ObservedTools } from "./gate.js";

const tools = (identitySwitch: boolean): ObservedTools => ({
  succeeded: () => false,
  called: (n) => n === "lookup_customer",
  records: () => [],
  identitySwitch: () => identitySwitch,
});
const evidence = (identitySwitch: boolean) => ({ chunks: new Map<string, string>(), callerText: "Actually, I'm Felicia from AccraStack.", tools: tools(identitySwitch) });

function run(gate: StreamingGate, text: string) {
  gate.start();
  const spoken = [...gate.text(text)];
  const end = gate.end("end_turn");
  return { spoken: [...spoken, ...(end.kind === "final" ? end.speak : [])], end };
}

describe("identity-switch line (D89)", () => {
  it("the live case: a reply mislabelled type=answer citing the denied tool -> the fixed line, recorded as a decline", () => {
    const gate = new StreamingGate(new Set(), 200, evidence(true));
    const { spoken, end } = run(gate, "[[type=answer; kb=none; tool=lookup_customer]] I can only help with one account per call. I'd be happy to connect you with a RelayPay specialist who can assist with both accounts.");
    assert.deepEqual(spoken, [IDENTITY_SWITCH_LINE]);
    assert.equal(end.kind, "final");
    assert.equal(end.kind === "final" && end.type, "decline");
    assert.equal(gate.identitySwitchSpoken, true);
  });
  it("any header, a malformed one, or none: still only the fixed line; the model's words are never spoken", () => {
    for (const text of ["[[type=decline; kb=none; tool=none; reason=not_covered]] Felicia's account is restricted.", "no header at all, Felicia's plan is Scale", "[[garbage"]) {
      const gate = new StreamingGate(new Set(), 200, evidence(true));
      const { spoken } = run(gate, text);
      assert.deepEqual(spoken, [IDENTITY_SWITCH_LINE], text);
    }
  });
  it("a later message in the same turn adds nothing", () => {
    const gate = new StreamingGate(new Set(), 200, evidence(true));
    run(gate, "[[type=answer; kb=none; tool=lookup_customer]] One account per call.");
    const again = run(gate, "[[type=decline; kb=none; tool=none]] More text.");
    assert.deepEqual(again.spoken, []);
  });
  it("no identity switch: the gate behaves as before (an evidence-free decline gets the D67 line, not this one)", () => {
    const gate = new StreamingGate(new Set(), 200, evidence(false));
    const { spoken } = run(gate, "[[type=decline; kb=none; tool=none; reason=not_covered]] I can't help with that.");
    assert.equal(spoken.length, 1);
    assert.notEqual(spoken[0], IDENTITY_SWITCH_LINE);
    assert.equal(gate.identitySwitchSpoken, false);
  });
  it("the line itself", () => {
    assert.equal(IDENTITY_SWITCH_LINE, "I can only help with one account per call. If you need help with another account, please start a new call, or I can connect you with a specialist.");
  });
});

describe("form-call context line (D89)", async () => {
  const { buildTurnPrompt, formCallContext } = await import("./prompt.js");
  it("a form-identified call gets the context block in the TURN input (not the system prompt); others don't", () => {
    const line = formCallContext("Amara", "CUS-1001", "amara@lagosledger.example");
    assert.equal(line, "The caller is already identified as Amara (CUS-1001) via the call page. Don't ask for their name, company or email to verify them. If they say they are someone else, call lookup_customer with the details they give. " +
      "Always address the caller by Amara; never adopt a different name heard in speech. For escalations, confirm the email they entered (amara@lagosledger.example) instead of asking for it: say it back and ask if a specialist should contact them there.");
    const withCtx = buildTurnPrompt([], "Can you check my account status?", [], line);
    assert.ok(withCtx.includes("<call_context>\nThe caller is already identified as Amara (CUS-1001) via the call page."));
    assert.ok(withCtx.indexOf("<call_context>") < withCtx.indexOf("<caller_message"));
    assert.ok(!buildTurnPrompt([], "Can you check my account status?", []).includes("call_context"));
  });
});
