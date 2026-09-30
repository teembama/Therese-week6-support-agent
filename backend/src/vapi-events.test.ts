// Vapi end-of-call webhook (D50): the pure parts. DB behaviour: scripts/test-endpoint.ts.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildSummary, classifyEvent, finalStatusFor, vapiMetricsFrom } from "./vapi-events.js";

// Recorded shape (ServerMessageEndOfCallReport, https://api.vapi.ai/api-json); values made up.
export const END_OF_CALL = {
  message: {
    type: "end-of-call-report",
    timestamp: 1790000000000,
    endedReason: "customer-ended-call",
    startedAt: "2026-09-30T12:00:00.000Z",
    endedAt: "2026-09-30T12:01:30.000Z",
    cost: 0.12,
    call: { id: "c0ffee00-0000-4000-8000-000000000001", type: "webCall", assistantId: "asst-1" },
    customer: { number: "+2348000000000" },
    analysis: { summary: "Vapi's own summary: never used." },
    artifact: {
      transcript: "AI: Hello. User: my email is amara at lagos ledger dot example",
      messages: [{ role: "bot", message: "Hello" }],
      performanceMetrics: {
        turnLatencies: [{ modelLatency: 620, voiceLatency: 210, transcriberLatency: 180, endpointingLatency: 300, turnLatency: 1310 }],
        modelLatencyAverage: 620, voiceLatencyAverage: 210, transcriberLatencyAverage: 180, endpointingLatencyAverage: 300, turnLatencyAverage: 1310,
      },
    },
  },
};

describe("finalStatusFor", () => {
  it("normal endings -> completed", () => {
    for (const r of ["customer-ended-call", "assistant-said-end-call-phrase", "assistant-ended-call", "silence-timed-out", "exceeded-max-duration"]) assert.equal(finalStatusFor(r), "completed", r);
  });
  it("errors, media problems and unknown reasons -> failed", () => {
    for (const r of ["pipeline-error-custom-llm-llm-failed", "call.in-progress.error-vapifault-worker-died", "customer-did-not-give-microphone-permission", "assistant-join-timed-out", "something-new", null]) assert.equal(finalStatusFor(r), "failed", String(r));
  });
});

describe("vapiMetricsFrom", () => {
  it("keeps latency metrics, cost and duration; drops transcript, messages, customer and Vapi's summary", () => {
    const m = vapiMetricsFrom(END_OF_CALL.message);
    assert.equal(m["cost_usd"], 0.12);
    assert.equal(m["duration_seconds"], 90);
    const pm = m["performance_metrics"] as Record<string, unknown>;
    assert.equal(pm["turnLatencyAverage"], 1310);
    assert.deepEqual(pm["turnLatencies"], [{ modelLatency: 620, voiceLatency: 210, transcriberLatency: 180, endpointingLatency: 300, turnLatency: 1310 }]);
    assert.doesNotMatch(JSON.stringify(m), /transcript|amara|\+234|Vapi's own summary|messages/);
  });
  it("copes with a report without performanceMetrics", () => {
    assert.equal(vapiMetricsFrom({ type: "end-of-call-report" })["performance_metrics"], null);
  });
});

describe("buildSummary", () => {
  it("is deterministic and built only from our own facts", () => {
    const facts = { turns: 4, answerTypes: { escalate: 2, answer: 1, social: 1 }, tickets: ["payment"], escalations: ["account"], identity: "verified" as const, endedReason: "customer-ended-call" };
    const s = buildSummary(facts);
    assert.equal(s, "4 turns (answer 1, escalate 2, social 1). Identity: verified. Tickets: 1 (payment). Escalations: 1 (account). Ended: customer-ended-call.");
    assert.equal(buildSummary({ ...facts, answerTypes: { social: 1, answer: 1, escalate: 2 } }), s);
    assert.equal(buildSummary({ turns: 0, answerTypes: {}, tickets: [], escalations: [], identity: "not attempted", endedReason: null }), "0 turns. Identity: not attempted. Tickets: 0. Escalations: 0. Ended: unknown.");
  });
});

describe("classifyEvent", () => {
  it("handles end-of-call-report and ignores everything else", () => {
    assert.equal(classifyEvent(END_OF_CALL).kind, "end_of_call");
    assert.deepEqual(classifyEvent({ message: { type: "status-update", status: "in-progress" } }), { kind: "ignored", type: "status-update" });
    assert.equal(classifyEvent(null).kind, "ignored");
    assert.equal(classifyEvent({ message: { type: "end-of-call-report", call: {} } }).kind, "ignored");
  });
});
