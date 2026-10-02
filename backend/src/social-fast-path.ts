// Deterministic social fast path (D35). If the caller's WHOLE message, normalised, is a clear
// social phrase, the backend picks the intent and speaks the fixed line with NO model call and
// without waiting for the database. Anything else goes to the model as before.
//
// Design principle: goodbye ENDS the call (Vapi end-call phrase, D36), so a false goodbye (hanging
// up on a caller who still has a question) is worse than asking "anything else?" once more. The
// fast path therefore only fires on clear phrases; short declines like a bare "no" count as
// goodbye ONLY right after the backend's fixed "anything else?" line (thanks or declined_offer).
// After any other question or offer (a ticket, a callback), the same decline declines THAT offer:
// the backend speaks the declined_offer line, which asks "anything else?" and so sets up the
// goodbye context for the next reply (live call 01a0f455…: "No, thank you." to a ticket offer
// was taken as goodbye and hung up).

import { OFF_TOPIC_LINE, SOCIAL_LINES } from "./config.js";
import type { SocialIntent } from "./gate.js";

/** Words that carry no intent and are dropped before matching. "oh"/"well" are NOT fillers. */
const FILLERS = ["all right", "alright", "okay", "ok", "great", "perfect", "cool", "awesome"];

const THANKS = [
  "thank you", "thank you so much", "thank you very much", "thanks", "thanks so much", "thanks a lot",
  "thank you for helping", "thanks for helping", "thank you for your help", "thanks for your help",
  "thank you for the help", "thanks for the help", "thank you for helping me", "thanks for helping me",
  "much appreciated", "appreciate it", "i appreciate it",
];

/** Goodbye phrases that are clear on their own, with or without thanks around them. */
const GOODBYE = ["bye", "goodbye", "good bye", "bye bye"];
const DONE = ["that's all", "no that's all", "nothing else", "no nothing else"];

/** Short declines: goodbye right after "anything else?", declined_offer after another question or offer. */
const DECLINE_AFTER_ANYTHING_ELSE = [
  "no", "nah", "nope", "i'm good", "no i'm good", "nah i'm good", "all good", "that's all",
  "not really", "no thanks", "no thank you", "nothing else", "no nothing else", "no that's all",
];

export function normalise(text: string): string {
  let s = ` ${text.toLowerCase().replace(/[’`]/g, "'").replace(/[^a-z0-9' ]+/g, " ")} `;
  // Speech-to-text often drops apostrophes.
  s = s.replace(/ thats /g, " that's ").replace(/ im /g, " i'm ");
  for (const f of FILLERS) s = s.split(` ${f} `).join(" ");
  return s.replace(/\s+/g, " ").trim();
}

const alt = (list: readonly string[]) => list.map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).sort((a, b) => b.length - a.length).join("|");
const THANKS_RE = alt(THANKS);
const PURE_THANKS = new RegExp(`^(?:${THANKS_RE})$`);
// goodbye/done, optionally preceded or followed by thanks
const CLEAR_GOODBYE = new RegExp(`^(?:(?:${THANKS_RE}) )?(?:${alt([...GOODBYE, ...DONE])})(?: (?:${THANKS_RE}))?(?: (?:${alt(GOODBYE)}))?$`);
const THANKS_THEN_BYE = new RegExp(`^(?:${THANKS_RE}) (?:${alt(GOODBYE)})$`);
const DECLINE_IN_CONTEXT = new RegExp(`^(?:(?:${THANKS_RE}) )?(?:${alt(DECLINE_AFTER_ANYTHING_ELSE)})(?: (?:${THANKS_RE}))?$`);

/** The fixed lines that ask "anything else?"; only after one of these can a decline be a goodbye. */
// D78: the off-topic decline line ends "Is there anything RelayPay-related I can help you with?":
// an anything-else question, so a decline after it is a goodbye (D73).
const ANYTHING_ELSE_LINES = new Set([normalise(SOCIAL_LINES.thanks), normalise(SOCIAL_LINES.declined_offer), normalise(OFF_TOPIC_LINE)]);

/**
 * The previous line's LAST question asked whether there's anything else (D73). Not only the fixed
 * lines: live call 01a0f80f… declined the weather with "…Is there anything else I can help you
 * with regarding RelayPay?", and "No. Thank you." got "anything else?" again (declined_offer)
 * because that model-written line wasn't an exact fixed line. An offer earlier in the same line
 * doesn't matter; the last question does.
 */
function askedAnythingElse(previousAgentLine: string | null): boolean {
  if (previousAgentLine === null) return false;
  if (ANYTHING_ELSE_LINES.has(normalise(previousAgentLine))) return true;
  const questions = previousAgentLine.split(/(?<=[.!?])\s*/).filter((q) => q.trim().endsWith("?"));
  const last = questions[questions.length - 1];
  return last !== undefined && /\banything else\b/i.test(last) && /\b(help|assist|do for you)\b/i.test(last);
}

/**
 * D90: a confirmation or read-back ("I have your email as tamara@… Is that correct?"). A "no" to
 * it is a CORRECTION the model must handle, never a declined offer (live call 01a0fca1…, turn 7:
 * "No." got "No problem. Is there anything else I can help you with?").
 */
const CONFIRMATION = /\b(?:is (?:that|this|it) (?:correct|right)|did i get (?:that|this|it) right|have i got (?:that|this|it) right|does that sound right|is that the right)\b/;
const READ_BACK = /\b(?:i have your|let me read (?:that|it) back|read that back|just to confirm|to confirm|you said|i've got your|i have you down as)\b/;
/** An offer: a ticket, a callback, a specialist ("Would you like me to…", "I can connect you…", "…if you'd like"). */
const OFFER = /\b(?:would you like|if you'd like|if you would like|do you want|want me to|shall i|i can connect you|i can arrange|can i arrange|i can create|i can open|i can set up)\b/;

/** D90: the agent's line made an OFFER and isn't a confirmation or read-back. Only then is "no" a declined offer. */
export function offered(previousAgentLine: string | null): boolean {
  if (previousAgentLine === null) return false;
  const n = normalise(previousAgentLine);
  if (CONFIRMATION.test(n) || READ_BACK.test(n)) return false;
  return OFFER.test(n);
}

/**
 * The social intent for this caller message, or null to send it to the model.
 * `previousAgentLine` is the last assistant message in the conversation (as Vapi reports it).
 */
export function matchSocial(callerText: string, previousAgentLine: string | null): SocialIntent | null {
  const s = normalise(callerText);
  if (!s) return null; // e.g. "All right." alone: no intent, let the model (or the fuller request) decide
  if (CLEAR_GOODBYE.test(s) || THANKS_THEN_BYE.test(s)) return "goodbye";
  if (DECLINE_IN_CONTEXT.test(s)) {
    if (askedAnythingElse(previousAgentLine)) return "goodbye";
    if (offered(previousAgentLine)) return "declined_offer";
  }
  if (PURE_THANKS.test(s)) return "thanks";
  return null;
}

/**
 * Whether a model-chosen goodbye may stand (the gate's guard; the model is not trusted to end the
 * call). Allowed right after the fixed "anything else?" line, or when the caller's message itself
 * says goodbye or that they're done. Otherwise the gate speaks the declined_offer line instead.
 */
export function goodbyeAllowed(callerText: string, previousAgentLine: string | null): boolean {
  if (askedAnythingElse(previousAgentLine)) return true;
  return /\b(?:bye|goodbye|good bye|that's all|that's it|nothing else)\b/.test(normalise(callerText));
}
