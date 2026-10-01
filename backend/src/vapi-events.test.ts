// Vapi end-of-call webhook (D50): the pure parts. DB behaviour: scripts/test-endpoint.ts.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { channelFor } from "./config.js";
import { buildSummary, classifyEvent, finalStatusFor, isAnswered, vapiMetricsFrom } from "./vapi-events.js";

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
    for (const r of ["customer-ended-call", "assistant-said-end-call-phrase", "assistant-ended-call", "silence-timed-out", "exceeded-max-duration"]) assert.equal(finalStatusFor(r, 2), "completed", r);
  });
  it("errors, media problems and unknown reasons -> failed", () => {
    for (const r of ["pipeline-error-custom-llm-llm-failed", "call.in-progress.error-vapifault-worker-died", "customer-did-not-give-microphone-permission", "assistant-join-timed-out", "something-new", null]) assert.equal(finalStatusFor(r, 2), "failed", String(r));
  });
  it("zero answered turns -> failed (no_interaction), whatever the ended reason (D61)", () => {
    for (const r of ["customer-ended-call", "silence-timed-out", "assistant-said-end-call-phrase", "pipeline-error-custom-llm-llm-failed", null]) assert.equal(finalStatusFor(r, 0), "failed", String(r));
    assert.equal(finalStatusFor("customer-ended-call", 1), "completed");
  });
  it("answered = something spoken and not an error line; a blocked turn (safe decline spoken) counts", () => {
    assert.equal(isAnswered({ answer_type: "answer", assistant_response: "Fees vary." }), true);
    assert.equal(isAnswered({ answer_type: "blocked", assistant_response: "I'm sorry, I can't confirm that." }), true);
    assert.equal(isAnswered({ answer_type: "social", assistant_response: "Thanks for calling RelayPay. Goodbye." }), true);
    assert.equal(isAnswered({ answer_type: "error", assistant_response: "Sorry, I'm having trouble checking that right now." }), false);
    assert.equal(isAnswered({ answer_type: "error", assistant_response: null }), false);
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
    const facts = { turns: 4, answered: 4, answerTypes: { escalate: 2, answer: 1, social: 1 }, tickets: ["payment"], escalations: ["account"], identity: "verified" as const, endedReason: "customer-ended-call" };
    const s = buildSummary(facts);
    assert.equal(s, "4 turns (answer 1, escalate 2, social 1). Identity: verified. Tickets: 1 (payment). Escalations: 1 (account). Ended: customer-ended-call.");
    assert.equal(buildSummary({ ...facts, answerTypes: { social: 1, answer: 1, escalate: 2 } }), s);
    assert.equal(buildSummary({ turns: 0, answered: 0, answerTypes: {}, tickets: [], escalations: [], identity: "not attempted", endedReason: null }), "0 turns. Identity: not attempted. Tickets: 0. Escalations: 0. Ended: unknown. No interaction: no answered turn.");
    assert.equal(buildSummary({ turns: 2, answered: 0, answerTypes: { error: 2 }, tickets: [], escalations: [], identity: "not attempted", endedReason: "customer-ended-call" }), "2 turns (error 2). Identity: not attempted. Tickets: 0. Escalations: 0. Ended: customer-ended-call. No interaction: no answered turn.");
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

describe("channelFor", () => {
  it("test- and eval- conversations are channel 'test'; Vapi call ids are 'voice'", () => {
    assert.equal(channelFor("test-agent-x"), "test");
    assert.equal(channelFor("eval-2026-10-01-s1-r1"), "test");
    assert.equal(channelFor("01a0f455-5eaa-7007-ae47-d1b6dc28065c"), "voice");
  });
});
