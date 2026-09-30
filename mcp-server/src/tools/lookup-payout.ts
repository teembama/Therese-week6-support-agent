import { normaliseReference } from "@relaypay/shared";
import * as z from "zod";
import { withToolLogging, type ToolOutcome } from "../tool-logging.js";
import { invalid, notAvailable, parseArgs, verifiedCustomerId } from "./common.js";

export const name = "lookup_payout";

export const description =
  "Look up a contractor payout by payout reference (PAY- followed by four digits) or by its " +
  "transaction reference (TXN-). Returns the status, scheduled date, a customer-safe failure " +
  "reason and a support summary. If requires_escalation is true, offer to connect the caller " +
  "with a specialist and do not explain the review.";

export const inputSchema = z.object({
  payout_id: z.string().trim().max(40).optional().describe("The payout reference, e.g. PAY-7001."),
  transaction_id: z.string().trim().max(40).optional().describe("The linked transaction reference, e.g. TXN-9001."),
});

interface PayoutRow {
  payout_id: string;
  /** Read only for the ownership rule (D44); never returned. */
  customer_id: string;
  transaction_id: string;
  status: string;
  scheduled_for: string | null;
  failure_reason: string | null;
  transactions: { support_summary: string | null } | null;
}

// Stored failure reasons -> what may be said to a customer. A reason not listed here is never
// passed through verbatim (escalation rules: no internal compliance explanations).
const SAFE_FAILURE_REASONS: Record<string, string> = {
  "beneficiary details need review": "The beneficiary details need review.",
  "compliance review": "The payout is under review.",
};

export function safeFailureReason(reason: string | null): string | null {
  if (!reason) return null;
  return SAFE_FAILURE_REASONS[reason.trim().toLowerCase()] ?? "The payout could not be completed.";
}

const STATUS_SENTENCE: Record<string, string> = {
  scheduled: "The payout is scheduled.",
  processing: "The payout is processing.",
  completed: "The payout has been completed.",
  failed: "The payout failed.",
  "review required": "The payout is under review.",
};

/** Derived in code from the payout status plus the linked transaction's support_summary (Task 1 decision). */
export function payoutSupportSummary(status: string, transactionSummary: string | null): string {
  const base = STATUS_SENTENCE[status] ?? "The payout status is not available.";
  return transactionSummary ? `${base} ${transactionSummary}` : base;
}

export const handler = withToolLogging(name, "Look up a payout by payout or transaction reference", async (args, { db, ctx }): Promise<ToolOutcome> => {
  const parsed = parseArgs(inputSchema, args, "payout_id and transaction_id must be short strings.");
  if (!parsed.ok) return parsed.outcome;
  const { payout_id, transaction_id } = parsed.data;
  if (!payout_id && !transaction_id) return invalid("Give payout_id (PAY-7001) or transaction_id (TXN-9001).");
  const payoutId = payout_id ? normaliseReference(payout_id, "PAY") : null;
  const transactionId = transaction_id ? normaliseReference(transaction_id, "TXN") : null;
  if (payout_id && !payoutId) return invalid("payout_id must be PAY- followed by four digits, e.g. PAY-7001.");
  if (transaction_id && !transactionId) return invalid("transaction_id must be TXN- followed by four digits, e.g. TXN-9001.");

  let q = db.from("payouts").select("payout_id, customer_id, transaction_id, status, scheduled_for, failure_reason, transactions!payouts_transaction_id_fkey(support_summary)"); // two FKs to transactions: name the plain one
  if (payoutId) q = q.eq("payout_id", payoutId);
  if (transactionId) q = q.eq("transaction_id", transactionId); // both given: they must agree
  const { data, error } = await q.order("payout_id").limit(1);
  if (error) throw new Error(`payouts read failed (${error.code}): ${error.message}`);
  const p = ((data ?? []) as unknown as PayoutRow[])[0];
  const ref = [payoutId, transactionId].filter(Boolean).join(" / ");
  const verified = await verifiedCustomerId(db, ctx.conversationId);
  if (verified && (!p || p.customer_id !== verified)) {
    return notAvailable(ref, p ? `owned by another customer; conversation verified as ${verified}` : "no such record; conversation verified");
  }
  if (!p) {
    return { status: "not_found", result: { found: false, message: "No payout matches this reference. Ask the caller to check it." }, resultSummary: `not_found ${ref}` };
  }
  const review = p.status === "review required";
  return {
    status: "success",
    result: {
      found: true,
      payout_id: p.payout_id,
      transaction_id: p.transaction_id,
      payout_status: p.status,
      scheduled_for: p.scheduled_for,
      failure_reason: safeFailureReason(p.failure_reason),
      support_summary: payoutSupportSummary(p.status, p.transactions?.support_summary ?? null),
      requires_escalation: review,
      ...(review ? { escalation_category: "compliance" } : {}),
    },
    resultSummary: `${p.payout_id} ${p.status}`,
  };
});
