import { guardedRpc, normaliseReference } from "@relaypay/shared";
import * as z from "zod";
import { withWriteToolLogging, type ToolOutcome } from "../tool-logging.js";
import { invalid, logEvent, parseArgs, serialised, verifiedCustomerId, writeLimitOutcome, writeLimitReached } from "./common.js";

export const name = "create_support_ticket";

export const description =
  "Log an issue for RelayPay support follow-up. Give a category and a short factual summary of " +
  "what the caller needs, and the transaction or payout reference if there is one. Priority and " +
  "the customer are set by the system. Calling it again for the same issue returns the same ticket.";

export const TICKET_CATEGORIES = ["payment", "payout", "invoice", "account", "compliance", "dispute", "other"] as const;

// No customer_id or priority here: the customer comes from the verified conversation and the
// priority is computed in the database, so a model-supplied value is stripped and ignored.
export const inputSchema = z.object({
  category: z.enum(TICKET_CATEGORIES).describe("What the issue is about."),
  summary: z.string().trim().min(10).max(500).describe("A short factual summary of the caller's issue (10-500 characters)."),
  transaction_id: z.string().trim().max(40).optional().describe("Linked transaction reference, e.g. TXN-9001."),
  payout_id: z.string().trim().max(40).optional().describe("Linked payout reference, e.g. PAY-7002."),
});

interface TicketRow {
  ticket_id: string;
  priority: string;
  status: string;
  created: boolean;
}

export function ticketIdempotencyKey(conversationId: string, category: string, transactionId: string | null, payoutId: string | null): string {
  return `ticket:${conversationId}:${category}:${transactionId ?? payoutId ?? "none"}`;
}

async function exists(db: Parameters<typeof verifiedCustomerId>[0], table: "transactions" | "payouts", column: string, id: string): Promise<boolean> {
  const { data, error } = await db.from(table).select(column).eq(column, id).maybeSingle();
  if (error) throw new Error(`${table} read failed (${error.code}): ${error.message}`);
  return data !== null;
}

export const handler = withWriteToolLogging(name, "Create (or return the existing) support ticket", (args, { db, ctx }) => serialised(async (): Promise<ToolOutcome> => {
  const parsed = parseArgs(inputSchema, args, `category must be one of ${TICKET_CATEGORIES.join(", ")}; summary 10-500 characters.`);
  if (!parsed.ok) return parsed.outcome;
  const input = parsed.data;
  const transactionId = input.transaction_id ? normaliseReference(input.transaction_id, "TXN") : null;
  const payoutId = input.payout_id ? normaliseReference(input.payout_id, "PAY") : null;
  if (input.transaction_id && !transactionId) return invalid("transaction_id must be TXN- followed by four digits.");
  if (input.payout_id && !payoutId) return invalid("payout_id must be PAY- followed by four digits.");
  if (transactionId && !(await exists(db, "transactions", "transaction_id", transactionId))) {
    return { status: "not_found", result: { found: false, message: `No transaction ${transactionId}; nothing was created.` }, resultSummary: `not_found ${transactionId}` };
  }
  if (payoutId && !(await exists(db, "payouts", "payout_id", payoutId))) {
    return { status: "not_found", result: { found: false, message: `No payout ${payoutId}; nothing was created.` }, resultSummary: `not_found ${payoutId}` };
  }

  const key = ticketIdempotencyKey(ctx.conversationId, input.category, transactionId, payoutId);
  const cap = await writeLimitReached(db, ctx.conversationId, "ticket", key);
  if (cap.reached) return writeLimitOutcome("ticket", cap.existing);

  const customerId = await verifiedCustomerId(db, ctx.conversationId);
  const rows = await guardedRpc<TicketRow[]>(db, "create_support_ticket_guarded", {
    p_conversation_id: ctx.conversationId,
    p_customer_id: customerId,
    p_transaction_id: transactionId,
    p_payout_id: payoutId,
    p_category: input.category,
    p_summary: input.summary,
    p_idempotency_key: key,
  }, ctx.attemptId);
  const t = rows[0];
  if (!t) throw new Error("create_support_ticket_guarded returned no row");
  if (t.created) {
    await logEvent(db, ctx, "ticket_created", `Ticket ${t.ticket_id} (${input.category}, ${t.priority})`, {
      ticket_id: t.ticket_id, category: input.category, priority: t.priority, transaction_id: transactionId, payout_id: payoutId,
    });
  }
  return {
    status: "success",
    result: { ticket_id: t.ticket_id, ticket_status: t.status, priority: t.priority, duplicate: !t.created },
    resultSummary: `${t.created ? "created" : "existing"} ${t.ticket_id} ${input.category}/${t.priority}; customer=${customerId ?? "unverified"}`,
  };
}));
