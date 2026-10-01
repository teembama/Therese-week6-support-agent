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
  | "outcome_promise" | "timeline_promise" | "unsupported_status" | "internal_term" | "speculative_diagnosis";

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
    // "one" as a pronoun or in a set phrase is not the number 1 ("is it one you're sending?",
    // "one moment"); D58 replay of the stored clarify replies.
    .replace(/\bone\b(?=\s+(?:you|you're|that|which|who|of|i|i'm|we|they|is|was|moment|more|another|thing)\b)/g, "one\u0000")
    .replace(/\b(zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty|thirty)\b(?!\u0000)/g, (w) => NUMBER_WORDS[w]!)
    .replace(/\u0000/g, "")
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
  // Outcome verbs without "will" (D65; BEFORE eval S6: "...follow up on the beneficiary details
  // and get your payment sorted"). "A representative will follow up" stays allowed (D41).
  /\bget(?:ting)?\s+(?:(?:your|the|this|that|it|everything|things)\s+)?(?:\w+\s+)?(?:sorted|resolved|fixed|cleared up)\b/,
  /\b(?:taken|take|takes|taking)\s+care\s+of\b/,
  /\bsort(?:s|ing)?\s+(?:it|this|that|things|everything)\s+out\b/,
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

// ---- Non-answer replies (decline, clarify, escalate; D58). Their evidence is only the tool
// results and the caller's words, so a reason or a guess about the caller's case has nothing
// behind it: "your account was likely flagged because of unusual activity" is a diagnosis
// (escalation-rules.md: never diagnose account issues or explain compliance decisions).
const DIAGNOSIS: readonly RegExp[] = [
  /\b(?:most likely|likely|probably|possibly|presumably)\b/,
  /\b(?:because of|due to|caused by|as a result of|triggered by)\b/,
  /\bflagged\b/,
];

/** Diagnosis phrases in a normalised sentence that the evidence does not itself contain. */
function diagnosesIn(s: string, source: string): string[] {
  const out: string[] = [];
  for (const re of DIAGNOSIS) {
    const m = re.exec(s);
    if (!m) continue;
    const term = m[0];
    if (has(source, term) || deniedInClause(s, term)) continue; // "I can't say why it was flagged"
    out.push(term);
  }
  return out;
}

/**
 * Reference-format descriptions a clarify reply needs ("TXN followed by four digits", "a
 * reference like TXN-9001"): they describe a format, not a fact, so their numbers (and the
 * "exactly" in "exactly four digits") are not checked. Run on normalised text.
 */
function withoutReferenceFormats(s: string): string {
  return s
    .replace(/\b(?:like|such as|for example|for instance|e\.?g\.?|say)\s*,?\s*(?:txn|pay|cus)[\s-]?\d{4}\b/g, " ")
    .replace(/\b(?:exactly\s+)?\d+[\s-]?(?:digits?|numbers?)\b/g, " ");
}

// ---- Reference formats (D65): real prefixes only. BEFORE eval S6 r3: "references typically start
// with INV or TXN followed by four numbers" (INV doesn't exist). The tool spec's references are
// TXN-#### and PAY-####; CUS-#### is the customer ID format lookup_customer accepts.
const REAL_PREFIXES = new Set(["TXN", "PAY", "CUS"]);

/** Invented prefixes in a sentence that shows or describes a reference format (raw text, case-sensitive). */
function inventedPrefixesIn(raw: string): string[] {
  const out = new Set<string>();
  // "INV-1234" anywhere is a reference-shaped token.
  for (const m of raw.matchAll(/\b([A-Z]{2,5})-\d{2,}\b/g)) if (!REAL_PREFIXES.has(m[1]!)) out.add(m[1]!);
  // "starts with X or Y followed by four numbers": all-caps tokens between "starts with" (or "like",
  // "prefix") and "followed by" are prefixes.
  const m = /\b(?:start|starts|starting|begin|begins|like|such as|prefix(?:ed)?)\b(.{0,60}?)\bfollowed by\b[^.?!]*\b(?:digits?|numbers?)\b/i.exec(raw);
  if (m) for (const t of m[1]!.matchAll(/\b([A-Z]{2,5})\b/g)) if (!REAL_PREFIXES.has(t[1]!) && t[1] !== "ID") out.add(t[1]!);
  return [...out];
}

/** Words never spoken unless the caller used them first (D45). */
const INTERNAL_TERMS = ["compliance"];

export type FilterMode = "full" | "promises";

export interface SentenceFilterOptions {
  /** "full": every blocking check (answer, escalate). "promises": outcome/timeline promises only (clarify, decline). */
  mode?: FilterMode;
  /** Successful tool results observed in this attempt (JSON text); evidence like chunks (D41). */
  records?: readonly string[];
  /** Nouns "your <noun>" may use without evidence (requests such as "your name", or the looked-up record). */
  allowedYourNouns?: readonly string[];
  /**
   * Decline, clarify and escalate replies (D58): also flag speculative diagnoses; skip
   * reference-format descriptions; and don't treat "your X" in a question as an attribution
   * ("Is your payment incoming or outgoing?" asks, it doesn't claim).
   */
  nonAnswer?: boolean;
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
  private readonly nonAnswer: boolean;

