// Retrieval evaluation: the evidence for KB_MIN_RANK (see docs/retrieval-eval.md).
//
// Runs search_kb with EVAL_MIN_RANK = 0 and EVAL_MATCH_COUNT = 6, so the full rank
// distribution is visible instead of results pre-filtered by the configured threshold.
// Every query is logged to retrieval_logs under a channel='test' conversation (one turn per
// question), with the eval parameters recorded in source_summary. The runtime
// retrieveKnowledge() and its KB_MIN_RANK are not used or changed here.

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createServiceClient,
  KB_EXCLUDED_WORDS,
  KB_MIN_RANK,
  KB_RANK_NORMALIZATION,
  logRetrieval,
  rankKnowledge,
} from "@relaypay/shared";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const EVAL_MIN_RANK = 0;
const EVAL_MATCH_COUNT = 6;

export const QUESTIONS: ReadonlyArray<{ id: string; kind: string; text: string }> = [
  { id: "S1", kind: "scenario", text: "What fees does RelayPay charge for international payments?" },
  { id: "S2", kind: "scenario", text: "My payment is stuck." },
  { id: "S3", kind: "scenario", text: "I am Amara from LagosLedger. Can you check my account?" },
  { id: "S4", kind: "scenario", text: "Can you check transaction TXN-9001?" },
  { id: "S5", kind: "scenario", text: "What is happening with payout PAY-7002?" },
  { id: "S6", kind: "scenario", text: "My invoice payment failed and I need someone to look at it." },
  { id: "S7", kind: "scenario", text: "My account was restricted and nobody is helping me." },
  { id: "S8", kind: "scenario", text: "Can RelayPay guarantee my payout arrives by 9am tomorrow?" },
  { id: "X1", kind: "off-KB", text: "do you support crypto wallets" },
  { id: "X2", kind: "off-topic", text: "what is the weather in Lagos" },
  { id: "X3", kind: "STT-style", text: "how long do payouts to kenya take" },
];

async function main(): Promise<void> {
  process.loadEnvFile(resolve(REPO, ".env"));
  const db = createServiceClient();

  const conversationId = `test-retrieval-eval-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  const { error } = await db
    .from("conversations")
    .insert({ conversation_id: conversationId, channel: "test", caller: "scripts/eval-retrieval.ts" });
  if (error) throw new Error(`could not create test conversation: ${error.message}`);

  console.log(`eval: min_rank=${EVAL_MIN_RANK} match_count=${EVAL_MATCH_COUNT} ` +
    `normalization=${KB_RANK_NORMALIZATION} excluded=[${KB_EXCLUDED_WORDS.join(", ")}] ` +
    `(runtime KB_MIN_RANK=${KB_MIN_RANK} is NOT applied)`);
  console.log(`test conversation: ${conversationId}\n`);

  for (const [turnIndex, q] of QUESTIONS.entries()) {
    const chunks = await rankKnowledge(db, q.text, { minRank: EVAL_MIN_RANK, matchCount: EVAL_MATCH_COUNT });
    const logged = await logRetrieval(db, { conversationId, turnIndex }, {
      query: q.text,
      chunkIds: chunks.map((c) => c.chunk_id),
      sourceTitles: chunks.map((c) => `${c.source_title} > ${c.heading}`),
      sourceSummary: `EVAL min_rank=${EVAL_MIN_RANK} match_count=${EVAL_MATCH_COUNT}: ` +
        (chunks.length ? chunks.map((c) => `${c.chunk_id} (${c.rank.toFixed(4)})`).join("; ") : "no lexeme matched"),
      insufficientKnowledge: chunks.length === 0,
    });
    if (!logged) throw new Error(`retrieval_logs write failed for ${q.id}`);

    console.log(`${q.id} [${q.kind}] ${q.text}`);
    if (chunks.length === 0) console.log("    (no chunk matched any lexeme)");
    chunks.forEach((c, i) => console.log(`    ${i + 1}. ${c.rank.toFixed(4)}  ${c.heading}  [${c.chunk_id}]`));
    console.log("");
  }

  await db.from("conversations")
    .update({ ended_at: new Date().toISOString(), final_status: "completed", summary: "Retrieval evaluation run" })
    .eq("conversation_id", conversationId);
}

main().catch((err: unknown) => {
  console.error(`EVAL ERROR: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
