// Live check (D90): a dispute escalation on a FORM-identified call (Amara via the call page).
// The agent should confirm the email she entered (amara@lagosledger.example) instead of asking for
// it, ask for a preferred time, and create ONE escalation stored with the account's name and email.
//
//   npx tsx scripts/test-form-escalation.ts [--base-url URL]
//
// Adaptive caller: replies to whatever the agent asks (read-back -> "Yes, that's right.", time ->
// "Tomorrow morning.", callback offer -> "Yes, please."), at most 6 turns. ~$0.03.

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServiceClient } from "@relaypay/shared";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const i = process.argv.indexOf("--base-url");
const BASE = (i >= 0 ? process.argv[i + 1]! : "https://relaypay-backend-production-aa34.up.railway.app").replace(/\/$/, "");
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
let askedEmail = false, readBack = false, askedTime = false;
for (let t = 0; t < 6; t++) {
  const a = await say(callId, callPass, caller, agent);
  agent.push(a);
  console.log(`  t${t} caller: ${caller[t]}\n     agent: ${a.slice(0, 220)}`);
  if (/(what|could i have|can i have|may i have|tell me).{0,30}email/i.test(a) && !/lagosledger|amara@|amara at/i.test(a)) askedEmail = true;
  if (/amara(@| at )lagos ?ledger/i.test(a)) readBack = true;
  if (/(time|when).{0,40}(call|contact|reach|suit|work)|preferred (callback )?time/i.test(a)) askedTime = true;
  const { data: e } = await db.from("escalations").select("escalation_id").eq("conversation_id", callId);
  if ((e ?? []).length) break;
  const next = /amara(@| at )lagos ?ledger/i.test(a) ? "Yes, that's right, contact me there."
    : /reference|TXN|transaction number/i.test(a) ? "It's TXN-9001."
    : /(time|when)/i.test(a) ? "Tomorrow morning."
    : /(would you like|shall i|can i arrange|i can arrange|callback)/i.test(a) ? "Yes, please."
    : "Yes.";
  caller.push(next);
}
const { data: rows } = await db.from("escalations").select("user_name, user_email, customer_id, preferred_time_text, call_booked, category").eq("conversation_id", callId);
check(!askedEmail, "the agent never asked for the email");
check(readBack, "the agent read back the email she entered (amara@lagosledger.example)");
check(askedTime, "the agent asked for a preferred callback time");
check((rows ?? []).length === 1 && rows![0]!.user_email === "amara@lagosledger.example" && rows![0]!.user_name === "Amara Okafor" && rows![0]!.customer_id === "CUS-1001",
  "ONE escalation, stored with the form account's name and email", JSON.stringify(rows));
console.log(`\nPASS ${pass}  FAIL ${fail}   conversation ${callId}`);
process.exit(fail ? 1 : 0);
