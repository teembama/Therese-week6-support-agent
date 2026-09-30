import { normaliseReference } from "@relaypay/shared";
import * as z from "zod";
import { withToolLogging, type ToolOutcome } from "../tool-logging.js";
import { invalid, parseArgs, todayUtc, verifiedCustomerId } from "./common.js";

export const name = "lookup_transaction";

export const description =
  "Look up a RelayPay transaction by its reference (TXN- followed by four digits, e.g. TXN-9001). " +
  "Returns its type, status, support summary and estimated arrival. The amount and currency are " +
  "included only when the caller has been verified as the transaction's owner (lookup_customer). " +
  "If requires_escalation is true, offer to connect the caller with a specialist instead of " +
  "diagnosing the issue.";

export const inputSchema = z.object({
  transaction_id: z.string().trim().max(40).describe("The transaction reference, e.g. TXN-9001."),
});

interface TransactionRow {
  transaction_id: string;
  customer_id: string;
  transaction_type: string;
  amount: number | string;
  currency: string;
  status: string;
  estimated_arrival: string | null;
  support_summary: string | null;
}

/** Past the estimated arrival while still not completed (dates compared in UTC). */
export function pastEstimatedArrival(status: string, estimatedArrival: string | null, today: string = todayUtc()): boolean {
  return estimatedArrival !== null && status !== "completed" && today > estimatedArrival;
}

export function transactionEscalation(status: string): { requires_escalation: boolean; escalation_category?: string } {
  if (status === "review required") return { requires_escalation: true, escalation_category: "compliance" };
  if (status === "failed") return { requires_escalation: true, escalation_category: "payment" };
  return { requires_escalation: false };
}

export const handler = withToolLogging(name, "Look up a transaction (amount only for its verified owner)", async (args, { db, ctx }): Promise<ToolOutcome> => {
  const parsed = parseArgs(inputSchema, args, "transaction_id must be a string like TXN-9001.");
  if (!parsed.ok) return parsed.outcome;
  const id = normaliseReference(parsed.data.transaction_id, "TXN");
  if (!id) return invalid("transaction_id must be TXN- followed by four digits, e.g. TXN-9001. Ask the caller to repeat it.");

  const { data, error } = await db.from("transactions")
    .select("transaction_id, customer_id, transaction_type, amount, currency, status, estimated_arrival, support_summary")
    .eq("transaction_id", id).maybeSingle();
  if (error) throw new Error(`transactions read failed (${error.code}): ${error.message}`);
  if (!data) {
    return { status: "not_found", result: { found: false, transaction_id: id, message: "No transaction with this reference. Ask the caller to check it." }, resultSummary: `not_found ${id}` };
  }
  const t = data as TransactionRow;
  const owner = (await verifiedCustomerId(db, ctx.conversationId)) === t.customer_id;
  return {
    status: "success",
    result: {
      found: true,
      transaction_id: t.transaction_id,
      type: t.transaction_type,
      status: t.status,
      support_summary: t.support_summary,
      estimated_arrival: t.estimated_arrival,
      past_estimated_arrival: pastEstimatedArrival(t.status, t.estimated_arrival),
      ...transactionEscalation(t.status),
      owner_verified: owner,
      ...(owner
        ? { amount: Number(t.amount), currency: t.currency }
        : { amount_withheld: "The caller is not verified as this transaction's owner, so do not state an amount." }),
    },
    resultSummary: `${t.transaction_id} ${t.status}; owner_verified=${owner}`,
  };
});
