// Voice page "Your references" panel logic (D84). The module is the browser file
// backend/public/records.js, loaded by URL; the markup is read from index.html.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const publicDir = resolve(dirname(fileURLToPath(import.meta.url)), "..", "public");
type Entry = { kind: "ticket" | "escalation"; reference: string; category?: string; followUp?: string; linkedTicket?: string; preference?: string | null };
interface Panel {
  POLL_MS: number;
  mergeRecords(entries: Entry[], response: unknown): { entries: Entry[]; added: Entry[] };
  copyText(entry: Entry): string;
  describeEntry(entry: Entry): { title: string; detail: string };
  announcement(added: Entry[]): string;
  recordsUrl(callId: string): string;
}
const p = (await import(pathToFileURL(resolve(publicDir, "records.js")).href)) as Panel;

const FOLLOW = "A RelayPay support representative will follow up.";
const response = {
  tickets: [{ reference: "TKT-0042", category: "Payout", follow_up: FOLLOW }],
  escalations: [{ reference: "ESC-1A2B3C4D", linked_ticket: "TKT-0043", callback_preference: "tomorrow morning" }],
};

describe("references panel (D84)", () => {
  it("merges new references once, in order, and reports which are new", () => {
    const first = p.mergeRecords([], { tickets: response.tickets, escalations: [] });
    assert.deepEqual(first.added.map((e) => e.reference), ["TKT-0042"]);
    const second = p.mergeRecords(first.entries, response);
    assert.deepEqual(second.entries.map((e) => e.reference), ["TKT-0042", "ESC-1A2B3C4D"]);
    assert.deepEqual(second.added.map((e) => e.reference), ["ESC-1A2B3C4D"]);
    const again = p.mergeRecords(second.entries, response);
    assert.equal(again.added.length, 0);
    assert.equal(again.entries, second.entries); // unchanged: no re-render
  });
  it("an empty or malformed response adds nothing (the panel stays hidden)", () => {
    for (const r of [{ tickets: [], escalations: [] }, null, { tickets: "x" }, { tickets: [{ reference: 5 }] }]) {
      assert.equal(p.mergeRecords([], r).added.length, 0);
    }
  });
  it("copy text: ticket exactly as specified; escalation with its linked ticket and preference", () => {
    const [ticket, esc] = p.mergeRecords([], response).entries;
    assert.equal(p.copyText(ticket!), `RelayPay ticket TKT-0042: Payout. ${FOLLOW}`);
    assert.equal(p.copyText(esc!), `RelayPay escalation ESC-1A2B3C4D (ticket TKT-0043). Callback preference: "tomorrow morning". ${FOLLOW}`);
    const noTime = p.mergeRecords([], { escalations: [{ ...response.escalations[0], callback_preference: null }] }).entries[0]!;
    assert.equal(p.copyText(noTime), `RelayPay escalation ESC-1A2B3C4D (ticket TKT-0043). ${FOLLOW}`);
  });
  it("visible lines and the aria-live announcement", () => {
    const { entries } = p.mergeRecords([], response);
    assert.deepEqual(p.describeEntry(entries[0]!), { title: "Ticket TKT-0042", detail: `Payout. ${FOLLOW}` });
    assert.equal(p.describeEntry(entries[1]!).title, "Escalation ESC-1A2B3C4D");
    assert.equal(p.announcement(entries), "New reference: ticket TKT-0042, escalation ESC-1A2B3C4D.");
    assert.equal(p.announcement([]), "");
  });
  it("polls every 3s; the URL path-encodes the call ID", () => {
    assert.equal(p.POLL_MS, 3000);
    assert.equal(p.recordsUrl("a/b c"), "/calls/a%2Fb%20c/records");
  });
  it("markup: hidden until the first record, an aria-live region, and a heading", () => {
    const html = readFileSync(resolve(publicDir, "index.html"), "utf8");
    assert.match(html, /<section id="records"[^>]*aria-labelledby="records-title"[^>]*hidden>/);
    assert.match(html, /<h2 id="records-title">Your references<\/h2>/);
    assert.match(html, /id="records-live"[^>]*aria-live="polite"/);
  });
});
