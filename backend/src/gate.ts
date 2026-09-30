// The grounding gate. Pure functions and a small state machine, no I/O, so it is unit-tested
// with fixture outputs (gate.test.ts).
//
// Rules:
// - Nothing is spoken until a valid header [[type=answer|clarify|decline; kb=<ids|none>]] has
//   been parsed at the very start of an assistant message, complete within HEADER_WINDOW_CHARS.
// - type=answer needs at least one cited kb id in this turn's IN-MEMORY retrieved set.
// - Text in a message without a valid header is never spoken. If such a message ends the turn,
//   the turn is blocked: the caller hears SAFE_DECLINE_LINE, answer_type 'blocked'.
// - The header, markup and stray markdown are stripped before speaking.
//
// Streaming (lever 4, StreamingGate): once a message's header is valid, its text is released
// sentence by sentence as the model writes it, instead of waiting for the message to end.
// Multi-step turns: a message containing a tool_use is "thinking aloud". Its text is never
// spoken if it had no valid header. If it had a valid header and a sentence was already spoken
// when the tool_use block started, output from that message stops at once and the turn records
// a gate_violation with exactly what had been sent (the SDK delivers events in order, so
// nothing after the tool_use start is ever written). With the current agent config there are
// no tools, so this path cannot occur in production today (docs/decisions.md D23).
//
// Tool-backed answers (D41): the header is [[type=...; kb=<ids|none>; tool=<name|none>]]. A
// type=answer needs a cited chunk from this attempt's retrieval OR a named grounding tool that the
// BACKEND saw return status success in this attempt (GateEvidence.tools); the model's claim alone
// never counts. type=escalate (the escalation flow) needs neither.
//
// Runtime sentence filter (D37, D41): when the gate is given the turn's evidence, every sentence is
// checked before it is released. answer and escalate get the full SentenceFilter (strengthening
// words, invented attribution, unsupported numbers, outcome/timeline promises, and record
// statuses/dates when a tool result is in the evidence); clarify and decline get the promise
// checks only. Evidence = cited chunks + successful tool results of this attempt + the caller's
// words. A flagged sentence is dropped, not spoken; if a message's every sentence is dropped, the
// turn is blocked and the caller hears SAFE_DECLINE_LINE.

import { performance } from "node:perf_hooks";
import { SentenceFilter, type GroundingFlag, type SentenceFilterOptions } from "@relaypay/shared";
import { HEADER_WINDOW_CHARS, LOOKUP_TOOL_NAMES, MCP_TOOL_PREFIX, SOCIAL_LINES } from "./config.js";

export type ReplyType = "answer" | "clarify" | "decline" | "escalate" | "social";

/**
 * Tools whose successful result grounds a type=answer: the three lookups, plus the two write
 * tools, so "I've logged a ticket" can be an answer grounded in the ticket the backend saw
 * created (D41).
 */
export const GROUNDING_TOOLS: ReadonlySet<string> = new Set([...LOOKUP_TOOL_NAMES, "create_support_ticket", "create_escalation"]);

/** "your <noun>" the model may always say: things it asks the caller for (D41). */
const REQUEST_NOUNS = ["name", "email", "preferred", "callback", "call", "time", "details", "reference", "request", "question", "questions", "patience"];
/** "your <noun>" allowed once a tool has returned the caller's record in this attempt. */
const RECORD_NOUNS = ["account", "payout", "payouts", "transaction", "transactions", "payment", "payments", "transfer", "invoice", "ticket", "escalation", "case", "record", "business", "company", "plan", "verification", "kyc", "status"];

/** What the backend observed the agent's tools return in this attempt (never the model's claim). */
export interface ObservedTools {
  /** True if the named tool (short name) returned status success at least once in this attempt. */
  succeeded(name: string): boolean;
  /** True if the named tool was called at all in this attempt, whatever its status. */
  called(name: string): boolean;
  /** Successful results as JSON text, for the sentence filter's evidence. */
  records(): string[];
}
export type SocialIntent = keyof typeof SOCIAL_LINES;

export interface ParsedHeader {
  type: ReplyType;
  kbIds: string[];
  /** The grounding tool the model names (short name), or null for tool=none / absent. */
  tool: string | null;
  /** Only for type=social. */
  intent?: SocialIntent;
  rest: string;
}

