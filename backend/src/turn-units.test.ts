// Unit tests for the tool-list guard, the follow-up retrieval query, and the style check.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildRetrievalQuery, meaningfulWordCount } from "./retrieval-query.js";
import { styleViolations } from "./style.js";
import { toolListProblem } from "./turn.js";

describe("tool-list guard", () => {
  it("passes when the agent has exactly the allowlist (currently no tools)", () => {
    assert.equal(toolListProblem({ tools: [], mcp_servers: [] }), null);
  });
  it("fails when search_knowledge_base is present", () => {
    const p = toolListProblem({ tools: ["mcp__relaypay__search_knowledge_base"], mcp_servers: [{ name: "relaypay", status: "connected" }] });
    assert.match(p ?? "", /forbidden tool\(s\) present: mcp__relaypay__search_knowledge_base/);
  });
  it("fails when any built-in or unexpected tool is present", () => {
    assert.match(toolListProblem({ tools: ["Bash"], mcp_servers: [] }) ?? "", /!= allowlist/);
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
