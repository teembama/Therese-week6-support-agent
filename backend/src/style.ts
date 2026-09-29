// Observability-only style check (never blocks, never changes what is spoken): reports
// implementation terms in customer-facing text so they show up in the turn log and evals.

import { STYLE_VIOLATION_TERMS } from "./config.js";

export function styleViolations(spoken: string): string[] {
  const lower = spoken.toLowerCase();
  return STYLE_VIOLATION_TERMS.filter((term) => new RegExp(`\\b${term}`, "i").test(lower));
}