// tool= is optional so a header without it means tool=none.
const HEADER_RE = /^\s*\[\[\s*type\s*=\s*(answer|clarify|decline|escalate)\s*;\s*kb\s*=\s*([^\];]*?)\s*(?:;\s*tool\s*=\s*([a-z_]+)\s*)?\]\]/i;
// Social header carries an intent and NO kb field; anything else (unknown intent, kb=..., extra
// fields) does not match and is treated as a malformed header.
const SOCIAL_HEADER_RE = /^\s*\[\[\s*type\s*=\s*social\s*;\s*intent\s*=\s*(thanks|goodbye|greeting)\s*\]\]/i;

/** The fixed line the backend speaks for a social intent. */
export function socialLine(intent: SocialIntent): string {
  return SOCIAL_LINES[intent];
}
const CHUNK_ID_RE = /^[a-z0-9-]+$/;

/** The header at the very start of the reply, or null if missing, malformed or too late. */
export function parseHeader(text: string, windowChars: number = HEADER_WINDOW_CHARS): ParsedHeader | null {
  const social = SOCIAL_HEADER_RE.exec(text);
  if (social) {
    if (social[0].length > windowChars) return null;
    return { type: "social", kbIds: [], tool: null, intent: social[1]!.toLowerCase() as SocialIntent, rest: text.slice(social[0].length) };
  }
  const m = HEADER_RE.exec(text);
  if (!m || m[0].length > windowChars) return null;
  const type = m[1]!.toLowerCase() as ReplyType;
  const kbRaw = m[2]!.trim().toLowerCase();
  let kbIds: string[] = [];
  if (kbRaw !== "none" && kbRaw !== "") {
    kbIds = kbRaw.split(",").map((s) => s.trim()).filter(Boolean);
    if (!kbIds.every((id) => CHUNK_ID_RE.test(id))) return null;
  }
  const toolRaw = (m[3] ?? "none").toLowerCase().replace(MCP_TOOL_PREFIX, "");
  return { type, kbIds, tool: toolRaw === "none" ? null : toolRaw, rest: text.slice(m[0].length) };
}

