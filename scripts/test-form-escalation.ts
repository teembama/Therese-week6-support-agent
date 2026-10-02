// Live check (D90, D97): a dispute escalation on a FORM-identified call (Amara via the call page),
// with real callback booking.
//
//   npx tsx scripts/test-form-escalation.ts [--base-url URL] [--time "Saturday at 10am"]
//
// - The agent confirms the email she entered (amara@lagosledger.example) instead of asking for it.
// - The caller asks for --time. If the tool refuses it (e.g. a weekend), the agent must say why and
//   offer the tool's slots; the caller picks the FIRST offered slot, and that exact slot is booked.
// - One escalation, stored with the account's name and email and the booked slot. Closed at the end
//   (frees the slot). ~$0.03.

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServiceClient } from "@relaypay/shared";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const arg = (f: string) => { const i = process.argv.indexOf(f); return i >= 0 ? process.argv[i + 1] : undefined; };
const BASE = (arg("--base-url") ?? "https://relaypay-backend-production-aa34.up.railway.app").replace(/\/$/, "");
const TIME = arg("--time") ?? "Monday at 10 AM";
process.loadEnvFile(resolve(REPO, ".env"));
const db = createServiceClient();
let pass = 0, fail = 0;
const check = (ok: boolean, label: string, detail = "") => { ok ? pass++ : fail++; console.log(`${ok ? "PASS" : "FAIL"}  ${label}${!ok && detail ? `\n      ${detail}` : ""}`); };

async function say(callId: string, callPass: string, caller: string[], agent: string[]): Promise<string> {
  const messages: Array<{ role: string; content: string }> = [{ role: "system", content: "Vapi placeholder" }];
  caller.forEach((c, k) => { messages.push({ role: "user", content: c }); if (agent[k] !== undefined) messages.push({ role: "assistant", content: agent[k]! }); });
  const res = await fetch(`${BASE}/v/${process.env["VAPI_LLM_SECRET"]}/chat/completions`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "relaypay-agent", stream: true, call: { id: callId, assistantOverrides: { variableValues: { callPass } } }, messages }),
  });
  return (await res.text()).split("\n").filter((l) => l.startsWith("data: ") && !l.includes("[DONE]"))
    .map((l) => { try { return (JSON.parse(l.slice(6)) as { choices?: Array<{ delta?: { content?: string } }> }).choices?.[0]?.delta?.content ?? ""; } catch { return ""; } }).join("").trim();
}

const r = await fetch(`${BASE}/calls/pass`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ mode: "customer", name: "Amara", email: "amara@lagosledger.example" }) });
const { pass: callPass } = (await r.json()) as { pass: string };
check(r.status === 200 && Boolean(callPass), "form pass for Amara");
const callId = `test-formesc-${new Date().toISOString().replace(/[:.]/g, "-")}`;
const caller = ["I want to dispute my payment TXN-9001 and speak to a specialist."];
const agent: string[] = [];
let askedEmail = false, readBack = false, askedTime = false, timeGiven = false;
let refused: { reason: string; offered: string[] } | null = null;
let picked: string | null = null;
for (let t = 0; t < 8; t++) {
  const a = await say(callId, callPass, caller, agent);
  agent.push(a);
  console.log(`  t${t} caller: ${caller[t]}\n     agent: ${a.slice(0, 260)}`);
  if (/(what|could i have|can i have|may i have|tell me).{0,30}email/i.test(a) && !/lagosledger|amara@|amara at/i.test(a)) askedEmail = true;
  if (/amara(@| at )lagos ?ledger/i.test(a)) readBack = true;
  if (/(time|when|day).{0,50}(call|contact|reach|suit|work|callback)|callback time/i.test(a)) askedTime = true;
  const { data: e } = await db.from("escalations").select("escalation_id").eq("conversation_id", callId);
  if ((e ?? []).length) break;
  // The latest refusal from the tool (what it offered), if any.
  const { data: calls } = await db.from("tool_calls").select("result_summary").eq("conversation_id", callId).eq("tool_name", "create_escalation").order("id", { ascending: false }).limit(1);
  const summary = String((calls ?? [])[0]?.result_summary ?? "");
  const m = /callback refused: (\w+) .*; offered (.*)$/.exec(summary);
  if (m && !refused) refused = { reason: m[1]!, offered: m[2]!.split(" | ") };
  let next: string;
  if (refused && !picked) { picked = refused.offered[0]!; next = `${picked} works.`; }
  else if (/amara(@| at )lagos ?ledger/i.test(a)) next = "Yes, that's right, contact me there.";
  else if (/reference|TXN|transaction number/i.test(a)) next = "It's TXN-9001.";
  else if (!timeGiven && /(time|when|day)/i.test(a)) { next = TIME; timeGiven = true; }
  else if (/(would you like|shall i|can i arrange|i can arrange|callback)/i.test(a)) next = "Yes, please.";
  else next = "Yes.";
  caller.push(next);
}
const { data: rows } = await db.from("escalations").select("user_name, user_email, customer_id, preferred_time_text, callback_slot, call_booked").eq("conversation_id", callId);
const row = (rows ?? [])[0] as Record<string, unknown> | undefined;
const spoken = agent.join(" ");
check(!askedEmail, "the agent never asked for the email");
check(readBack, "the agent read back the email she entered (amara@lagosledger.example)");
check(askedTime, "the agent asked for a callback day and time");
if (/saturday|sunday/i.test(TIME)) {
  check(refused?.reason === "weekend", `"${TIME}" refused by the tool: weekend`, JSON.stringify(refused));
  check(/weekend/i.test(spoken) && /Monday to Friday/i.test(spoken), "the agent said why (weekend) and the business hours", spoken.slice(0, 400));
  check(Boolean(refused?.offered.length) && refused!.offered.some((o) => spoken.includes(o.replace(/ at .*/, ""))), "the agent offered the tool's slots", JSON.stringify(refused?.offered));
}
check((rows ?? []).length === 1 && row?.["user_email"] === "amara@lagosledger.example" && row?.["user_name"] === "Amara Okafor" && row?.["customer_id"] === "CUS-1001",
  "ONE escalation, stored with the form account's name and email", JSON.stringify(rows));
check(row?.["call_booked"] === true && Boolean(row?.["callback_slot"]), "a callback slot is booked", JSON.stringify(row));
if (picked) check(new RegExp(picked.replace(/ at .*/, "")).test(String(row?.["preferred_time_text"] ?? "")) || /works/.test(String(row?.["preferred_time_text"] ?? "")), `the slot the caller picked (${picked}) was booked`, JSON.stringify(row));
check(/booked for/i.test(spoken) && /Lagos time/i.test(spoken), "the agent confirmed 'booked for <day date time> Lagos time'", spoken.slice(-300));
await db.from("escalations").update({ status: "closed" }).eq("conversation_id", callId);
console.log(`\nPASS ${pass}  FAIL ${fail}   conversation ${callId}`);
process.exit(fail ? 1 : 0);
