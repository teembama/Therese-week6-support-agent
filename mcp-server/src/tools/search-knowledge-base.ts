import { retrieveKnowledge } from "@relaypay/shared";
import * as z from "zod";
import { withToolLogging } from "../tool-logging.js";

export const name = "search_knowledge_base";

export const description =
  "Search RelayPay's approved support knowledge base. Call this before answering any product, " +
  "pricing/fee, timeline, invoicing, payout, compliance or policy question, and answer only " +
  "from the returned chunks. If insufficient_knowledge is true, do not answer from memory: " +
  "say you cannot confirm it, or escalate.";

// Unknown keys (e.g. a model-supplied conversation_id) are stripped and ignored (D9).
export const inputSchema = z.object({
  query: z
    .string()
    .trim()
    .min(3)
    .max(300)
    .describe("The customer's question or the topic to look up, in plain words (3-300 characters)."),
});

export const handler = withToolLogging(
  name,
  "Retrieve approved knowledge-base chunks for a customer question",
  async (args, { db, ctx }) => {
    const parsed = inputSchema.safeParse(args ?? {});
    if (!parsed.success) {
      const issues = parsed.error.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`);
      return {
        status: "invalid_input",
        result: { error: { code: "invalid_input", message: "query must be a string of 3-300 characters.", issues } },
        resultSummary: `invalid_input: ${issues.join("; ")}`,
      };
    }

    const { chunks, insufficient_knowledge } = await retrieveKnowledge(db, ctx, parsed.data.query);
    return {
      status: "success",
      result: {
        insufficient_knowledge,
        chunks: chunks.map(({ chunk_id, heading, content }) => ({ chunk_id, heading, content })),
      },
      resultSummary:
        `insufficient_knowledge=${insufficient_knowledge}; ` +
        (chunks.length ? chunks.map((c) => `${c.chunk_id} (${c.rank.toFixed(3)})`).join(", ") : "no chunks"),
    };
  },
);
