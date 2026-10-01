// "Your references" panel for the voice page (D84). Pure functions, no DOM, so they are unit-tested
// (backend/src/records-panel.test.ts) and imported by app.js. Nothing is stored: the references live
// in page memory until reload.

export const POLL_MS = 3000;

/**
 * Merge a /calls/:id/records response into the panel's entries (keyed by reference; order kept,
 * new ones appended). Returns the new list and the entries that are new, for the announcement.
 * A malformed response changes nothing.
 */
export function mergeRecords(entries, response) {
  const known = new Set(entries.map((e) => e.reference));
  const incoming = [];
  for (const t of Array.isArray(response?.tickets) ? response.tickets : []) {
    if (typeof t?.reference === "string") incoming.push({ kind: "ticket", reference: t.reference, category: String(t.category ?? "Other"), followUp: String(t.follow_up ?? "") });
  }
  for (const e of Array.isArray(response?.escalations) ? response.escalations : []) {
    if (typeof e?.reference === "string") incoming.push({ kind: "escalation", reference: e.reference, linkedTicket: String(e.linked_ticket ?? ""), preference: typeof e.callback_preference === "string" ? e.callback_preference : null });
  }
  const added = incoming.filter((e) => !known.has(e.reference) && known.add(e.reference));
  return { entries: added.length ? [...entries, ...added] : entries, added };
}

/** What the Copy button puts on the clipboard. */
export function copyText(entry) {
  if (entry.kind === "ticket") return `RelayPay ticket ${entry.reference}: ${entry.category}. ${entry.followUp || "A RelayPay support representative will follow up."}`;
  const pref = entry.preference ? ` Callback preference: "${entry.preference}".` : "";
  return `RelayPay escalation ${entry.reference} (ticket ${entry.linkedTicket}).${pref} A RelayPay support representative will follow up.`;
}

/** The entry's visible lines: a title and a detail line. */
export function describeEntry(entry) {
  if (entry.kind === "ticket") return { title: `Ticket ${entry.reference}`, detail: `${entry.category}. ${entry.followUp}` };
  return {
    title: `Escalation ${entry.reference}`,
    detail: `Linked ticket ${entry.linkedTicket}. ${entry.preference ? `Callback preference: “${entry.preference}”.` : "No callback time given."}`,
  };
}

/** The aria-live announcement for newly added references ("" when nothing is new). */
export function announcement(added) {
  if (!added.length) return "";
  const names = added.map((e) => `${e.kind === "ticket" ? "ticket" : "escalation"} ${e.reference}`);
  return `New reference: ${names.join(", ")}.`;
}

/** The records URL for a call (the ID is path-encoded). */
export function recordsUrl(callId) {
  return `/calls/${encodeURIComponent(callId)}/records`;
}
