// Deterministic grounding checks (D30, D32). They compare a spoken answer with the chunks it
// cited and FLAG likely problems; they never fail a case on their own. The Task 6 LLM judge
// decides. Four checks:
//   strengthening_word    intensifier in the answer that the cited chunks don't use ("exact")
//   dropped_hedge         a chunk hedges a numeric claim ("usually 2 to 5") but the answer
//                         states the same numbers without any hedge
//   unsupported_specific  a number, percentage or place in the answer that the cited chunks
//                         don't contain (a place the caller mentioned is still flagged when the
//                         answer makes a claim about it)
//   invented_attribution  "your <thing>" when the cited chunks attribute nothing to the reader
// A sentence that explicitly declines to confirm something ("I can't confirm ... for Kenya") is
// not a claim, so SPECIFICS (numbers, places) inside it are not flagged; attributions and
// strengthening words inside it still are. A NEGATED intensifier ("can't guarantee")
// weakens rather than strengthens, and "your X" repeating the caller's own "my X" is not an
// invented attribution (both were false positives in the first grounding-eval run). Chunk
// headings count as evidence (callers pass "heading\ncontent").
//
// Runtime use (D37): SentenceFilter runs the high-precision subset (strengthening words,
// invented attributions, numbers absent from both the chunks and the caller's words) on every
// answer sentence before it is spoken, and the backend drops flagged sentences. Places and
// dropped hedges stay eval-only: they are lower precision and would silence good sentences.

export type GroundingFlagKind = "strengthening_word" | "dropped_hedge" | "unsupported_specific" | "invented_attribution";

export interface GroundingFlag {
  kind: GroundingFlagKind;
  /** The offending word or specific. */
  term: string;
  /** The answer sentence it appeared in. */
  sentence: string;
}

