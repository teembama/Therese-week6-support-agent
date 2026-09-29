// Builds the pre-turn retrieval query (D20). Short follow-ups ("and for Kenya?") carry little
// signal on their own, so they are searched together with the previous caller message.

import { FOLLOW_UP_MIN_MEANINGFUL_WORDS } from "./config.js";
import type { HistoryEntry } from "./prompt.js";

// English stopwords plus conversational fillers that carry no retrieval signal.
const STOPWORDS = new Set(
  (
    "a about above after again against all am an and any are as at be because been before being below between both but by " +
    "can could did do does doing down during each few for from further had has have having he her here hers him his how i if " +
    "in into is it its itself just me more most my no nor not now of off on once only or other our ours out over own same she " +
    "should so some such than that the their them then there these they this those through to too under until up very was we " +
    "were what when where which while who whom why will with would you your yours yourself " +
    "yes yeah ok okay please thanks thank hi hello hey um uh so well also still then what's it's i'm i'd i've can't don't " +
    "tell know like want need get got one"
  ).split(" "),
);

export function meaningfulWordCount(text: string): number {
  return (text.toLowerCase().match(/[a-z0-9][a-z0-9'-]*/g) ?? []).filter((w) => !STOPWORDS.has(w)).length;
}

export interface RetrievalQuery {
  query: string;
  combinedWithPrevious: boolean;
}

export function buildRetrievalQuery(history: HistoryEntry[], userText: string): RetrievalQuery {
  if (meaningfulWordCount(userText) >= FOLLOW_UP_MIN_MEANINGFUL_WORDS) return { query: userText, combinedWithPrevious: false };
  const previous = [...history].reverse().find((h) => h.role === "caller");
  if (!previous) return { query: userText, combinedWithPrevious: false };
  return { query: `${previous.text} ${userText}`, combinedWithPrevious: true };
}
