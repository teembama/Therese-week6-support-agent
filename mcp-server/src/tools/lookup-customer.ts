import { contactNameMatches, guardedRpc, normaliseEmail, normaliseName, normaliseReference } from "@relaypay/shared";
import * as z from "zod";
import { withWriteToolLogging, type ToolOutcome } from "../tool-logging.js";
import { invalid, logEventBestEffort, parseArgs, verifiedCustomerId } from "./common.js";

export const name = "lookup_customer";

export const description =
  "Look up the caller's RelayPay customer record. Call it with whatever identifying details the " +
  "caller has given (their name, company name, email or customer ID), as soon as they ask about " +
  "their account: this tool decides whether the details are enough, so do not ask for more " +
  "first. If it returns needs_second_identifier, ambiguous or no_match, ask the caller for " +
  "another identifier. If it returns already_verified_other, the call is already verified for another account: " +
  "say you can only help with one account per call and offer to connect the caller with a RelayPay specialist; never " +
  "ask for more details to verify the second account. Returns only safe account fields. If verified is false, do not " +
  "discuss account details. If requires_escalation is true, offer to connect the caller with a specialist.";

const optionalText = (max: number, what: string) => z.string().trim().max(max).optional().describe(what);

export const inputSchema = z.object({
  customer_id: optionalText(20, "Customer ID, e.g. CUS-1001."),
  email: optionalText(254, "The caller's account email, as spoken or written."),
  company_name: optionalText(200, "The caller's company name."),
  contact_name: optionalText(200, "The caller's name."),
});

interface CustomerRow {
  customer_id: string;
  company_name: string;
  contact_name: string;
  contact_email: string;
  plan: string;
  account_status: string;
  kyc_status: string;
}

/** Escalation needed for this account, and its category (compliance wins when both apply). */
export function accountEscalation(c: Pick<CustomerRow, "account_status" | "kyc_status">): { requires_escalation: boolean; escalation_category?: string } {
  if (c.kyc_status === "review required") return { requires_escalation: true, escalation_category: "compliance" };
  if (c.account_status === "restricted") return { requires_escalation: true, escalation_category: "account" };
  return { requires_escalation: false };
}

export interface Identifiers {
  customerId: string | null;
  email: string | null;
  company_name?: string | undefined;
  contact_name?: string | undefined;
}

/** True if every identifier given matches this customer (normalised; D39). */
export function matchesCustomer(c: Pick<CustomerRow, "customer_id" | "contact_email" | "company_name" | "contact_name">, ids: Identifiers): boolean {
  return (!ids.customerId || c.customer_id === ids.customerId) &&
    (!ids.email || c.contact_email.toLowerCase() === ids.email) &&
    (!ids.company_name || normaliseName(c.company_name) === normaliseName(ids.company_name)) &&
    (!ids.contact_name || contactNameMatches(ids.contact_name, c.contact_name));
}

/**
 * D74: on a call already verified as one customer, a different identity is refused up front, one
 * account per call. Live call 01a0f816… (15:30): verified as Amara, the caller said "Actually,
 * I'm Efua from AccraStack" (transcribed "FY from Acrostic"); the tool returned no_match and the
 * agent asked for more details (an email), as if verifying a second account were possible.
 */
export const ALREADY_VERIFIED_OTHER = {
  found: false,
  verified: false,
  reason: "already_verified_other",
  message: "This call is already verified for another account. Tell the caller you can only help with one account per call, and offer to connect them with a RelayPay specialist. Do not ask for more details.",
} as const;

/** The safe projection of a customer: never support_notes or contact_email (D40). */
export function safeProjection(c: CustomerRow): Record<string, unknown> {
  return {
    customer_id: c.customer_id,
    company_name: c.company_name,
    contact_name: c.contact_name,
    plan: c.plan,
    account_status: c.account_status,
    kyc_status: c.kyc_status,
    ...accountEscalation(c),
  };
}

const NOT_VERIFIED_MESSAGE = "The details given do not match one customer record. Do not say which detail was wrong. Ask the caller to check their details, or offer to connect them with RelayPay support.";

/**
 * L1b guest nudge (D88): on a GUEST call (the call page's "Continue as a guest" pass), the result
 * carries a short line the agent may say once. Rules are unchanged: the two-identifier check runs
 * exactly as before. A lookup failure here only drops the hint.
 */
export const GUEST_HINT = "For a quicker check, you can also start a new call as an existing customer.";
async function isGuestCall(db: Parameters<typeof verifiedCustomerId>[0], conversationId: string): Promise<boolean> {
  const { data, error } = await db.from("call_passes").select("source").eq("conversation_id", conversationId).maybeSingle();
  return !error && (data as { source?: string } | null)?.source === "guest";
}

export const handler = withWriteToolLogging(name, "Verify identity (two identifiers) and return the safe customer projection", async (args, deps): Promise<ToolOutcome> => {
  const outcome = await lookup(args, deps);
  if (outcome.status === "error" || !outcome.result || typeof outcome.result !== "object") return outcome;
  if (!(await isGuestCall(deps.db, deps.ctx.conversationId))) return outcome;
  return { ...outcome, result: { ...(outcome.result as Record<string, unknown>), guest_hint: GUEST_HINT, guest_hint_use: "You may say guest_hint once in this call, at a natural point. It is optional." }, resultSummary: `${outcome.resultSummary ?? outcome.status} +guest_hint` };
});

