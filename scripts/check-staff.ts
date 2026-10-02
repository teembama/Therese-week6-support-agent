// Live read-only check of the staff dashboard API (L2, D87) on the deployed service.
// Sessions come from the Supabase admin API (magic-link token verified server-side); no passwords.
//   npx tsx scripts/check-staff.ts [--base-url URL]
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServiceClient } from "@relaypay/shared";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
process.loadEnvFile(resolve(REPO, ".env"));
const i = process.argv.indexOf("--base-url");
const BASE = (i >= 0 ? process.argv[i + 1]! : "https://relaypay-backend-production-aa34.up.railway.app").replace(/\/$/, "");
const db = createServiceClient();
let pass = 0, fail = 0;
const check = (ok: boolean, label: string, detail = "") => { ok ? pass++ : fail++; console.log(`${ok ? "PASS" : "FAIL"}  ${label}${!ok && detail ? `\n      ${detail}` : ""}`); };

async function token(email: string): Promise<string> {
  const { data, error } = await db.auth.admin.generateLink({ type: "magiclink", email });
  if (error) throw error;
  const r = await fetch(`${process.env["SUPABASE_URL"]}/auth/v1/verify`, { method: "POST", headers: { apikey: process.env["SUPABASE_SERVICE_ROLE_KEY"]!, "Content-Type": "application/json" }, body: JSON.stringify({ type: "magiclink", token_hash: data.properties.hashed_token }) });
  return ((await r.json()) as { access_token: string }).access_token;
}
const get = (path: string, t?: string) => fetch(`${BASE}${path}`, { headers: t ? { Authorization: `Bearer ${t}` } : {} });

const staff = await token("care@relaypay.example");
const customer = await token("customer@relaypay.example");
check((await get("/staff")).status === 200, "/staff page served (flag on)");
check((await get("/staff/records?type=tickets")).status === 401, "no token -> 401");
check((await get("/staff/records?type=tickets", customer)).status === 403, "customer session -> 403");
check((await get("/staff/records?type=bogus", staff)).status === 400, "bad type -> 400");
for (const type of ["tickets", "callbacks"]) {
  for (const inc of ["", "&include_test=1"]) {
    const r = await get(`/staff/records?type=${type}${inc}`, staff);
    const body = (await r.json()) as { records: Array<Record<string, unknown>> };
    const text = JSON.stringify(body);
    const keys = [...new Set(body.records.flatMap((x) => Object.keys(x)))].sort().join(",");
    check(r.status === 200 && r.headers.get("cache-control") === "no-store", `staff ${type}${inc}: 200, ${body.records.length} records [${keys}]`);
    check(!/support_notes|"amount"|"currency"/.test(text), `staff ${type}${inc}: no notes or amounts`);
    if (!inc) check(body.records.every((x) => x["channel"] !== "test"), `staff ${type}: no test conversations by default`);
    if (type === "callbacks") check(body.records.every((x) => typeof x["preferred_time_text"] === "string"), `staff callbacks${inc}: every callback has a time`);
  }
}
// D98: Close. --close-ticket TKT-…: a TEST ticket, reopened here, then closed by staff.
const ci = process.argv.indexOf("--close-ticket");
if (ci >= 0) {
  const id = process.argv[ci + 1]!;
  const post = (t: string | undefined, body: object) => fetch(`${BASE}/staff/records/close`, { method: "POST", headers: { "Content-Type": "application/json", ...(t ? { Authorization: `Bearer ${t}` } : {}) }, body: JSON.stringify(body) });
  await db.from("support_tickets").update({ status: "open" }).eq("ticket_id", id);
  check((await post(undefined, { type: "ticket", id })).status === 401, "close: no token -> 401");
  check((await post(customer, { type: "ticket", id })).status === 403, "close: customer session -> 403");
  const { data: still } = await db.from("support_tickets").select("status").eq("ticket_id", id).single();
  check(still?.status === "open", "close: refused attempts change nothing");
  const r = await post(staff, { type: "ticket", id });
  const body = (await r.json()) as { closed?: boolean; closed_by?: string; closed_at?: string };
  check(r.status === 200 && body.closed === true && body.closed_by === "care@relaypay.example", `close: staff -> 200 closed by ${body.closed_by} at ${body.closed_at}`);
  const { data: after } = await db.from("support_tickets").select("status").eq("ticket_id", id).single();
  check(after?.status === "closed", "close: the ticket is closed");
  const { data: ev } = await db.from("conversation_events").select("summary").like("summary", `${id} closed by staff%`);
  check((ev ?? []).length >= 1, "close: an event row records who and when", JSON.stringify(ev));
  check((await post(staff, { type: "escalation", id: "ESC-00000000" })).status === 404, "close: unknown escalation -> 404");
  check((await post(staff, { type: "escalation", id })).status === 400, "close: an ID of the wrong type -> 400");
}
console.log(`\nPASS ${pass}  FAIL ${fail}`);
process.exit(fail ? 1 : 0);
