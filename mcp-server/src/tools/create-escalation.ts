import { guardedRpc, normaliseEmail } from "@relaypay/shared";
import * as z from "zod";
import { withWriteToolLogging, type ToolOutcome } from "../tool-logging.js";
import { invalid, logEventBestEffort, parseArgs, serialised, verifiedCustomerId, writeLimitOutcome, writeLimitReached } from "./common.js";

export const name = "create_escalation";

export const description =
  "Hand the caller over to a RelayPay support specialist. Steps, in order: (1) ask for the caller's name; " +
  "(2) ask for their email; (3) read the email back exactly and get the caller's confirmation; (4) ask for a " +
  "preferred callback time; (5) call this tool, with email_confirmed_by_caller true and either " +
  "preferred_time_text (their words) or preferred_time_declined true. The tool refuses to create anything " +
  "until steps 3 and 4 are done. Creates the escalation and its support ticket. Tell the caller what " +
  "follow_up_summary says (a representative will follow up); never say how or when, and never promise an " +
  "outcome. If preferred_time_noted is set, say it is NOTED as their preferred time (\"I've noted tomorrow " +
  "morning as your preferred time\"), never as a commitment.";

export const ESCALATION_CATEGORIES = ["compliance", "account", "dispute", "payment", "other"] as const;

export const inputSchema = z.object({
  user_name: z.string().trim().min(1).max(100).describe("The caller's name."),
  user_email: z.string().trim().min(3).max(254).describe("The caller's email, as spoken or written."),
  category: z.enum(ESCALATION_CATEGORIES).describe("What the escalation is about."),
  reason: z.string().trim().min(5).max(500).describe("Why a specialist is needed, in a short factual sentence."),
  preferred_time_text: z.string().trim().min(1).max(200).optional().describe("The caller's preferred callback time, in their own words."),
  // D72: the flow is enforced here, not by description wording. Optional in the schema so a missing
  // value gets the actionable message from escalationPreconditions, not a generic schema error.
  preferred_time_declined: z.boolean().optional().describe("true only if you asked for a preferred callback time and the caller didn't want to give one."),
  email_confirmed_by_caller: z.boolean().optional().describe("true only after you read the email back to the caller and they confirmed it."),
});

interface EscalationRow {
  ticket_id: string;
  escalation_id: string;
  created: boolean;
  /** Migration 006 (D82): missing fields of an existing escalation were filled. Absent before 006. */
  updated?: boolean;
}

export function escalationKeys(conversationId: string, category: string): { ticket: string; escalation: string } {
  return { ticket: `escalation-ticket:${conversationId}:${category}`, escalation: `escalation:${conversationId}:${category}` };
}

/**
 * The escalation flow's preconditions (D72): the email was read back and confirmed, and the caller
 * was asked for a preferred callback time (given, or declined). Returns the actionable reason for
 * invalid_input, or null. Checked before anything is read or written. After3 eval (2026-10-01):
 * with these as description wording only, the model created the escalation straight after the
 * email, skipping the read-back and the time question, 2 of 2 complete runs.
 */
export function escalationPreconditions(input: { email_confirmed_by_caller?: boolean | undefined; preferred_time_text?: string | undefined; preferred_time_declined?: boolean | undefined }): string | null {
  if (input.email_confirmed_by_caller !== true) {
    return "Read the email back to the caller exactly and get their confirmation first, then call again with email_confirmed_by_caller true. Nothing was written.";
  }
  if (!input.preferred_time_text && input.preferred_time_declined !== true) {
    return "Ask the caller for their preferred callback time first, then call again with preferred_time_text (their words) or preferred_time_declined true if they don't want to give one. Nothing was written.";
  }
  return null;
}

/** A callback is booked only when the caller gave a preferred time (D72). */
export function callBookedFor(input: { preferred_time_text?: string | undefined }): boolean {
  return Boolean(input.preferred_time_text);
}

/**
 * What the agent tells the caller (D70): a representative will follow up. No channel, address or
 * time: the escalation records a callback preference, not a commitment to email or call at a time
 * (D65). BEFORE eval S7 r3 read "will follow up with you at efua@…" from the old summary. The
 * caller's preferred time is returned separately (preferred_time_noted), to be confirmed as noted.
 */
export function followUpSummary(): string {
  return "A RelayPay support representative will follow up.";
}

export const handler = withWriteToolLogging(name, "Create (or return the existing) escalation with its ticket", (args, { db, ctx }) => serialised(async (): Promise<ToolOutcome> => {
  const parsed = parseArgs(inputSchema, args, `user_name, user_email, reason are required; category must be one of ${ESCALATION_CATEGORIES.join(", ")}.`);
  if (!parsed.ok) return parsed.outcome;
  const input = parsed.data;
  const email = normaliseEmail(input.user_email);
  if (!email) return invalid("user_email is not a valid email address. Ask the caller to spell it again. Nothing was written.");
  const precondition = escalationPreconditions(input);
  if (precondition) return invalid(precondition);

  const keys = escalationKeys(ctx.conversationId, input.category);
  const cap = await writeLimitReached(db, ctx.conversationId, "escalation", keys.escalation);
  if (cap.reached) return writeLimitOutcome("escalation", cap.existing);

  const customerId = await verifiedCustomerId(db, ctx.conversationId);
  const callBooked = callBookedFor(input);
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
  const updated = e.updated === true;
  // An existing escalation (D82): report what is STORED (a set time is never overwritten; a missing
  // one may just have been filled), not this call's inputs.
  let stored = { call_booked: callBooked, preferred_time_text: input.preferred_time_text ?? null };
  if (!e.created) {
    const { data: row, error: readError } = await db.from("escalations").select("call_booked, preferred_time_text").eq("escalation_id", e.escalation_id).maybeSingle();
    if (readError) throw new Error(`escalations read failed (${readError.code}): ${readError.message}`);
    if (row) stored = row as typeof stored;
  }
  const note = e.created
    ? await logEventBestEffort(db, ctx, "escalation_created", `Escalation ${e.escalation_id} (${input.category}) with ticket ${e.ticket_id}`, {
        escalation_id: e.escalation_id, ticket_id: e.ticket_id, category: input.category, call_booked: callBooked,
      })
    : updated
      ? await logEventBestEffort(db, ctx, "escalation_updated", `Escalation ${e.escalation_id}: preferred callback time added`, {
          escalation_id: e.escalation_id, ticket_id: e.ticket_id, fields: ["preferred_time_text", "call_booked"],
        })
      : "";
  return {
    status: "success",
    result: {
      escalation_id: e.escalation_id,
      ticket_id: e.ticket_id,
      escalation_status: "open",
      call_booked: stored.call_booked,
      duplicate: !e.created,
      ...(updated ? { updated: true } : {}),
      follow_up_summary: followUpSummary(),
      ...(stored.preferred_time_text ? { preferred_time_noted: stored.preferred_time_text } : {}),
    },
    resultSummary: `${e.created ? "created" : updated ? "existing, enriched" : "existing"} ${e.escalation_id}/${e.ticket_id} ${input.category}; call_booked=${stored.call_booked}; customer=${customerId ?? "unverified"}${note}`,
  };
}));
