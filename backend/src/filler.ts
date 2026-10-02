// Fixed backend lines around tool use (D91). Pure functions, unit-tested in filler.test.ts.
//
// - Early filler: a caller message that names a TXN-/PAY- reference (also spoken: "T X N nine zero
//   zero one", "pay seven zero zero two") or asks about their account / transaction / payout
//   status will need a lookup, so "One moment while I check that." is spoken at request start,
//   before the model runs, and not again in the turn.
// - Tool filler: lookup tools get the check line; create_support_ticket / create_escalation get
//   "One moment while I set that up."; log_conversation_event gets none.
// - After a successful ticket or escalation, a reply that doesn't end with a question gets the fixed
//   "Is there anything else I can help you with?", which is the anything-else context for D73.

import { FILLER_LINE, WRITE_FILLER_LINE } from "./config.js";

export const ANYTHING_ELSE_LINE = "Is there anything else I can help you with?";

const DIGIT = "(?:\\d|zero|oh|o|one|two|three|four|five|six|seven|eight|nine)";
const REFERENCE = new RegExp(`\\b(?:t[\\s.-]*x[\\s.-]*n|p[\\s.-]*a[\\s.-]*y)[\\s.:#-]*(?:${DIGIT}[\\s,.-]*){4}`, "i");
const STATUS = /\b(?:status|check|look up|lookup|where is|where's|what's happening|what is happening)\b[^.?!]{0,60}\b(?:account|transaction|payout|payment|transfer)s?\b|\b(?:account|transaction|payout|payment|transfer)s?\b[^.?!]{0,40}\bstatus\b/i;

/** The caller's message will need a lookup: speak the filler at request start. */
export function wantsEarlyFiller(callerText: string): boolean {
  return REFERENCE.test(callerText) || STATUS.test(callerText);
}

/** The filler for a tool that is starting, or null for none. */
export function fillerFor(toolName: string): string | null {
  if (toolName === "lookup_customer" || toolName === "lookup_transaction" || toolName === "lookup_payout") return FILLER_LINE;
  if (toolName === "create_support_ticket" || toolName === "create_escalation") return WRITE_FILLER_LINE;
  return null;
}

/** After a successful write: append the anything-else question unless the reply already ends with a question. */
export function needsAnythingElse(writeSucceeded: boolean, spokenSoFar: string): boolean {
  return writeSucceeded && !/\?\s*$/.test(spokenSoFar.trim());
}
