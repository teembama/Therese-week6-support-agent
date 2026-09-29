// Retrieval evaluation: the evidence for the retrieval settings (see docs/retrieval-eval.md).
//
// Runs search_kb (through rankKnowledge, so KB_QUERY_SYNONYMS and KB_RANK_NORMALIZATION
// apply) with EVAL_MATCH_COUNT results and min rank 0 by default, so the full rank
// distribution is visible. For each question it reports every returned chunk and where the
// judged-correct chunk landed. Every query is logged to retrieval_logs under a
// channel='test' conversation (one turn per question), with the eval parameters recorded.
//
// Usage: eval-retrieval [--min-rank <n>]   (confirmation run at a candidate threshold)

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
  createServiceClient,
  expandQuery,
  KB_EXCLUDED_WORDS,
  KB_MATCH_COUNT,
  KB_MIN_RANK,
  KB_RANK_NORMALIZATION,
  logRetrieval,
  rankKnowledge,
} from "@relaypay/shared";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const EVAL_MATCH_COUNT = 6;

// `correct` is the chunk judged to answer (or, for tool-path questions, safely frame) the
// question, from the first evaluation run. null: no chunk should be retrieved.
export const QUESTIONS: ReadonlyArray<{ id: string; kind: string; text: string; correct: string | null }> = [
  { id: "S1", kind: "scenario", text: "What fees does RelayPay charge for international payments?",
    correct: "frequently-asked-questions--how-does-relaypay-charge-fees" },
  { id: "S2", kind: "scenario", text: "My payment is stuck.",
    correct: "frequently-asked-questions--why-is-my-payment-delayed" },
  { id: "S3", kind: "tool path", text: "I am Amara from LagosLedger. Can you check my account?",
    correct: "policies-and-compliance--data-security-and-privacy" },
  { id: "S4", kind: "tool path", text: "Can you check transaction TXN-9001?",
    correct: "product-features-overview--transaction-tracking-and-reporting" },
  { id: "S5", kind: "tool path", text: "What is happening with payout PAY-7002?",
    correct: "frequently-asked-questions--why-is-my-payment-delayed" },
  { id: "S6", kind: "scenario", text: "My invoice payment failed and I need someone to look at it.",
    correct: "frequently-asked-questions--does-relaypay-automatically-collect-invoice-payments" },
  { id: "S7", kind: "scenario", text: "My account was restricted and nobody is helping me.",
    correct: "policies-and-compliance--account-restrictions-and-suspensions" },
  { id: "S8", kind: "scenario", text: "Can RelayPay guarantee my payout arrives by 9am tomorrow?",
    correct: "frequently-asked-questions--can-relaypay-guarantee-payment-timelines" },
  { id: "X1", kind: "limitation", text: "do you support crypto wallets",
    correct: "product-features-overview--feature-availability-and-limitations" },
  { id: "X2", kind: "off-topic", text: "what is the weather in Lagos", correct: null },
  { id: "X3", kind: "STT-style", text: "how long do payouts to kenya take",
    correct: "frequently-asked-questions--how-long-do-payments-take-to-process" },
];

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { "min-rank": { type: "string" } } });
  const minRank = values["min-rank"] !== undefined ? Number(values["min-rank"]) : 0;
  if (!Number.isFinite(minRank)) throw new Error("--min-rank must be a number");

  process.loadEnvFile(resolve(REPO, ".env"));
  const db = createServiceClient();

  const conversationId = `test-retrieval-eval-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  const { error } = await db
    .from("conversations")
    .insert({ conversation_id: conversationId, channel: "test", caller: "scripts/eval-retrieval.ts" });
  if (error) throw new Error(`could not create test conversation: ${error.message}`);

  const params = `min_rank=${minRank} match_count=${EVAL_MATCH_COUNT} normalization=${KB_RANK_NORMALIZATION}`;
  console.log(`eval: ${params} excluded=[${KB_EXCLUDED_WORDS.join(", ")}] ` +
    `(config: KB_MIN_RANK=${KB_MIN_RANK}, KB_MATCH_COUNT=${KB_MATCH_COUNT})`);
  console.log(`test conversation: ${conversationId}\n`);

  const summary: string[] = [];
  let lost = 0;
  for (const [turnIndex, q] of QUESTIONS.entries()) {
    const chunks = await rankKnowledge(db, q.text, { minRank, matchCount: EVAL_MATCH_COUNT });
    const expanded = expandQuery(q.text);
    const logged = await logRetrieval(db, { conversationId, turnIndex }, {
      query: q.text,
      chunkIds: chunks.map((c) => c.chunk_id),
      sourceTitles: chunks.map((c) => `${c.source_title} > ${c.heading}`),
      sourceSummary: `EVAL ${params}` + (expanded !== q.text ? ` [searched as: ${expanded}]` : "") + ": " +
        (chunks.length ? chunks.map((c) => `${c.chunk_id} (${c.rank.toFixed(4)})`).join("; ") : "no chunk"),
      insufficientKnowledge: chunks.length === 0,
    });
    if (!logged) throw new Error(`retrieval_logs write failed for ${q.id}`);

    console.log(`${q.id} [${q.kind}] ${q.text}${expanded !== q.text ? `   (searched as: "${expanded}")` : ""}`);
    if (chunks.length === 0) console.log("    (no chunk)");
    chunks.forEach((c, i) =>
      console.log(`    ${i + 1}. ${c.rank.toFixed(4)}  ${c.heading}${c.chunk_id === q.correct ? "   <== correct" : ""}`));

    const pos = chunks.findIndex((c) => c.chunk_id === q.correct);
    const correct = q.correct === null
      ? (chunks.length === 0 ? "none expected; none returned" : "none expected; chunks returned")
      : pos < 0 ? "NOT in results" : `#${pos + 1} ${chunks[pos]!.rank.toFixed(4)}`;
    if (q.correct !== null && pos < 0) lost++;
    summary.push(`| ${q.id} | ${correct} | ${chunks[0]?.rank.toFixed(4) ?? "-"} | ${chunks.length === 0} |`);
    console.log("");
  }

  console.log("| Q | correct chunk | top rank | insufficient_knowledge |");
  console.log("| --- | --- | --- | --- |");
  for (const line of summary) console.log(line);
  console.log(`\ncorrect chunks not in results: ${lost}`);

  await db.from("conversations")
    .update({ ended_at: new Date().toISOString(), final_status: "completed", summary: `Retrieval evaluation run (${params})` })
    .eq("conversation_id", conversationId);
}

main().catch((err: unknown) => {
  console.error(`EVAL ERROR: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
