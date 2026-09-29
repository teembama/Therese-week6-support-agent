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

import { HEADER_WINDOW_CHARS } from "./config.js";

export type ReplyType = "answer" | "clarify" | "decline";

export interface ParsedHeader {
  type: ReplyType;
  kbIds: string[];
  rest: string;
}

const HEADER_RE = /^\s*\[\[\s*type\s*=\s*(answer|clarify|decline)\s*;\s*kb\s*=\s*([^\]]*?)\s*\]\]/i;
const CHUNK_ID_RE = /^[a-z0-9-]+$/;

/** The header at the very start of the reply, or null if missing, malformed or too late. */
export function parseHeader(text: string, windowChars: number = HEADER_WINDOW_CHARS): ParsedHeader | null {
  const m = HEADER_RE.exec(text);
  if (!m || m[0].length > windowChars) return null;
  const type = m[1]!.toLowerCase() as ReplyType;
  const kbRaw = m[2]!.trim().toLowerCase();
  let kbIds: string[] = [];
  if (kbRaw !== "none" && kbRaw !== "") {
    kbIds = kbRaw.split(",").map((s) => s.trim()).filter(Boolean);
    if (!kbIds.every((id) => CHUNK_ID_RE.test(id))) return null;
  }
  return { type, kbIds, rest: text.slice(m[0].length) };
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
  | { ok: true; type: ReplyType; citedKbIds: string[]; validKbIds: string[]; unknownKbIds: string[] }
  | { ok: false; reason: string };

/** Checks a parsed header against the turn's retrieved chunk ids. */
export function validateHeader(header: ParsedHeader, retrievedIds: ReadonlySet<string>): HeaderVerdict {
  const validKbIds = header.kbIds.filter((id) => retrievedIds.has(id));
  const unknownKbIds = header.kbIds.filter((id) => !retrievedIds.has(id));
  if (header.type === "answer") {
    if (header.kbIds.length === 0) return { ok: false, reason: "type=answer with kb=none" };
    if (validKbIds.length === 0) return { ok: false, reason: `type=answer cites no retrieved chunk (cited: ${header.kbIds.join(",")})` };
  }
  return { ok: true, type: header.type, citedKbIds: header.kbIds, validKbIds, unknownKbIds };
}

export type GateVerdict =
  | { ok: true; type: ReplyType; spoken: string; citedKbIds: string[]; validKbIds: string[]; unknownKbIds: string[] }
  | { ok: false; reason: string };

/** Checks a complete reply (whole-message form of the gate; used for fixtures). */
export function evaluateReply(text: string, retrievedIds: ReadonlySet<string>): GateVerdict {
  const header = parseHeader(text);
  if (!header) return { ok: false, reason: "missing, malformed or late header" };
  const verdict = validateHeader(header, retrievedIds);
  if (!verdict.ok) return verdict;
  const spoken = stripForSpeech(header.rest);
  if (!spoken) return { ok: false, reason: "empty reply after header" };
  return { ...verdict, spoken };
}

/** Splits spoken text into sentence-sized pieces for streaming to TTS. */
export function sentences(text: string): string[] {
  return text.split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter(Boolean);
}

export type MessageOutcome =
  | { kind: "final"; type: ReplyType; validKbIds: string[]; unknownKbIds: string[]; speak: string[] }
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

  constructor(private readonly retrievedIds: ReadonlySet<string>, private readonly windowChars: number = HEADER_WINDOW_CHARS) {}

  start(): void {
    this.raw = "";
    this.headerState = "pending";
    this.invalidReason = "";
    this.body = "";
    this.spokenInMessage = [];
    this.stoppedByTool = false;
    this.verdict = null;
  }

  /** Sentences that became speakable with this delta (header already validated). */
  text(delta: string): string[] {
    this.raw += delta;
    if (this.stoppedByTool || this.headerState === "invalid") return [];
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
      const verdict = validateHeader(header, this.retrievedIds);
      if (!verdict.ok) return this.invalidate(verdict.reason);
      this.headerState = "valid";
      this.verdict = verdict;
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
    const speak = this.drain(true);
    if (this.spokenInMessage.length === 0) return { kind: "blocked", reason: "empty reply after header", raw: this.raw.trim() };
    return { kind: "final", type: this.verdict.type, validKbIds: this.verdict.validKbIds, unknownKbIds: this.verdict.unknownKbIds, speak };
  }

  private invalidate(reason: string): string[] {
    this.headerState = "invalid";
    this.invalidReason = reason;
    return [];
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
      if (sentence) out.push(sentence);
    }
    if (final) {
      const rest = stripForSpeech(this.body);
      this.body = "";
      if (rest) out.push(rest);
    }
    this.spokenInMessage.push(...out);
    return out;
  }
}
