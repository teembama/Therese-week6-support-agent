// L1b call paths (D88): the page module (backend/public/call-path.js), the backend's name + email
// matching, and POST /calls/pass for the customer and guest paths.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, it } from "node:test";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Db } from "@relaypay/shared";
import { firstNameOf, handleCallPass, matchFormCustomer, NO_MATCH_MESSAGE, sha256Hex } from "./login.js";

const publicDir = resolve(dirname(fileURLToPath(import.meta.url)), "..", "public");
interface Page {
  NO_MATCH_MESSAGE: string;
  GUEST_NUDGE: string;
  passRequest(path: string | null, name: string, email: string): { ok: boolean; body?: unknown; message?: string };
  passResult(status: number, body: unknown): { kind: string; pass?: string; firstName?: string | null; message?: string };
  greeting(firstName: string | null): string | null;
  callOverrides(pass: string, firstName: string | null): Record<string, unknown>;
  shouldNudge(path: string | null, identityChecked: unknown): boolean;
}
const page = (await import(pathToFileURL(resolve(publicDir, "call-path.js")).href)) as Page;

const CUSTOMERS = [
  { customer_id: "CUS-1001", contact_name: "Amara Okafor", contact_email: "amara@lagosledger.example" },
  { customer_id: "CUS-1002", contact_name: "Daniel Mwangi", contact_email: "daniel@nairobiops.example" },
];

describe("name + email matching (D88)", () => {
  it("BOTH must match the same customer: full name or first name; case and spacing ignored", () => {
    assert.equal(matchFormCustomer(CUSTOMERS, "Amara Okafor", "amara@lagosledger.example")?.customer_id, "CUS-1001");
    assert.equal(matchFormCustomer(CUSTOMERS, "  amara  ", "  AMARA@LagosLedger.EXAMPLE ")?.customer_id, "CUS-1001");
    assert.equal(matchFormCustomer(CUSTOMERS, "AMARA   okafor", "amara@lagosledger.example")?.customer_id, "CUS-1001");
  });
  it("no match: wrong email, wrong name, the surname alone, another customer's name, unknown customer, empty", () => {
    assert.equal(matchFormCustomer(CUSTOMERS, "Amara", "amara@wrong.example"), null);
    assert.equal(matchFormCustomer(CUSTOMERS, "Felicia", "amara@lagosledger.example"), null);
    assert.equal(matchFormCustomer(CUSTOMERS, "Okafor", "amara@lagosledger.example"), null);
    assert.equal(matchFormCustomer(CUSTOMERS, "Daniel", "amara@lagosledger.example"), null);
    assert.equal(matchFormCustomer(CUSTOMERS, "Nobody", "nobody@nowhere.example"), null);
    assert.equal(matchFormCustomer(CUSTOMERS, "", ""), null);
  });
  it("first name for the greeting", () => {
    assert.equal(firstNameOf("Amara Okafor"), "Amara");
    assert.equal(firstNameOf("  Efúa  Mensah"), "Efúa");
  });
});