/** Plain spoken text: no headers, tags, markdown, lists or symbols; whitespace collapsed. */
export function stripForSpeech(text: string): string {
  return text
    .replace(/\[\[[^\]]*\]\]/g, " ") // any stray header
    .replace(/<[^>]{1,200}>/g, " ") // xml-ish tags the model might echo
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1") // images
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1") // links -> text
    .replace(/```[\s\S]*?```/g, " ") // code blocks
    .replace(/`([^`]*)`/g, "$1")
    .replace(/(\*\*|__)(.+?)\1/g, "$2") // bold
    .replace(/(^|[\s(])[*_](\S(?:.*?\S)?)[*_](?=[\s).,!?;:]|$)/g, "$1$2") // italics
    .replace(/^\s{0,3}#{1,6}\s+/gm, "") // headings
    .replace(/^\s{0,3}>\s?/gm, "") // blockquotes
    .replace(/^\s*(?:[-*+•]|\d+[.)])\s+/gm, "") // list markers
    .replace(/[*#|~^]+/g, " ") // leftover markdown symbols
    .replace(/\s+/g, " ")
    .trim();
}

export type HeaderVerdict =
  | { ok: true; type: ReplyType; citedKbIds: string[]; validKbIds: string[]; unknownKbIds: string[]; tool: string | null }
  | { ok: false; reason: string };

const NO_TOOLS: ObservedTools = { succeeded: () => false, called: () => false, records: () => [] };

/**
 * Checks a parsed header against the turn's retrieved chunk ids and the tool results the backend
 * observed. A false claim blocks the message even if a chunk is also cited.
 * - answer / escalate: a named tool must be a grounding tool that SUCCEEDED in this attempt.
 * - decline / clarify (D48): a named tool only has to have been CALLED in this attempt, whatever
 *   its status: "I can't share details on that reference" after a denied lookup is exactly right,
 *   and these types assert no facts from the result.
 */
export function validateHeader(header: ParsedHeader, retrievedIds: ReadonlySet<string>, tools: ObservedTools = NO_TOOLS): HeaderVerdict {
  const validKbIds = header.kbIds.filter((id) => retrievedIds.has(id));
  const unknownKbIds = header.kbIds.filter((id) => !retrievedIds.has(id));
  if (header.tool !== null) {
    if (header.type === "decline" || header.type === "clarify") {
      if (!tools.called(header.tool)) return { ok: false, reason: `tool=${header.tool} claimed, but it was not called in this attempt` };
    } else {
      if (!GROUNDING_TOOLS.has(header.tool)) return { ok: false, reason: `tool=${header.tool} is not a grounding tool` };
      if (!tools.succeeded(header.tool)) return { ok: false, reason: `tool=${header.tool} claimed, but no successful ${header.tool} result in this attempt` };
    }
  }
  if (header.type === "answer" && validKbIds.length === 0 && header.tool === null) {
    if (header.kbIds.length === 0) return { ok: false, reason: "type=answer with kb=none and tool=none" };
    return { ok: false, reason: `type=answer cites no retrieved chunk (cited: ${header.kbIds.join(",")}) and no tool` };
  }
  return { ok: true, type: header.type, citedKbIds: header.kbIds, validKbIds, unknownKbIds, tool: header.tool };
}

export type GateVerdict =
  | { ok: true; type: ReplyType; spoken: string; citedKbIds: string[]; validKbIds: string[]; unknownKbIds: string[]; tool: string | null }
  | { ok: false; reason: string };

/** Checks a complete reply (whole-message form of the gate; used for fixtures). */
export function evaluateReply(text: string, retrievedIds: ReadonlySet<string>, tools: ObservedTools = NO_TOOLS): GateVerdict {
  const header = parseHeader(text);
  if (!header) return { ok: false, reason: "missing, malformed or late header" };
  const verdict = validateHeader(header, retrievedIds, tools);
  if (!verdict.ok) return verdict;
  if (header.type === "social") return { ...verdict, spoken: socialLine(header.intent!) }; // model text discarded
  const spoken = stripForSpeech(header.rest);
  if (!spoken) return { ok: false, reason: "empty reply after header" };
  return { ...verdict, spoken };
}

/** Splits spoken text into sentence-sized pieces for streaming to TTS. */
export function sentences(text: string): string[] {
  return text.split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter(Boolean);
}

/**
 * What the runtime sentence filter and the tool check need: chunk text by id ("heading\ncontent"),
 * all the caller's words, and the tool results observed so far in this attempt (read when a
 * message's header is validated, so results from earlier messages of the turn are included).
 */
export interface GateEvidence {
  chunks: ReadonlyMap<string, string>;
  callerText: string;
  tools?: ObservedTools;
}

/** The sentence-filter configuration for a reply type (null = not filtered). */
export function filterOptionsFor(type: ReplyType, records: readonly string[]): SentenceFilterOptions | null {
  if (type === "social") return null;
  if (type === "clarify" || type === "decline") return { mode: "promises", records };
  return { mode: "full", records, allowedYourNouns: records.length ? [...REQUEST_NOUNS, ...RECORD_NOUNS] : REQUEST_NOUNS };
}

export interface FilteredSentence {
  sentence: string;
  flags: GroundingFlag[];
}

export type MessageOutcome =
  | { kind: "final"; type: ReplyType; validKbIds: string[]; unknownKbIds: string[]; tool: string | null; speak: string[] }
  | { kind: "blocked"; reason: string; raw: string }
  | { kind: "discarded"; raw: string; spokenBeforeToolUse: string[] };

/**
 * Streaming gate for one turn. Feed it the main agent's raw stream events per message:
 * start() at message_start, text() per text delta, toolUse() at a tool_use block start,
 * end(stopReason) at message_stop. text() and end() return sentences that may be spoken now.
 */
export class StreamingGate {
  private raw = "";
  private headerState: "pending" | "valid" | "invalid" = "pending";
  private invalidReason = "";
  private body = "";
  private spokenInMessage: string[] = [];
  private stoppedByTool = false;
  private verdict: Extract<HeaderVerdict, { ok: true }> | null = null;
  private socialIntent: SocialIntent | null = null;
  private filter: SentenceFilter | null = null;
  private filteredInMessage = 0;
  private filtered: FilteredSentence[] = [];
  /** Filter cost, for the latency budget (under 5ms per sentence). */
  readonly filterStats = { sentences: 0, totalMs: 0, maxMs: 0 };

  constructor(
    private readonly retrievedIds: ReadonlySet<string>,
    private readonly windowChars: number = HEADER_WINDOW_CHARS,
    private readonly evidence?: GateEvidence,
  ) {}

  /** Sentences dropped by the filter since the last call (for logging). */
  takeFiltered(): FilteredSentence[] {
    const out = this.filtered;
    this.filtered = [];
    return out;
  }

  start(): void {
    this.raw = "";
    this.headerState = "pending";
    this.invalidReason = "";
    this.body = "";
    this.spokenInMessage = [];
    this.stoppedByTool = false;
    this.verdict = null;
    this.socialIntent = null;
    this.filter = null;
    this.filteredInMessage = 0;
  }

  /** Sentences that became speakable with this delta (header already validated). */
  text(delta: string): string[] {
    this.raw += delta;
    if (this.stoppedByTool || this.headerState === "invalid") return [];
    if (this.socialIntent) return []; // social: the fixed line was already spoken; model text is discarded
    if (this.headerState === "pending") {
      const lead = this.raw.trimStart();
      if (lead.length > 0 && !lead.startsWith("[")) return this.invalidate("text before header");
      if (lead.length > 1 && !lead.startsWith("[[")) return this.invalidate("text before header");
      const close = this.raw.indexOf("]]");
      if (close < 0) {
        if (this.raw.length > this.windowChars) return this.invalidate(`no header within ${this.windowChars} characters`);
        return [];
      }
      const header = parseHeader(this.raw, this.windowChars);
      if (!header) return this.invalidate("malformed or late header");
      const verdict = validateHeader(header, this.retrievedIds, this.evidence?.tools);
      if (!verdict.ok) return this.invalidate(verdict.reason);
      this.headerState = "valid";
      this.verdict = verdict;
      if (header.type === "social") {
        // Speak the backend's fixed line now; never speak (or even keep) the model's own words.
        this.socialIntent = header.intent!;
        const line = socialLine(header.intent!);
        this.spokenInMessage.push(line);
        return [line];
      }
      if (this.evidence) {
        const records = this.evidence.tools?.records() ?? [];
        const options = filterOptionsFor(header.type, records);
        const cited = verdict.validKbIds.map((id) => this.evidence!.chunks.get(id) ?? "");
        if (options) this.filter = new SentenceFilter(cited, this.evidence.callerText, options);
      }
      this.body = header.rest;
    } else {
      this.body += delta;
    }
    return this.drain(false);
  }

  /** A tool_use block started in this message: stop its output immediately. */
  toolUse(): { violation: boolean; spokenBeforeToolUse: string[] } {
    this.stoppedByTool = true;
    return { violation: this.spokenInMessage.length > 0, spokenBeforeToolUse: [...this.spokenInMessage] };
  }

  end(stopReason: string | null): MessageOutcome {
    const terminal = stopReason === "end_turn" || stopReason === "max_tokens" || stopReason === "stop_sequence";
    if (this.stoppedByTool || !terminal) {
      return { kind: "discarded", raw: this.raw.trim(), spokenBeforeToolUse: [...this.spokenInMessage] };
    }
    if (this.headerState === "pending") {
      const header = parseHeader(this.raw, this.windowChars);
      if (!header) return { kind: "blocked", reason: "missing, malformed or late header", raw: this.raw.trim() };
    }
    if (this.headerState !== "valid" || !this.verdict) {
      return { kind: "blocked", reason: this.invalidReason || "missing, malformed or late header", raw: this.raw.trim() };
    }
    const speak = this.socialIntent ? [] : this.drain(true);
    if (this.spokenInMessage.length === 0) {
      const reason = this.filteredInMessage ? `every sentence dropped by the grounding filter (${this.filteredInMessage})` : "empty reply after header";
      return { kind: "blocked", reason, raw: this.raw.trim() };
    }
    return { kind: "final", type: this.verdict.type, validKbIds: this.verdict.validKbIds, unknownKbIds: this.verdict.unknownKbIds, tool: this.verdict.tool, speak };
  }

  private invalidate(reason: string): string[] {
    this.headerState = "invalid";
    this.invalidReason = reason;
    return [];
  }

  private allowed(sentence: string): boolean {
    if (!this.filter) return true;
    const t0 = performance.now();
    const flags = this.filter.check(sentence);
    const ms = performance.now() - t0;
    this.filterStats.sentences++;
    this.filterStats.totalMs += ms;
    this.filterStats.maxMs = Math.max(this.filterStats.maxMs, ms);
    if (!flags.length) return true;
    this.filtered.push({ sentence, flags });
    this.filteredInMessage++;
    return false;
  }

  /** Emits complete sentences from the body (all of it when the message has ended). */
  private drain(final: boolean): string[] {
    const out: string[] = [];
    for (;;) {
      const m = /[.!?]+["')\]]*\s/.exec(this.body);
      if (!m) break;
      const cut = m.index + m[0].length;
      const sentence = stripForSpeech(this.body.slice(0, cut));
      this.body = this.body.slice(cut);
      if (sentence && this.allowed(sentence)) out.push(sentence);
    }
    if (final) {
      const rest = stripForSpeech(this.body);
      this.body = "";
      if (rest && this.allowed(rest)) out.push(rest);
    }
    this.spokenInMessage.push(...out);
    return out;
  }
}
