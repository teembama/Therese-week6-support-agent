// Staff dashboard page logic and gating (L2, D87). The module is the browser file
// backend/public/staff-view.js, loaded by URL; the markup is read from staff.html.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, it } from "node:test";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { handlePublic, isPublicRoute, staffDashboardEnabled } from "./web.js";

const publicDir = resolve(dirname(fileURLToPath(import.meta.url)), "..", "public");
interface View {
  FILTERS: Array<{ type: string; label: string }>;
  STAFF_MESSAGES: Record<string, string>;
  recordsPath(type: string, includeTest?: boolean): string;
  recordsOutcome(status: number): { kind: string; message?: string };
  formatWhen(iso: string): string;
  cardFor(type: string, r: Record<string, unknown>): { title: string; badges: string[]; fields: Array<[string, string]> };
  emptyText(type: string): string;
  countText(type: string, n: number): string;
  badgeClass(text: string): string;
}
const v = (await import(pathToFileURL(resolve(publicDir, "staff-view.js")).href)) as View;

describe("staff dashboard view (D87)", () => {
  it("two filters: raised tickets and scheduled callbacks", () => {
    assert.deepEqual(v.FILTERS.map((f) => f.label), ["Raised tickets", "Scheduled callbacks"]);
    assert.equal(v.recordsPath("tickets"), "/staff/records?type=tickets");
    assert.equal(v.recordsPath("callbacks", true), "/staff/records?type=callbacks&include_test=1");
  });
  it("responses: 401 -> back to login (expired); 403 -> not staff; 429 / other -> clear errors", () => {
    assert.deepEqual(v.recordsOutcome(200), { kind: "ok" });
    assert.equal(v.recordsOutcome(401).kind, "relogin");
    assert.equal(v.recordsOutcome(403).message, "This account isn't staff. Log in with a RelayPay staff account.");
    assert.equal(v.recordsOutcome(429).message, v.STAFF_MESSAGES["rateLimited"]);
    assert.equal(v.recordsOutcome(500).message, v.STAFF_MESSAGES["unavailable"]);
  });
  it("ticket card: reference, category/priority/status badges, customer, summary, time in WAT", () => {
    const c = v.cardFor("tickets", { ticket_id: "TKT-1", category: "payout", priority: "high", status: "open", customer_id: null, summary: "Payout failed", created_at: "2026-10-02T10:05:00Z", channel: "voice" });
    assert.equal(c.title, "Ticket TKT-1");
    assert.deepEqual(c.badges, ["Payout", "High priority", "Open"]);
    assert.deepEqual(c.fields, [["Customer", "Not verified on the call"], ["Summary", "Payout failed"], ["Raised", "2 Oct, 11:05 WAT"]]);
  });
  it("callback card: preference, caller, email, linked ticket, reason; test conversations labelled", () => {
    const c = v.cardFor("callbacks", { escalation_id: "ESC-1", ticket_id: "TKT-2", category: "account", status: "open", customer_id: "CUS-1001", user_name: "Amara", user_email: "amara@lagosledger.example", preferred_time_text: "tomorrow morning", reason: "Restricted", created_at: "2026-10-02T10:05:00Z", channel: "test" });
    assert.equal(c.title, "Callback for escalation ESC-1");
    const f = Object.fromEntries(c.fields);
    assert.equal(f["Caller's preference"], "“tomorrow morning”");
    assert.equal(f["Caller email"], "amara@lagosledger.example");
    assert.equal(f["Linked ticket"], "TKT-2");
    assert.equal(f["Customer"], "CUS-1001");
    assert.equal(f["Source"], "Test conversation");
  });
  it("empty and count lines", () => {
    assert.equal(v.emptyText("tickets"), "No raised tickets yet.");
    assert.equal(v.emptyText("callbacks"), "No scheduled callbacks yet.");
    assert.equal(v.countText("callbacks", 3), "3 scheduled callbacks.");
    assert.equal(v.countText("tickets", 1), "1 raised ticket.");
    assert.equal(v.countText("tickets", 2), "2 raised tickets.");
    assert.equal(v.countText("callbacks", 1), "1 scheduled callback.");
    assert.equal(v.countText("callbacks", 0), "0 scheduled callbacks.");
    assert.equal(v.countText("tickets", 100), "100 raised tickets (latest 100).");
  });
  it("markup: labelled login, two aria-pressed filter buttons, refresh, a live status region", () => {
    const html = readFileSync(resolve(publicDir, "staff.html"), "utf8");
    assert.match(html, /<label for="login-email">Email<\/label>/);
    assert.equal((html.match(/class="filter-button"[^>]*aria-pressed=/g) ?? []).length, 2);
    assert.match(html, /id="refresh"/);
    assert.match(html, /id="records-status"[^>]*aria-live="polite"/);
  });
});

describe("staff dashboard gating (D87)", () => {
  function config(env: NodeJS.ProcessEnv): Record<string, unknown> {
    let body = "";
    const res = { writeHead: () => res, end: (b?: string) => { body = b ?? ""; } } as unknown as ServerResponse;
    handlePublic({ method: "GET" } as IncomingMessage, res, "/config", env);
    return JSON.parse(body) as Record<string, unknown>;
  }
  const base = { VAPI_PUBLIC_KEY: "pk", VAPI_ASSISTANT_ID: "aid", SUPABASE_URL: "https://abc.supabase.co", SUPABASE_PUBLISHABLE_KEY: "sb_publishable_x" };
  it("/config: the Auth settings only when the dashboard (or customer login) is on", () => {
    assert.deepEqual(config(base), { vapiPublicKey: "pk", vapiAssistantId: "aid", loginRequired: false, staffDashboard: false });
    const on = config({ ...base, STAFF_DASHBOARD_ENABLED: "1" });
    assert.deepEqual([on["staffDashboard"], on["loginRequired"], on["supabaseUrl"], on["supabasePublishableKey"]], [true, false, "https://abc.supabase.co", "sb_publishable_x"]);
  });
  it("/staff and its scripts are routes only while the flag is on", () => {
    const saved = process.env["STAFF_DASHBOARD_ENABLED"];
    try {
      delete process.env["STAFF_DASHBOARD_ENABLED"];
      assert.equal(staffDashboardEnabled(), false);
      assert.equal(isPublicRoute("GET", "/staff"), false);
      assert.equal(isPublicRoute("GET", "/staff.js"), false);
      process.env["STAFF_DASHBOARD_ENABLED"] = "1";
      assert.equal(isPublicRoute("GET", "/staff"), true);
      assert.equal(isPublicRoute("GET", "/staff-view.js"), true);
      assert.equal(isPublicRoute("GET", "/staff/records"), false); // the API is routed separately, with auth
    } finally {
      if (saved === undefined) delete process.env["STAFF_DASHBOARD_ENABLED"];
      else process.env["STAFF_DASHBOARD_ENABLED"] = saved;
    }
  });
});