async function lookup(args: unknown, { db, ctx }: Parameters<Parameters<typeof withWriteToolLogging>[2]>[1]): Promise<ToolOutcome> {
  const parsed = parseArgs(inputSchema, args, "Identifiers must be short strings.");
  if (!parsed.ok) return parsed.outcome;
  const input = parsed.data;

  const given = Object.entries(input).filter(([, v]) => typeof v === "string" && v.length > 0).map(([k]) => k);

  // D74: already verified -> the same customer again, or one account per call. Checked before the
  // one-identifier rule and before any matching, so a second identity is never "verified further".
  // D89: with NO identifiers on a verified call (e.g. identified by the call page form, D88), the
  // verified customer's safe projection is returned: nothing to match, nothing to refuse.
  const verified = await verifiedCustomerId(db, ctx.conversationId);
  if (verified) {
    const { data: row, error: readError } = await db.from("customers")
      .select("customer_id, company_name, contact_name, contact_email, plan, account_status, kyc_status")
      .eq("customer_id", verified).maybeSingle();
    if (readError) throw new Error(`customers read failed (${readError.code}): ${readError.message}`);
    const ids: Identifiers = {
      customerId: input.customer_id ? normaliseReference(input.customer_id, "CUS") : null,
      email: input.email ? normaliseEmail(input.email) : null,
      company_name: input.company_name,
      contact_name: input.contact_name,
    };
    const malformed = (input.customer_id && !ids.customerId) || (input.email && !ids.email);
    const c = row as CustomerRow | null;
    if (c && !malformed && matchesCustomer(c, ids)) {
      // Same customer again: still a guarded (idempotent) write, so a replaced attempt is refused
      // here like everywhere else (D29); throws AttemptNotActiveError -> denied attempt_not_active.
      await guardedRpc(db, "set_verified_customer", { p_conversation_id: ctx.conversationId, p_customer_id: c.customer_id }, ctx.attemptId);
      return { status: "success", result: { found: true, verified: true, ...safeProjection(c) }, resultSummary: `already verified ${c.customer_id} (given: ${given.join(",") || "none"})` };
    }
    const note = await logEventBestEffort(db, ctx, "identity_failed", "A different identity was given on a call already verified for another customer (one account per call)", { identifiers: given });
    return { status: "denied", result: { ...ALREADY_VERIFIED_OTHER }, resultSummary: `denied: already_verified_other (verified ${verified}; given: ${given.join(",")})${note}` };
  }

  if (given.length < 2) {
    // Never look anything up with a single identifier: its existence alone is information.
    return {
      status: "denied",
      result: { found: false, verified: false, reason: "needs_second_identifier", message: "Ask the caller for one more identifier: customer ID, account email, company name or their name." },
      resultSummary: `denied: needs_second_identifier (given: ${given.join(",") || "none"})`,
    };
  }

  let customerId: string | null = null;
  if (input.customer_id) {
    customerId = normaliseReference(input.customer_id, "CUS");
    if (!customerId) return invalid("customer_id must look like CUS-1001.");
  }
  let email: string | null = null;
  if (input.email) {
    email = normaliseEmail(input.email);
    if (!email) return invalid("email is not a valid email address after normalising.");
  }

  // The customers table is small (seed data); matching happens in code on normalised values.
  const { data, error } = await db.from("customers")
    .select("customer_id, company_name, contact_name, contact_email, plan, account_status, kyc_status")
    .limit(10_000);
  if (error) throw new Error(`customers read failed (${error.code}): ${error.message}`);
  const matches = ((data ?? []) as CustomerRow[]).filter((c) => matchesCustomer(c, { customerId, email, company_name: input.company_name, contact_name: input.contact_name }));

  if (matches.length === 0) {
    const note = await logEventBestEffort(db, ctx, "identity_failed", "Identity not verified: the identifiers did not match one customer", { identifiers: given });
    return { status: "not_found", result: { found: false, verified: false, reason: "no_match", message: NOT_VERIFIED_MESSAGE }, resultSummary: `no_match (given: ${given.join(",")})${note}` };
  }
  if (matches.length > 1) {
    const note = await logEventBestEffort(db, ctx, "identity_ambiguous", "Identity not verified: the identifiers match more than one customer", { identifiers: given, candidates: matches.length });
    return {
      status: "denied",
      result: { found: false, verified: false, reason: "ambiguous", message: "The details match more than one customer. Ask for another identifier, such as the customer ID or account email." },
      resultSummary: `ambiguous: ${matches.length} candidates (given: ${given.join(",")})${note}`,
    };
  }

  const c = matches[0]!;
  try {
    await guardedRpc(db, "set_verified_customer", { p_conversation_id: ctx.conversationId, p_customer_id: c.customer_id }, ctx.attemptId);
  } catch (err) {
    if (err instanceof Error && err.message.includes("VERIFIED_CUSTOMER_CONFLICT")) {
      return {
        status: "denied",
        result: { ...ALREADY_VERIFIED_OTHER }, // the database-level backstop for D74's check above
        resultSummary: "denied: conversation already verified as another customer",
        errorMessage: err.message,
      };
    }
    throw err;
  }
  const note = await logEventBestEffort(db, ctx, "identity_verified", `Caller verified as ${c.customer_id}`, { customer_id: c.customer_id, identifiers: given });
  return {
    status: "success",
    result: { found: true, verified: true, ...safeProjection(c) },
    resultSummary: `verified ${c.customer_id} (given: ${given.join(",")})${note}`,
  };
}
