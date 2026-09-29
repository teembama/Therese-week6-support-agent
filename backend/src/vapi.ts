// Parses the Custom LLM request body Vapi sends to /chat/completions.

import * as z from "zod";
import type { HistoryEntry } from "./prompt.js";

const ContentSchema = z.union([
  z.string(),
  z.array(z.object({ type: z.string(), text: z.string().optional() }).passthrough()),
  z.null(),
]);

const VapiBodySchema = z
  .object({
    model: z.string().optional(),
    messages: z.array(z.object({ role: z.string(), content: ContentSchema.optional() }).passthrough()),
    call: z
      .object({
        id: z.string().min(1).max(200),
        customer: z.object({ number: z.string().optional() }).passthrough().optional(),
      })
      .passthrough(),
  })
  .passthrough();

export interface VapiTurn {
  model: string;
  callId: string;
  caller: string | null;
  /** 0-based: number of user messages minus 1. Deterministic, so a retry gets the same index. */
  turnIndex: number;
  userText: string;
  /** Prior turns only; Vapi's system message is dropped (the backend owns the prompt). */
  history: HistoryEntry[];
}

export type ParseResult = { ok: true; turn: VapiTurn } | { ok: false; error: string };

function textOf(content: z.infer<typeof ContentSchema> | undefined): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((p) => p.text ?? "").join(" ");
  return "";
}

export function parseVapiBody(body: unknown): ParseResult {
  const parsed = VapiBodySchema.safeParse(body);
  if (!parsed.success) {
    const missingCall = parsed.error.issues.some((i) => i.path[0] === "call");
    return { ok: false, error: missingCall ? "call.id is required" : "invalid request body" };
  }
  const { messages, call, model } = parsed.data;

  const dialogue = messages
    .filter((m) => m.role === "user" || m.role === "assistant")
    .map((m) => ({ role: m.role as "user" | "assistant", text: textOf(m.content).trim() }))
    .filter((m) => m.text !== "");
  const lastUser = dialogue.map((m) => m.role).lastIndexOf("user");
  if (lastUser < 0) return { ok: false, error: "no user message" };

  const userCount = messages.filter((m) => m.role === "user").length;
  return {
    ok: true,
    turn: {
      model: model ?? "relaypay-agent",
      callId: call.id,
      caller: call.customer?.number ?? null,
      turnIndex: userCount - 1,
      userText: dialogue[lastUser]!.text,
      history: dialogue.slice(0, lastUser).map((m) => ({ role: m.role === "user" ? "caller" : "agent", text: m.text })),
    },
  };
}
