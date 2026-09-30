// Deterministic social fast path (D35). If the caller's WHOLE message, normalised, is a clear
// social phrase, the backend picks the intent and speaks the fixed line with NO model call and
// without waiting for the database. Anything else goes to the model as before.
//
// Design principle: goodbye ENDS the call (Vapi end-call phrase, D36), so a false goodbye (hanging
// up on a caller who still has a question) is worse than asking "anything else?" once more. The
// fast path therefore only fires on clear phrases; short declines like a bare "no" count as
// goodbye ONLY right after the backend asked "anything else?" (the thanks line).

import { SOCIAL_LINES } from "./config.js";
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

/** Short declines that mean goodbye ONLY right after the backend asked "anything else?". */
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

const ANYTHING_ELSE = normalise(SOCIAL_LINES.thanks);

/**
 * The social intent for this caller message, or null to send it to the model.
 * `previousAgentLine` is the last assistant message in the conversation (as Vapi reports it).
 */
export function matchSocial(callerText: string, previousAgentLine: string | null): SocialIntent | null {
  const s = normalise(callerText);
  if (!s) return null; // e.g. "All right." alone: no intent, let the model (or the fuller request) decide
  if (CLEAR_GOODBYE.test(s) || THANKS_THEN_BYE.test(s)) return "goodbye";
  const askedAnythingElse = previousAgentLine !== null && normalise(previousAgentLine) === ANYTHING_ELSE;
  if (askedAnythingElse && DECLINE_IN_CONTEXT.test(s)) return "goodbye";
  if (PURE_THANKS.test(s)) return "thanks";
  return null;
}