describe("POST /calls/pass: customer and guest paths (D88)", () => {
  async function serve(allow = () => true) {
    const inserted: Array<Record<string, unknown>> = [];
    const logs: Array<Record<string, unknown>> = [];
    const db = {
      from: (table: string) => ({
        select: () => ({ limit: async () => ({ data: table === "customers" ? CUSTOMERS : [], error: null }) }),
        insert: async (row: Record<string, unknown>) => { inserted.push(row); return { error: null }; },
      }),
    } as unknown as Db;
    const server: Server = createServer((req, res) => void handleCallPass(req, res, db, { allow, log: (e) => logs.push(e), headers: {} }));
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const post = (body: unknown) => fetch(`${base}/calls/pass`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    return { server, post, inserted, logs };
  }
  it("matched: 200 with a pass and the first name; the stored pass carries the customer (source form_customer)", async () => {
    const s = await serve();
    try {
      const r = await s.post({ mode: "customer", name: "amara", email: "Amara@LagosLedger.example" });
      const body = (await r.json()) as { pass: string; firstName: string };
      assert.equal(r.status, 200);
      assert.equal(body.firstName, "Amara");
      assert.deepEqual(s.inserted, [{ pass_hash: sha256Hex(body.pass), source: "form_customer", customer_id: "CUS-1001" }]);
      assert.ok(!JSON.stringify(s.logs).includes("amara") && !JSON.stringify(s.logs).includes(body.pass));
    } finally {
      s.server.close();
    }
  });
  it("wrong email, wrong name and unknown customer: the SAME 422 body, and no pass stored", async () => {
    const s = await serve();
    try {
      const bodies = [];
      for (const b of [{ name: "Amara", email: "amara@wrong.example" }, { name: "Felicia", email: "amara@lagosledger.example" }, { name: "Nobody", email: "nobody@nowhere.example" }]) {
        const r = await s.post({ mode: "customer", ...b });
        bodies.push(`${r.status} ${await r.text()}`);
      }
      assert.equal(new Set(bodies).size, 1, bodies.join(" | "));
      assert.equal(bodies[0], `422 ${JSON.stringify({ error: "no_match", message: NO_MATCH_MESSAGE })}`);
      assert.equal(s.inserted.length, 0);
    } finally {
      s.server.close();
    }
  });
  it("guest: 200 with a pass and no customer (source guest); a bad mode: 400; rate-limited: 429", async () => {
    const s = await serve();
    const limited = await serve(() => false);
    try {
      const r = await s.post({ mode: "guest" });
      const body = (await r.json()) as { pass: string; firstName?: string };
      assert.equal(r.status, 200);
      assert.equal(body.firstName, undefined);
      assert.deepEqual(s.inserted, [{ pass_hash: sha256Hex(body.pass), source: "guest" }]);
      assert.equal((await s.post({ mode: "admin" })).status, 400);
      assert.equal((await limited.post({ mode: "guest" })).status, 429);
      assert.equal(limited.inserted.length, 0);
    } finally {
      s.server.close();
      limited.server.close();
    }
  });
});

describe("call page paths (D88)", () => {
  it("request bodies: guest; customer with name and email; missing or invalid fields stay on the page", () => {
    assert.deepEqual(page.passRequest("guest", "", ""), { ok: true, body: { mode: "guest" } });
    assert.deepEqual(page.passRequest("customer", " Amara ", " amara@lagosledger.example "), { ok: true, body: { mode: "customer", name: "Amara", email: "amara@lagosledger.example" } });
    assert.equal(page.passRequest("customer", "", "a@b.co").ok, false);
    assert.equal(page.passRequest("customer", "Amara", "not-an-email").ok, false);
    assert.equal(page.passRequest(null, "", "").ok, false);
  });
  it("responses: ok with the first name; 422 -> the generic no-match message (no call); errors", () => {
    assert.deepEqual(page.passResult(200, { pass: "P", firstName: "Amara" }), { kind: "ok", pass: "P", firstName: "Amara" });
    assert.deepEqual(page.passResult(200, { pass: "P" }), { kind: "ok", pass: "P", firstName: null });
    assert.deepEqual(page.passResult(200, { pass: "P", firstName: "<b>x</b>" }), { kind: "ok", pass: "P", firstName: null });
    assert.deepEqual(page.passResult(422, {}), { kind: "no_match", message: "We couldn't find an account matching those details." });
    assert.equal(page.NO_MATCH_MESSAGE, NO_MATCH_MESSAGE);
    assert.equal(page.passResult(429, {}).kind, "error");
    assert.equal(page.passResult(0, null).kind, "error");
  });
  it("greeting: a matched customer by first name; guests keep the assistant's own greeting", () => {
    assert.deepEqual(page.callOverrides("P", "Amara"), { variableValues: { callPass: "P" }, firstMessage: "Hi Amara, this is RelayPay support. How can I help you today?" });
    assert.deepEqual(page.callOverrides("P", null), { variableValues: { callPass: "P" } });
  });
  it("guest nudge after the call: only a guest call whose identity was checked", () => {
    assert.equal(page.shouldNudge("guest", true), true);
    assert.equal(page.shouldNudge("guest", false), false);
    assert.equal(page.shouldNudge("customer", true), false);
    assert.equal(page.GUEST_NUDGE, "Existing customer? Choose 'I'm an existing customer' next time for a faster, more secure check.");
  });
  it("markup: two path buttons (aria-pressed), the name + email form, an alert for errors, the nudge region", () => {
    const html = readFileSync(resolve(publicDir, "index.html"), "utf8");
    assert.match(html, /id="path-customer"[^>]*aria-pressed="false"[^>]*>I'm an existing customer</);
    assert.match(html, /id="path-guest"[^>]*aria-pressed="false"[^>]*>Continue as a guest</);
    assert.match(html, /<label for="customer-name">Name<\/label>\s*<input id="customer-name"/);
    assert.match(html, /<label for="customer-email">Email<\/label>\s*<input id="customer-email"[^>]*type="email"/);
    assert.match(html, /id="customer-error"[^>]*role="alert"/);
    assert.match(html, /id="guest-nudge"[^>]*role="status"/);
  });
});