const STRENGTHENING = [
  "exact", "exactly", "always", "never", "guarantee", "guaranteed", "guarantees", "definitely",
  "certainly", "every", "instantly", "immediately", "precisely", "for sure", "no doubt", "up front", "upfront",
];
const HEDGES = ["usually", "typically", "may", "might", "can", "vary", "varies", "depending", "depends", "generally", "often", "around", "about", "approximately"];
const PLACES = [
  "africa", "europe", "north america", "kenya", "nigeria", "ghana", "rwanda", "south africa", "uganda", "tanzania",
  "egypt", "morocco", "ethiopia", "senegal", "cameroon", "lagos", "nairobi", "accra", "kigali", "cape town",
  "united kingdom", "uk", "united states", "usa", "us", "canada", "germany", "france",
];
const NUMBER_WORDS: Record<string, string> = {
  zero: "0", one: "1", two: "2", three: "3", four: "4", five: "5", six: "6", seven: "7", eight: "8", nine: "9", ten: "10",
  eleven: "11", twelve: "12", fifteen: "15", twenty: "20", thirty: "30",
};
const DISCLAIMER = /\b(can(?:no|')?t|cannot|can not|unable to|not able to|don'?t have|do not have|couldn'?t|could not)\b[^.?!]*\b(confirm|say|tell|know|verify|promise|guarantee)\b/i;

function normalise(text: string): string {
  return text
    .toLowerCase()
    .replace(/[’`]/g, "'")
    .replace(/\b(zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty|thirty)\b/g, (w) => NUMBER_WORDS[w]!)
    .replace(/\s+/g, " ");
}

function sentencesOf(text: string): string[] {
  return text.split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter(Boolean);
}

const has = (haystack: string, term: string) => new RegExp(`(^|[^a-z0-9])${term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z0-9]|$)`).test(haystack);

/** True if the intensifier is negated just before it ("can't guarantee", "does not always"). */
function negated(sentence: string, word: string): boolean {
  const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\b(not|no|never|can'?t|cannot|won'?t|don'?t|doesn'?t|isn'?t|aren'?t|unable to)(\\s+\\w+){0,2}\\s+${escaped}\\b`).test(sentence);
}

function numbersIn(text: string): string[] {
  return [...text.matchAll(/\d+(?:[.,]\d+)?%?/g)].map((m) => m[0]);
}

function strengtheningIn(s: string, source: string): string[] {
  return STRENGTHENING.filter((w) => has(s, w) && !has(source, w) && !negated(s, w));
}

function attributionsIn(s: string, source: string, caller: string): string[] {
  if (has(source, "your")) return [];
  const out: string[] = [];
  for (const m of s.matchAll(/\byour\s+(?:own\s+|specific\s+|particular\s+)?([a-z]+)(?:\s+[a-z]+)?/g)) {
    const noun = m[1]!;
    if (!has(caller, `my ${noun}`) && !has(caller, `our ${noun}`)) out.push(m[0]);
  }
  return out;
}

/**
 * Runtime sentence filter (D37). Built once per turn from the cited chunks ("heading\ncontent")
 * and everything the caller said; check() returns the blocking flags for one sentence (empty =
 * safe to speak). Unlike the eval checks, numbers are blocked even inside a disclaimer unless
 * the chunks or the caller said them: "I can't confirm it will arrive in 24 hours" still puts a
 * number in the caller's ear that no evidence supports.
 */
export class SentenceFilter {
  private readonly source: string;
  private readonly caller: string;

  constructor(citedChunks: string[], callerText = "") {
    this.source = normalise(citedChunks.join("\n"));
    this.caller = normalise(callerText);
  }

  check(sentence: string): GroundingFlag[] {
    const s = normalise(sentence);
    const flags: GroundingFlag[] = [];
    for (const w of strengtheningIn(s, this.source)) flags.push({ kind: "strengthening_word", term: w, sentence });
    for (const a of attributionsIn(s, this.source, this.caller)) flags.push({ kind: "invented_attribution", term: a, sentence });
    for (const n of numbersIn(s)) {
      if (!has(this.source, n) && !has(this.caller, n)) flags.push({ kind: "unsupported_specific", term: n, sentence });
    }
    return flags;
  }
}

export function checkGrounding(answer: string, citedChunks: string[], callerText = ""): GroundingFlag[] {
  const flags: GroundingFlag[] = [];
  const source = normalise(citedChunks.join("\n"));
  const caller = normalise(callerText);
  const sourceSentences = sentencesOf(citedChunks.join("\n")).map(normalise);
  const add = (kind: GroundingFlagKind, term: string, sentence: string) => {
    if (!flags.some((f) => f.kind === kind && f.term === term && f.sentence === sentence)) flags.push({ kind, term, sentence });
  };

  for (const raw of sentencesOf(answer)) {
    const s = normalise(raw);
    const disclaimer = DISCLAIMER.test(s);

    for (const w of strengtheningIn(s, source)) add("strengthening_word", w, raw);

    if (!disclaimer) {
      for (const n of numbersIn(s)) if (!has(source, n)) add("unsupported_specific", n, raw);
      for (const p of PLACES) {
        if (has(s, p) && !has(source, p)) add("unsupported_specific", has(caller, p) ? `${p} (echoed from the caller)` : p, raw);
      }
    }

    // Checked inside disclaimers too: "I can't confirm X without knowing more about your banking
    // setup there" still invents something about the caller (live call 01a0ef57…).
    for (const a of attributionsIn(s, source, caller)) add("invented_attribution", a, raw);

    // Dropped hedge: the same numbers as a hedged chunk sentence, but no hedge in the answer.
    const nums = numbersIn(s);
    if (nums.length && !HEDGES.some((h) => has(s, h))) {
      const hedgedSource = sourceSentences.find((src) => HEDGES.some((h) => has(src, h)) && nums.every((n) => has(src, n)));
      if (hedgedSource) add("dropped_hedge", nums.join(" to "), raw);
    }
  }
  return flags;
}
