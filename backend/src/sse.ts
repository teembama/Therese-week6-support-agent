// OpenAI-format chat.completion.chunk SSE, as Vapi's Custom LLM mode expects:
// role delta, content deltas, a finish_reason "stop" chunk, then [DONE].

import { randomUUID } from "node:crypto";
import type { ServerResponse } from "node:http";

export type TurnSource = "agent" | "replay" | "inflight" | "fallback";

/** The stream opened on each response, so a last-resort error path can finish it (D34). */
const streams = new WeakMap<ServerResponse, SseStream>();

export class SseStream {
  private readonly id = `chatcmpl-${randomUUID()}`;
  private readonly created = Math.floor(Date.now() / 1000);
  private ended = false;

  constructor(private readonly res: ServerResponse, private readonly model: string, source: TurnSource) {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-RelayPay-Turn-Source": source,
    });
    this.chunk({ role: "assistant" }, null);
    streams.set(res, this);
  }

  /** The stream already opened on this response, if any. */
  static of(res: ServerResponse): SseStream | undefined {
    return streams.get(res);
  }

  /** True once any spoken text has been streamed. */
  get hasContent(): boolean {
    return this.sentContent;
  }

  get isEnded(): boolean {
    return this.ended || this.res.writableEnded || this.res.destroyed;
  }

  private chunk(delta: Record<string, unknown>, finishReason: string | null): void {
    const payload = {
      id: this.id,
      object: "chat.completion.chunk",
      created: this.created,
      model: this.model,
      choices: [{ index: 0, delta, finish_reason: finishReason }],
    };
    this.res.write(`data: ${JSON.stringify(payload)}\n\n`);
  }

  private sentContent = false;

  /**
   * Streams one piece of spoken text. Pieces are sentences, so a separating space is added
   * between them: content deltas are concatenated verbatim by the client, so without it the
   * assistant's transcript would read "…you with.Is there anything else…".
   */
  content(text: string): void {
    if (this.isEnded || !text) return;
    const piece = this.sentContent && !/^\s/.test(text) ? ` ${text}` : text;
    this.chunk({ content: piece }, null);
    this.sentContent = true;
  }

  finish(): void {
    if (this.isEnded) return;
    this.chunk({}, "stop");
    this.res.write("data: [DONE]\n\n");
    this.res.end();
    this.ended = true;
  }
}
