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

export type GroundingFlagKind =
  | "strengthening_word" | "dropped_hedge" | "unsupported_specific" | "invented_attribution"
  | "outcome_promise" | "timeline_promise" | "unsupported_status";

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

function attributionsIn(s: string, source: string, caller: string, allowedNouns: ReadonlySet<string> = new Set()): string[] {
  if (has(source, "your")) return [];
  const out: string[] = [];
  for (const m of s.matchAll(/\byour\s+(?:own\s+|specific\s+|particular\s+)?([a-z]+)(?:\s+([a-z]+))?/g)) {
    // Either word can be the noun: "your restricted account" is about the caller's account.
    const words = [m[1]!, m[2]].filter((w): w is string => Boolean(w));
    if (words.some((w) => allowedNouns.has(w))) continue;
    if (!words.some((w) => has(caller, `my ${w}`) || has(caller, `our ${w}`))) out.push(m[0]);
  }
  return out;
}

// ---- Outcome and timeline promises (D38, D41). Run on normalised text (number words -> digits).
// escalation-rules.md: never promise specific outcomes or give timelines for disputes or reviews.
// High precision on purpose: each pattern is a promise construction, not a lone word, so
// "What can I help you with today?" or "timelines depend on external banking systems" pass.
const OUTCOME_PROMISES: readonly RegExp[] = [
  /\b(?:will|'ll|is going to|are going to|gonna)\s+(?:be\s+|get\s+)?(?:lifted|resolved|refunded|approved|reversed|released|unblocked|restored|reinstated|fixed|sorted|credited|cleared|unfrozen|reactivated)\b/,
  /\bin most cases,?\s+(?:they|it|this|these|those|restrictions?|accounts?|reviews?|payments?|payouts?)(?:'re|'s|\s+are|\s+is|\s+will|\s+get|\s+gets)\b/,
  /\b(?:usually|typically|normally|generally)\s+(?:gets?\s+|are\s+|is\s+)?(?:resolved|lifted|approved|refunded|cleared|released)\b/,
  /\b(?:i|we)\s+promise\b/,
  /\bguarantee(?:d|s)?\b/,
];
const TIMELINE_PROMISES: readonly RegExp[] = [
  /\bright away\b/,
  /\bstraight away\b/,
  /\bimmediately\b/,
  /\bas soon as possible\b|\basap\b/,
  /\bwithin\s+(?:the\s+next\s+)?(?:\d+|a|an|a few|few|a couple of)\s*(?:-\s*\d+\s*|to\s+\d+\s+)?(?:business\s+|working\s+)?(?:minutes?|hours?|days?|weeks?)\b/,
  /\bby\s+(?:tomorrow|tonight|today|end of (?:the\s+)?(?:day|week)|close of business|next week|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/,
  // Anywhere in the same clause (live S7: "will follow up with you at <email> tomorrow morning").
  /\b(?:will|'ll|should|shall|going to)\b[^,.;!?]{0,80}?\b(?:today|tonight|tomorrow)\b/,
  /\blater today\b/,
  /\b(?:will|'ll)\b[^,.;!?]{0,80}?\b(?:soon|shortly)\b/, // live S7: "They'll look into your restricted account and be in touch soon"
  /\bin (?:the next )?\d+\s*(?:hours?|minutes?)\b/,
];

/**
 * True if the phrase sits in the same clause after a negated commitment verb: "can't guarantee
 * that it arrives within 7 days". A comma or other clause break ends the scope, so "I can't
 * confirm it, but it will be lifted right away" is still a promise.
 */
function deniedInClause(s: string, term: string): boolean {
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\b(?:can'?t|cannot|can not|won'?t|unable to|not able to|couldn'?t)\\s+(?:\\w+\\s+){0,2}(?:guarantee|promise|confirm|commit to|say)\\b[^,.;!?]*${escaped}`).test(s);
}

/** Promise phrases in a normalised sentence that the evidence does not itself contain. */
function promisesIn(sentence: string, source: string): Array<{ kind: "outcome_promise" | "timeline_promise"; term: string }> {
  // An email address's dots are not clause breaks.
  const s = sentence.replace(/[^\s@]+@[^\s@]+\.[a-z]{2,}/g, "email");
  const out: Array<{ kind: "outcome_promise" | "timeline_promise"; term: string }> = [];
  const scan = (kind: "outcome_promise" | "timeline_promise", patterns: readonly RegExp[]) => {
    for (const re of patterns) {
      const m = re.exec(s);
      if (!m) continue;
      const term = m[0].trim();
      if (has(source, term)) continue; // the evidence itself says it
      if ((term.startsWith("guarantee") || term === "immediately") && negated(s, term)) continue; // "can't guarantee"
      if (deniedInClause(s, term)) continue; // "can't guarantee it arrives within 7 days" denies, not promises
      out.push({ kind, term });
    }
  };
  scan("outcome_promise", OUTCOME_PROMISES);
  scan("timeline_promise", TIMELINE_PROMISES);
  return out;
}

// ---- Record statuses and dates (only when a tool result is part of the evidence).
const STATUS_TERMS = [
  "completed", "delayed", "failed", "scheduled", "restricted", "approved", "suspended", "cancelled", "canceled",
  "refunded", "reversed", "processing", "on hold", "under review", "pending", "rejected", "blocked", "frozen",
  "successful", "succeeded", "arrived", "delivered", "paid",
];
const MONTHS: Record<string, string> = {
  january: "01", february: "02", march: "03", april: "04", may: "05", june: "06",
  july: "07", august: "08", september: "09", october: "10", november: "11", december: "12",
};

function statusesIn(s: string, source: string, caller: string): string[] {
  return STATUS_TERMS.filter((t) => {
    if (!has(s, t) || negated(s, t)) return false;
    if (t === "under review") return !has(source, "review") && !has(caller, "review");
    return !has(source, t) && !has(caller, t);
  });
}

/** Month names in the sentence that no date in the evidence has ("August" needs a -08- date). */
function monthsIn(s: string, source: string, caller: string): string[] {
  // "may" is also a verb; only a "may <day>" date form counts.
  return Object.entries(MONTHS)
    .filter(([name]) => (name === "may" ? /\bmay\s+\d{1,2}(?:st|nd|rd|th)?\b/.test(s) : has(s, name)))
    .filter(([name, mm]) => !has(source, name) && !has(caller, name) && !new RegExp(`\\d{4}-${mm}-\\d{2}`).test(source))
    .map(([name]) => name);
}

export type FilterMode = "full" | "promises";

export interface SentenceFilterOptions {
  /** "full": every blocking check (answer, escalate). "promises": outcome/timeline promises only (clarify, decline). */
  mode?: FilterMode;
  /** Successful tool results observed in this attempt (JSON text); evidence like chunks (D41). */
  records?: readonly string[];
  /** Nouns "your <noun>" may use without evidence (requests such as "your name", or the looked-up record). */
  allowedYourNouns?: readonly string[];
}

/**
 * Runtime sentence filter (D37, D41). Built once per message from the cited chunks
 * ("heading\ncontent"), the successful tool results, and everything the caller said; check()
 * returns the blocking flags for one sentence (empty = safe to speak). Unlike the eval checks,
 * numbers are blocked even inside a disclaimer unless the evidence or the caller said them:
 * "I can't confirm it will arrive in 24 hours" still puts a number in the caller's ear that no
 * evidence supports. Promise phrases are exempt only if the evidence (not the caller) contains
 * the exact phrase.
 */
export class SentenceFilter {
  private readonly source: string;
  private readonly caller: string;
  private readonly mode: FilterMode;
  private readonly hasRecords: boolean;
  private readonly allowedNouns: ReadonlySet<string>;

  constructor(citedChunks: string[], callerText = "", options: SentenceFilterOptions = {}) {
    const records = options.records ?? [];
    this.source = normalise([...citedChunks, ...records].join("\n"));
    this.caller = normalise(callerText);
    this.mode = options.mode ?? "full";
    this.hasRecords = records.length > 0;
    this.allowedNouns = new Set(options.allowedYourNouns ?? []);
  }

  check(sentence: string): GroundingFlag[] {
    const s = normalise(sentence);
    const flags: GroundingFlag[] = [];
    for (const p of promisesIn(s, this.source)) flags.push({ kind: p.kind, term: p.term, sentence });
    if (this.mode === "promises") return flags;
    for (const w of strengtheningIn(s, this.source)) {
      if (!flags.some((f) => f.term.includes(w))) flags.push({ kind: "strengthening_word", term: w, sentence });
    }
    for (const a of attributionsIn(s, this.source, this.caller, this.allowedNouns)) flags.push({ kind: "invented_attribution", term: a, sentence });
    for (const n of numbersIn(s)) {
      if (!has(this.source, n) && !has(this.caller, n)) flags.push({ kind: "unsupported_specific", term: n, sentence });
    }
    if (this.hasRecords) {
      for (const t of statusesIn(s, this.source, this.caller)) flags.push({ kind: "unsupported_status", term: t, sentence });
      for (const m of monthsIn(s, this.source, this.caller)) flags.push({ kind: "unsupported_specific", term: m, sentence });
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
