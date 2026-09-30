import { guardedRpc, normaliseEmail } from "@relaypay/shared";
import * as z from "zod";
import { withWriteToolLogging, type ToolOutcome } from "../tool-logging.js";
import { invalid, logEvent, parseArgs, verifiedCustomerId } from "./common.js";

export const name = "create_escalation";

export const description =
  "Hand the caller over to a RelayPay support specialist. Collect the caller's name and email " +
  "first (and a preferred callback time if they want a call). Creates the escalation and its " +
  "support ticket. Read follow_up_summary to the caller; never promise a timeline or an outcome.";

export const ESCALATION_CATEGORIES = ["compliance", "account", "dispute", "payment", "other"] as const;

export const inputSchema = z.object({
  user_name: z.string().trim().min(1).max(100).describe("The caller's name."),
  user_email: z.string().trim().min(3).max(254).describe("The caller's email, as spoken or written."),
  category: z.enum(ESCALATION_CATEGORIES).describe("What the escalation is about."),
  reason: z.string().trim().min(5).max(500).describe("Why a specialist is needed, in a short factual sentence."),
  preferred_time_text: z.string().trim().min(1).max(200).optional().describe("The caller's preferred callback time, in their own words."),
});

interface EscalationRow {
  ticket_id: string;
  escalation_id: string;
  created: boolean;
}

export function escalationKeys(conversationId: string, category: string): { ticket: string; escalation: string } {
  return { ticket: `escalation-ticket:${conversationId}:${category}`, escalation: `escalation:${conversationId}:${category}` };
}

/** What the agent tells the caller. No timeline and no outcome (escalation-rules.md). */
export function followUpSummary(email: string, preferredTime: string | undefined): string {
  return preferredTime
    ? `A RelayPay support specialist will follow up with you at ${email}, and your preferred time, "${preferredTime}", has been noted.`
    : `A RelayPay support specialist will follow up with you by email at ${email}.`;
}

export const handler = withWriteToolLogging(name, "Create (or return the existing) escalation with its ticket", async (args, { db, ctx }): Promise<ToolOutcome> => {
  const parsed = parseArgs(inputSchema, args, `user_name, user_email, reason are required; category must be one of ${ESCALATION_CATEGORIES.join(", ")}.`);
  if (!parsed.ok) return parsed.outcome;
  const input = parsed.data;
  const email = normaliseEmail(input.user_email);
  if (!email) return invalid("user_email is not a valid email address. Ask the caller to spell it again. Nothing was written.");

  const customerId = await verifiedCustomerId(db, ctx.conversationId);
  const keys = escalationKeys(ctx.conversationId, input.category);
  const callBooked = Boolean(input.preferred_time_text);
  const rows = await guardedRpc<EscalationRow[]>(db, "create_escalation_with_ticket", {
    p_conversation_id: ctx.conversationId,
    p_ticket_idempotency_key: keys.ticket,
    p_escalation_idempotency_key: keys.escalation,
    p_category: input.category,
    p_ticket_summary: `Escalation (${input.category}): ${input.reason}`.slice(0, 500),
    p_reason: input.reason,
    p_user_name: input.user_name,
    p_user_email: email,
    p_customer_id: customerId,
    p_call_booked: callBooked,
    p_preferred_time_text: input.preferred_time_text ?? null,
  }, ctx.attemptId);
  const e = rows[0];
  if (!e) throw new Error("create_escalation_with_ticket returned no row");
  if (e.created) {
    await logEvent(db, ctx, "escalation_created", `Escalation ${e.escalation_id} (${input.category}) with ticket ${e.ticket_id}`, {
      escalation_id: e.escalation_id, ticket_id: e.ticket_id, category: input.category, call_booked: callBooked,
    });
  }
  return {
    status: "success",
    result: {
      escalation_id: e.escalation_id,
      ticket_id: e.ticket_id,
      status: "open",
      call_booked: callBooked,
      duplicate: !e.created,
      follow_up_summary: followUpSummary(email, input.preferred_time_text),
    },
    resultSummary: `${e.created ? "created" : "existing"} ${e.escalation_id}/${e.ticket_id} ${input.category}; call_booked=${callBooked}; customer=${customerId ?? "unverified"}`,
  };
});
