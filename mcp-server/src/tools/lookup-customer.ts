import { contactNameMatches, guardedRpc, normaliseEmail, normaliseName, normaliseReference } from "@relaypay/shared";
import * as z from "zod";
import { withWriteToolLogging, type ToolOutcome } from "../tool-logging.js";
import { invalid, logEventBestEffort, parseArgs } from "./common.js";

export const name = "lookup_customer";

export const description =
  "Look up the caller's RelayPay customer record. Call it with whatever identifying details the " +
  "caller has given (their name, company name, email or customer ID), as soon as they ask about " +
  "their account: this tool decides whether the details are enough, so do not ask for more " +
  "first. If it returns needs_second_identifier, ambiguous or no_match, ask the caller for " +
  "another identifier. Returns only safe account fields. If verified is false, do not discuss " +
  "account details. If requires_escalation is true, offer to connect the caller with a specialist.";

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

const NOT_VERIFIED_MESSAGE = "The details given do not match one customer record. Do not say which detail was wrong. Ask the caller to check their details, or offer to connect them with RelayPay support.";

export const handler = withWriteToolLogging(name, "Verify identity (two identifiers) and return the safe customer projection", async (args, { db, ctx }): Promise<ToolOutcome> => {
  const parsed = parseArgs(inputSchema, args, "Identifiers must be short strings.");
  if (!parsed.ok) return parsed.outcome;
  const input = parsed.data;

  const given = Object.entries(input).filter(([, v]) => typeof v === "string" && v.length > 0).map(([k]) => k);
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
  const matches = ((data ?? []) as CustomerRow[]).filter((c) =>
    (!customerId || c.customer_id === customerId) &&
    (!email || c.contact_email.toLowerCase() === email) &&
    (!input.company_name || normaliseName(c.company_name) === normaliseName(input.company_name)) &&
    (!input.contact_name || contactNameMatches(input.contact_name, c.contact_name)));

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
        result: { found: false, verified: false, reason: "already_verified_other_customer", message: "This call is already verified for a different customer. Offer to connect the caller with RelayPay support." },
        resultSummary: "denied: conversation already verified as another customer",
        errorMessage: err.message,
      };
    }
    throw err;
  }
  const note = await logEventBestEffort(db, ctx, "identity_verified", `Caller verified as ${c.customer_id}`, { customer_id: c.customer_id, identifiers: given });
  return {
    status: "success",
    result: {
      found: true,
      verified: true,
      // Safe projection only: never support_notes or contact_email.
      customer_id: c.customer_id,
      company_name: c.company_name,
      contact_name: c.contact_name,
      plan: c.plan,
      account_status: c.account_status,
      kyc_status: c.kyc_status,
      ...accountEscalation(c),
    },
    resultSummary: `verified ${c.customer_id} (given: ${given.join(",")})${note}`,
  };
});
