// The grounding gate. Pure functions and a small state machine, no I/O, so it is unit-tested
// with fixture outputs (gate.test.ts).
//
// Rules:
// - Nothing is spoken until a valid header [[type=answer|clarify|decline; kb=<ids|none>]] has
//   been parsed at the start of the reply, complete within HEADER_WINDOW_CHARS.
// - type=answer needs at least one cited kb id that is in this turn's retrieved set.
// - Anything else is blocked: the caller hears SAFE_DECLINE_LINE and the turn is answer_type
//   'blocked'.
// - The header, markup and stray markdown are stripped before speaking.
//
// Multi-step turns (SegmentTracker): the agent may emit text before or between tool calls.
// Each assistant API message is a segment. A segment is only eligible to be spoken once it has
// ENDED without any tool_use block (stop_reason end_turn / max_tokens / stop_sequence). A
// segment containing a tool_use is "thinking aloud" and is discarded, header or not. So no
// text is spoken unless it belongs to the turn's final segment, and that segment still has to
// pass the header check. The cost: the final reply is released only when its message ends.

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

export type GateVerdict =
  | { ok: true; type: ReplyType; spoken: string; citedKbIds: string[]; validKbIds: string[]; unknownKbIds: string[] }
  | { ok: false; reason: string };

/** Checks a complete final reply against the turn's retrieved chunk ids. */
export function evaluateReply(text: string, retrievedIds: ReadonlySet<string>): GateVerdict {
  const header = parseHeader(text);
  if (!header) return { ok: false, reason: "missing, malformed or late header" };
  const spoken = stripForSpeech(header.rest);
  if (!spoken) return { ok: false, reason: "empty reply after header" };
  const validKbIds = header.kbIds.filter((id) => retrievedIds.has(id));
  const unknownKbIds = header.kbIds.filter((id) => !retrievedIds.has(id));
  if (header.type === "answer") {
    if (header.kbIds.length === 0) return { ok: false, reason: "type=answer with kb=none" };
    if (validKbIds.length === 0) return { ok: false, reason: `type=answer cites no retrieved chunk (cited: ${header.kbIds.join(",")})` };
  }
  return { ok: true, type: header.type, spoken, citedKbIds: header.kbIds, validKbIds, unknownKbIds };
}

/** Splits spoken text into sentence-sized pieces for streaming to TTS. */
export function sentences(text: string): string[] {
  return text.split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter(Boolean);
}

export interface FinishedSegment {
  text: string;
  hadToolUse: boolean;
  stopReason: string | null;
}

/**
 * Tracks the main agent's assistant messages from the SDK's raw stream events. finish()
 * returns the completed segment at message_stop; only a segment with hadToolUse=false and a
 * terminal stop reason may be spoken.
 */
export class SegmentTracker {
  private text = "";
  private hadToolUse = false;
  private stopReason: string | null = null;
  readonly discarded: string[] = [];

  start(): void {
    this.text = "";
    this.hadToolUse = false;
    this.stopReason = null;
  }

  textDelta(delta: string): void {
    this.text += delta;
  }

  toolUseStart(): void {
    this.hadToolUse = true;
  }

  messageDelta(stopReason: string | null | undefined): void {
    if (stopReason) this.stopReason = stopReason;
  }

  /** Ends the current message. Returns it if it is speakable, else records it as discarded. */
  finish(): FinishedSegment | null {
    const seg: FinishedSegment = { text: this.text, hadToolUse: this.hadToolUse, stopReason: this.stopReason };
    this.start();
    const terminal = seg.stopReason === "end_turn" || seg.stopReason === "max_tokens" || seg.stopReason === "stop_sequence";
    if (seg.hadToolUse || !terminal) {
      if (seg.text.trim()) this.discarded.push(seg.text.trim());
      return null;
    }
    return seg;
  }
}
