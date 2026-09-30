import { redact } from "@relaypay/shared";
import * as z from "zod";
import { withWriteToolLogging, type ToolOutcome } from "../tool-logging.js";
import { logEvent, parseArgs } from "./common.js";

export const name = "log_conversation_event";

export const description =
  "Record an important decision you made in this conversation: a clarification you asked for, a " +
  "question you declined because it is not supported, a lookup, or something else worth " +
  "auditing. Keep the summary short and factual. Identity, ticket and escalation events are " +
  "recorded automatically by those tools.";

// The tools record identity, ticket and escalation events themselves (and the backend records
// gate blocks), so the model can't write those types: an audit trail the model could fake
// ("identity_verified") would be worthless (D39).
export const MODEL_EVENT_TYPES = ["clarification_requested", "declined_unsupported", "lookup_performed", "other"] as const;
export const SUMMARY_MAX_CHARS = 300;
export const METADATA_MAX_BYTES = 2048;

export const inputSchema = z.object({
  event_type: z.enum(MODEL_EVENT_TYPES).describe("What kind of decision this was."),
  summary: z.string().trim().min(1).max(2000).describe(`A short factual summary (stored up to ${SUMMARY_MAX_CHARS} characters).`),
  // Flat scalar values only: enough for IDs, flags and counts, and no nested structure to hide data in.
  metadata: z
    .record(z.string().max(60), z.union([z.string().max(200), z.number(), z.boolean(), z.null()]))
    .optional()
    .describe(`Optional small flat object of details: string, number, boolean or null values (at most ${METADATA_MAX_BYTES} bytes).`),
});

export const handler = withWriteToolLogging(name, "Record an agent decision in conversation_events", async (args, { db, ctx }): Promise<ToolOutcome> => {
  const parsed = parseArgs(inputSchema, args, `event_type must be one of ${MODEL_EVENT_TYPES.join(", ")}; summary is required.`);
  if (!parsed.ok) return parsed.outcome;
  const { event_type, metadata } = parsed.data;
  const summary = parsed.data.summary.length > SUMMARY_MAX_CHARS ? `${parsed.data.summary.slice(0, SUMMARY_MAX_CHARS - 1)}…` : parsed.data.summary;
  const safeMetadata = (redact(metadata ?? {}) ?? {}) as Record<string, unknown>;
  const bytes = Buffer.byteLength(JSON.stringify(safeMetadata), "utf8");
  if (bytes > METADATA_MAX_BYTES) {
    return {
      status: "invalid_input",
      result: { error: { code: "invalid_input", message: `metadata is ${bytes} bytes; the limit is ${METADATA_MAX_BYTES}. Nothing was written.` } },
      resultSummary: `invalid_input: metadata ${bytes} bytes`,
    };
  }
  const eventId = await logEvent(db, ctx, event_type, String(redact(summary)), safeMetadata);
  return { status: "success", result: { logged: true, event_id: eventId }, resultSummary: `logged ${event_type} #${eventId}` };
});
