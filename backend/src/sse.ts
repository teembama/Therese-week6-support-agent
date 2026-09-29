// OpenAI-format chat.completion.chunk SSE, as Vapi's Custom LLM mode expects:
// role delta, content deltas, a finish_reason "stop" chunk, then [DONE].

import { randomUUID } from "node:crypto";
import type { ServerResponse } from "node:http";

export type TurnSource = "agent" | "replay" | "inflight";

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

  content(text: string): void {
    if (!this.isEnded && text) this.chunk({ content: text }, null);
  }

  finish(): void {
    if (this.isEnded) return;
    this.chunk({}, "stop");
    this.res.write("data: [DONE]\n\n");
    this.res.end();
    this.ended = true;
  }
}