  constructor(citedChunks: string[], callerText = "", options: SentenceFilterOptions = {}) {
    const records = options.records ?? [];
    this.source = normalise([...citedChunks, ...records].join("\n"));
    this.caller = normalise(callerText);
    this.mode = options.mode ?? "full";
    this.hasRecords = records.length > 0;
    this.allowedNouns = new Set(options.allowedYourNouns ?? []);
    this.nonAnswer = options.nonAnswer ?? false;
  }

  check(sentence: string): GroundingFlag[] {
    const s = normalise(sentence);
    const flags: GroundingFlag[] = [];
    for (const p of promisesIn(s, this.source)) flags.push({ kind: p.kind, term: p.term, sentence });
    // D45: every spoken type. Compliance matters are for specialists; the word itself invites
    // "explaining compliance decisions" (escalation-rules.md). Allowed only as an echo.
    for (const t of INTERNAL_TERMS) if (has(s, t) && !has(this.caller, t)) flags.push({ kind: "internal_term", term: t, sentence });
    for (const p of inventedPrefixesIn(sentence)) if (!has(this.caller, p.toLowerCase())) flags.push({ kind: "unsupported_specific", term: `${p.toLowerCase()} prefix`, sentence });
    if (this.mode === "promises") return flags;
    const checked = this.nonAnswer ? withoutReferenceFormats(s) : s;
    for (const w of strengtheningIn(checked, this.source)) {
      if (!flags.some((f) => f.term.includes(w))) flags.push({ kind: "strengthening_word", term: w, sentence });
    }
    const asks = this.nonAnswer && /\?\s*$/.test(sentence);
    if (!asks) for (const a of attributionsIn(s, this.source, this.caller, this.allowedNouns)) flags.push({ kind: "invented_attribution", term: a, sentence });
    if (this.nonAnswer) for (const d of diagnosesIn(s, this.source)) flags.push({ kind: "speculative_diagnosis", term: d, sentence });
    for (const n of numbersIn(checked)) {
      if (!has(this.source, n) && !has(this.caller, n)) flags.push({ kind: "unsupported_specific", term: n, sentence });
    }
    if (this.hasRecords) {
      for (const t of statusesIn(s, this.source, this.caller)) flags.push({ kind: "unsupported_status", term: t, sentence });
      for (const m of monthsIn(s, this.source, this.caller)) flags.push({ kind: "unsupported_specific", term: m, sentence });
    }
    return flags;
  }

  /**
   * Attribution repair (D62): when a sentence's ONLY flags are invented attributions and, for
   * each, the phrase after "your" appears verbatim in the evidence, drop that "your" and return
   * the repaired sentence, provided it then passes every check. Otherwise null (the sentence is
   * dropped as before). Live case: "...depending on the destination and your banking partners."
   * -> "...depending on the destination and banking partners." (the chunk: "banking partners").
   */
  repairAttribution(sentence: string, flags: readonly GroundingFlag[]): string | null {
    if (!flags.length || !flags.every((f) => f.kind === "invented_attribution")) return null;
    let out = sentence;
    for (const f of flags) {
      const phrase = f.term.replace(/^your\s+/, "");
      if (!has(this.source, phrase)) return null; // "your own X", "your specific X" never match: kept strict
      const first = phrase.split(" ")[0]!; // letters only (attributionsIn captures [a-z]+)
      const re = new RegExp(`\\byour\\s+(?=${first}\\b)`, "i");
      if (!re.test(out)) return null;
      out = out.replace(re, "");
    }
    out = out.charAt(0).toUpperCase() + out.slice(1);
    return this.check(out).length ? null : out;
  }

  /**
   * Clause trimming (D64): when every flag sits in a trailing clause introduced by a connector
   * (", so", ", so that", ", which", ", meaning", " — ") and the leading clause passes every check
   * on its own, return the leading clause ending with a full stop; otherwise null (dropped as
   * before). A flag in the leading clause is never trimmed away, and the cut never falls inside a
   * number or a reference. Live S1 (eval 2026-10-01): "RelayPay displays the applicable fees
   * before you confirm a transaction, so you'll see exactly what applies to your payment."
   * -> "RelayPay displays the applicable fees before you confirm a transaction."
   */
  trimTrailingClause(sentence: string, flags: readonly GroundingFlag[]): string | null {
    if (!flags.length) return null;
    const cuts = [...sentence.matchAll(/,\s+(?:so that|so|which|meaning)\b|\s+[—–]\s+/gi)].map((m) => m.index!);
    // Latest cut first: keep as much of the sentence as possible.
    for (const cut of cuts.reverse()) {
      const lead = sentence.slice(0, cut).replace(/[\s,;:]+$/, "");
      const trail = sentence.slice(cut);
      if (/\d$/.test(lead) && /^[\s,—–-]*\d/.test(trail)) continue; // inside a number ("2 — 5")
      if (/\b(?:txn|pay|cus)[\s-]*$/i.test(lead)) continue; // inside a reference
      const t = normalise(trail);
      if (!flags.every((f) => t.includes(normalise(f.term)))) continue; // a flag sits in the lead
      const out = `${lead}.`;
      if (lead.split(/\s+/).length >= 3 && this.check(out).length === 0) return out;
    }
    return null;
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
