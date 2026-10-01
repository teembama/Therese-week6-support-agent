// Unit tests for the tool-list guard, the follow-up retrieval query, and the style check.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildRetrievalQuery, meaningfulWordCount } from "./retrieval-query.js";
import { styleViolations } from "./style.js";
import { recordGateBlocked, toolListProblem } from "./turn.js";

const SIX = ["lookup_customer", "lookup_transaction", "lookup_payout", "create_support_ticket", "create_escalation", "log_conversation_event"].map((n) => `mcp__relaypay__${n}`);
const CONNECTED = [{ name: "relaypay", status: "connected" }];

describe("tool-list guard", () => {
  it("passes when the agent has exactly the six support tools and the server is connected", () => {
    assert.equal(toolListProblem({ tools: [...SIX].reverse(), mcp_servers: CONNECTED }), null);
  });
  it("fails when a tool is missing or the server is not connected", () => {
    assert.match(toolListProblem({ tools: SIX.slice(1), mcp_servers: CONNECTED }) ?? "", /!= allowlist/);
    assert.match(toolListProblem({ tools: [], mcp_servers: [] }) ?? "", /!= allowlist/);
    assert.match(toolListProblem({ tools: SIX, mcp_servers: [{ name: "relaypay", status: "failed" }] }) ?? "", /status failed/);
  });
  it("fails when search_knowledge_base is present", () => {
    const p = toolListProblem({ tools: ["mcp__relaypay__search_knowledge_base"], mcp_servers: [{ name: "relaypay", status: "connected" }] });
    assert.match(p ?? "", /forbidden tool\(s\) present: mcp__relaypay__search_knowledge_base/);
  });
  it("fails when any built-in or unexpected tool is present", () => {
    assert.match(toolListProblem({ tools: [...SIX, "Bash"], mcp_servers: CONNECTED }) ?? "", /!= allowlist/);
  });
});

describe("follow-up retrieval query", () => {
  const history = [
    { role: "caller" as const, text: "What fees does RelayPay charge for international payments?" },
    { role: "agent" as const, text: "Fees depend on the transaction type, corridor and payment method." },
  ];
  it("counts meaningful words, ignoring stopwords and fillers", () => {
    assert.equal(meaningfulWordCount("And how long do payouts to Kenya take?"), 4);
    assert.equal(meaningfulWordCount("What fees does RelayPay charge for international payments?"), 5);
    assert.equal(meaningfulWordCount("okay thanks"), 0);
  });
  it("combines a short follow-up with the previous caller message", () => {
    const q = buildRetrievalQuery(history, "And for Kenya?");
    assert.equal(q.combinedWithPrevious, true);
    assert.equal(q.query, "What fees does RelayPay charge for international payments? And for Kenya?");
  });
  it("uses a self-contained message as is", () => {
    const q = buildRetrievalQuery(history, "How long do international payouts to Kenya usually take?");
    assert.deepEqual(q, { query: "How long do international payouts to Kenya usually take?", combinedWithPrevious: false });
  });
  it("uses a short first message as is (nothing to combine with)", () => {
    assert.equal(buildRetrievalQuery([], "My payment is stuck.").combinedWithPrevious, false);
  });
});

describe("style check (observability only)", () => {
  it("flags implementation terms", () => {
    assert.deepEqual(styleViolations("I don't see that in our knowledge base."), ["knowledge base"]);
    assert.deepEqual(styleViolations("Based on the retrieved chunks, fees vary."), ["chunk", "retrieved"]);
  });
  it("does not flag 'document' or normal speech", () => {
    assert.deepEqual(styleViolations("You may need to upload business registration documents."), []);
  });
});

describe("gate_blocked event (D71)", () => {
  const ctx = { conversationId: "test-gb", turnIndex: 2, attemptId: "ATT-GB" };
  type FakeDb = Parameters<typeof recordGateBlocked>[0];
  it("writes a guarded gate_blocked event with the reason, never the blocked text", async () => {
    const calls: Array<[string, Record<string, unknown>]> = [];
    const db = { rpc: async (fn: string, params: Record<string, unknown>) => { calls.push([fn, params]); return { data: 1, error: null }; } } as unknown as FakeDb;
    await recordGateBlocked(db, ctx, "every sentence dropped by the grounding filter (2)");
    assert.equal(calls.length, 1);
    const [fn, p] = calls[0]!;
    assert.equal(fn, "log_conversation_event_guarded");
    assert.equal(p["p_event_type"], "gate_blocked");
    assert.equal(p["p_attempt_id"], "ATT-GB");
    assert.equal(p["p_turn_index"], 2);
    assert.match(String(p["p_summary"]), /^Reply blocked by the grounding gate: every sentence dropped/);
  });
  it("best-effort: a failed write never throws", async () => {
    const db = { rpc: async () => ({ data: null, error: { code: "", message: "TypeError: fetch failed" } }) } as unknown as FakeDb;
    await assert.doesNotReject(recordGateBlocked(db, ctx, "malformed or late header"));
  });
});
