// Live check (D98) against the deployed backend. ~$0.05.
//
//   npx tsx scripts/test-d98-live.ts [--base-url URL]
//
// A. Guest lookup: TXN-9001 with no customer ID (asked for it), then a wrong ID (refused, nothing
//    about the record), then the owner's ID CUS-1001 (status returned).
// B. Form-identified escalation where the caller declines a callback time: a support ticket, the
//    agent says a specialist will review it, no escalation and no callback claimed.

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServiceClient } from "@relaypay/shared";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const arg = (f: string) => { const i = process.argv.indexOf(f); return i >= 0 ? process.argv[i + 1] : undefined; };
const BASE = (arg("--base-url") ?? "https://relaypay-backend-production-aa34.up.railway.app").replace(/\/$/, "");
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
async function passFor(body: object): Promise<string> {
  const r = await fetch(`${BASE}/calls/pass`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return ((await r.json()) as { pass: string }).pass;
}
const summaries = async (callId: string) => {
  const { data } = await db.from("tool_calls").select("tool_name, result_summary").eq("conversation_id", callId).order("id");
  return ((data ?? []) as Array<{ tool_name: string; result_summary: string | null }>).map((r) => `${r.tool_name}: ${r.result_summary ?? ""}`);
};
const stamp = () => new Date().toISOString().replace(/[:.]/g, "-");

// A. Guest lookup. (--only B skips it.)
if (arg("--only") !== "B") {
  console.log("== A. Guest lookup: no ID -> wrong ID -> right ID");
  const callPass = await passFor({ mode: "guest" });
  const callId = `test-d98-lookup-${stamp()}`;
  const caller = ["Can you check transaction TXN-9001?"], agent: string[] = [];
  agent.push(await say(callId, callPass, caller, agent));
  console.log(`  caller: ${caller[0]}\n  agent:  ${agent[0]}`);
  check(/customer id/i.test(agent[0]!) && !/processing/i.test(agent[0]!), "no ID: the agent asks for the customer ID and says nothing about the record", agent[0]);
  caller.push("My customer ID is CUS-1002.");
  agent.push(await say(callId, callPass, caller, agent));
  console.log(`  caller: ${caller[1]}\n  agent:  ${agent[1]}`);
  check(!/processing|delayed|completed/i.test(agent[1]!), "wrong ID: refused, no status given", agent[1]);
  check(!/customer id (is|was) (wrong|incorrect)|doesn't match|does not match the (transaction|reference)/i.test(agent[1]!) || /check both|reference and (your )?customer id|customer id and (the )?reference/i.test(agent[1]!), "wrong ID: the agent doesn't say which part was wrong", agent[1]);
  caller.push("Sorry, it's CUS-1001.");
  agent.push(await say(callId, callPass, caller, agent));
  console.log(`  caller: ${caller[2]}\n  agent:  ${agent[2]}`);
  check(/processing/i.test(agent[2]!), "right ID (CUS-1001): the status is given (processing)", agent[2]);
  const s = await summaries(callId);
  console.log(`  tool_calls: ${JSON.stringify(s)}`);
  check(s.some((x) => /customer_id_mismatch TXN-9001/.test(x)), "the wrong-ID refusal is logged in tool_calls (customer_id_mismatch)");
  check(s.some((x) => /^lookup_transaction: (?!customer_id|guest_lookup)/.test(x)), "the right-ID lookup succeeded");
}

// B. Form escalation, the caller declines a time. (--only A skips it.)
if (arg("--only") !== "A") {
  console.log("\n== B. Form escalation, the caller declines a callback time");
  const callPass = await passFor({ mode: "customer", name: "Amara", email: "amara@lagosledger.example" });
  const callId = `test-d98-decline-${stamp()}`;
  const caller = ["I want to dispute my payment TXN-9001 and speak to a specialist."], agent: string[] = [];
  let declined = false;
  for (let t = 0; t < 6; t++) {
    const a = await say(callId, callPass, caller, agent);
    agent.push(a);
    console.log(`  t${t} caller: ${caller[t]}\n     agent: ${a.slice(0, 300)}`);
    const { count: tickets } = await db.from("support_tickets").select("*", { count: "exact", head: true }).eq("conversation_id", callId);
    if (declined && tickets) break;
    let next: string;
    if (/amara(@| at )lagos ?ledger/i.test(a) && !declined) next = "Yes, that's right.";
    else if (!declined && /(time|when|day)/i.test(a)) { next = "I don't want to give a time. Just have someone look at it."; declined = true; }
    else next = "Yes, please.";
    caller.push(next);
  }
  const spoken = agent.join(" ");
  const { data: esc } = await db.from("escalations").select("escalation_id").eq("conversation_id", callId);
  const { data: tkt } = await db.from("support_tickets").select("ticket_id, status").eq("conversation_id", callId);
  console.log(`  tool_calls: ${JSON.stringify(await summaries(callId))}`);
  check(declined, "the agent asked for a callback time and the caller declined");
  check((esc ?? []).length === 0, "no escalation written", JSON.stringify(esc));
  check((tkt ?? []).length === 1, "one support ticket written instead", JSON.stringify(tkt));
  check(/specialist will review/i.test(spoken), "the agent says a specialist will review it", spoken.slice(-300));
  check(!/callback (is |has been )?(arranged|booked|noted|scheduled)|(arranged|booked|scheduled|noted) (a |your )?call ?back|booked for/i.test(spoken), "the agent never says a callback is arranged, booked or noted", spoken.slice(-400));
  await db.from("support_tickets").update({ status: "closed" }).eq("conversation_id", callId);
}

console.log(`\nPASS ${pass}  FAIL ${fail}`);
process.exit(fail ? 1 : 0);
