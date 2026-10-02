// Live login enforcement checks (L1, D86) against the DEPLOYED backend with
// CUSTOMER_LOGIN_REQUIRED=1 and migration 007 applied.
//
//   npm run test:login -- [--base-url URL] [--customer EMAIL] [--staff EMAIL]
//
// - /config exposes only the Supabase URL and publishable key; POST /calls/pass: no token / a
//   garbage token -> 401; a real customer and a real staff session -> 200 with a pass. Sessions
//   come from the admin API (a magic-link token verified server-side), so no password is needed.
// - Turns: no pass, a forged pass, an expired pass and a reused pass -> the login line, recorded as
//   answer_type error / login_required, no model, no tool calls. A valid pass -> a normal turn, and
//   a later turn of that call without the pass -> still served (the conversation is linked).
// Conversations are test-login-<run>-..., channel 'test'. One real agent turn (~$0.01).

import { createHash, randomBytes } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServiceClient } from "@relaypay/shared";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const argValue = (flag: string) => { const i = process.argv.indexOf(flag); return i >= 0 ? process.argv[i + 1] : undefined; };
const BASE_URL = (argValue("--base-url") ?? "https://relaypay-backend-production-aa34.up.railway.app").replace(/\/$/, "");
const CUSTOMER = argValue("--customer") ?? "customer@relaypay.example";
const STAFF = argValue("--staff") ?? "care@relaypay.example";
const LOGIN_LINE = "Please log in on the RelayPay page to use voice support.";
const RUN = new Date().toISOString().replace(/[:.]/g, "-");

let pass = 0, fail = 0;
function check(ok: boolean, label: string, detail = "") {
  if (ok) pass++; else fail++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${!ok && detail ? `\n      ${detail}` : ""}`);
}

process.loadEnvFile(resolve(REPO, ".env"));
const db = createServiceClient();
const SUPABASE_URL = process.env["SUPABASE_URL"]!;
const SERVICE_KEY = process.env["SUPABASE_SERVICE_ROLE_KEY"]!;
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

async function sessionFor(email: string): Promise<{ token: string; userId: string }> {
  const { data, error } = await db.auth.admin.generateLink({ type: "magiclink", email });
  if (error || !data?.properties?.hashed_token) throw new Error(`generateLink(${email}) failed: ${error?.message}`);
  const res = await fetch(`${SUPABASE_URL}/auth/v1/verify`, {
    method: "POST",
    headers: { apikey: SERVICE_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ type: "magiclink", token_hash: data.properties.hashed_token }),
  });
  const body = (await res.json()) as { access_token?: string; user?: { id: string } };
  if (!body.access_token || !body.user) throw new Error(`verify(${email}) failed: HTTP ${res.status}`);
  return { token: body.access_token, userId: body.user.id };
}

async function turn(callId: string, callerTurns: string[], agentTurns: string[], callPass?: string): Promise<string> {
  const messages: Array<{ role: string; content: string }> = [{ role: "system", content: "Vapi placeholder" }];
  callerTurns.forEach((c, i) => {
    messages.push({ role: "user", content: c });
    if (agentTurns[i] !== undefined) messages.push({ role: "assistant", content: agentTurns[i]! });
  });
  const call = { id: callId, ...(callPass !== undefined ? { assistantOverrides: { clientMessages: [], variableValues: { callPass } } } : {}) };
  const res = await fetch(`${BASE_URL}/v/${process.env["VAPI_LLM_SECRET"]}/chat/completions`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "relaypay-agent", stream: true, call, messages }),
  });
  const text = await res.text();
  return text.split("\n").filter((l) => l.startsWith("data: ") && !l.includes("[DONE]"))
    .map((l) => { try { return (JSON.parse(l.slice(6)) as { choices?: Array<{ delta?: { content?: string } }> }).choices?.[0]?.delta?.content ?? ""; } catch { return ""; } })
    .join("").trim();
}

async function recorded(callId: string, turnIndex: number) {
  for (let i = 0; i < 20; i++) {
    const { data } = await db.from("conversation_turns").select("answer_type, assistant_response, model, confidence_note").eq("conversation_id", callId).eq("turn_index", turnIndex).maybeSingle();
    if (data) {
      const { data: att } = await db.from("turn_attempts").select("status_reason").eq("conversation_id", callId).eq("turn_index", turnIndex);
      const { count } = await db.from("tool_calls").select("*", { count: "exact", head: true }).eq("conversation_id", callId);
      return { ...(data as Record<string, unknown>), reasons: (att ?? []).map((a) => a.status_reason), toolCalls: count ?? 0 };
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return null;
}

async function expectDenied(label: string, callId: string, callPass?: string) {
  const spoken = await turn(callId, ["What fees does RelayPay charge for international payments?"], [], callPass);
  check(spoken === LOGIN_LINE, `${label}: the login line is spoken`, spoken);
  const row = await recorded(callId, 0);
  check(row?.["answer_type"] === "error" && (row?.["reasons"] as string[]).includes("login_required") && row?.["model"] == null && row?.["toolCalls"] === 0,
    `${label}: recorded as answer_type error / login_required, no model, no tool calls`, JSON.stringify(row));
}

async function main() {
  console.log(`== /config and POST /calls/pass   (${BASE_URL}, run ${RUN})`);
  const config = (await (await fetch(`${BASE_URL}/config`)).json()) as Record<string, unknown>;
  check(config["loginRequired"] === true && typeof config["supabasePublishableKey"] === "string" && config["supabaseUrl"] === new URL(SUPABASE_URL).origin,
    "/config: login required, Supabase URL and publishable key", JSON.stringify(Object.keys(config)));
  check(!JSON.stringify(config).includes(SERVICE_KEY), "/config never carries the service-role key");
  check((await fetch(`${BASE_URL}/calls/pass`, { method: "POST" })).status === 401, "no token -> 401");
  check((await fetch(`${BASE_URL}/calls/pass`, { method: "POST", headers: { Authorization: `Bearer ${"x".repeat(60)}` } })).status === 401, "garbage token -> 401");
  const customer = await sessionFor(CUSTOMER);
  const staff = await sessionFor(STAFF);
  const issue = async (token: string) => fetch(`${BASE_URL}/calls/pass`, { method: "POST", headers: { Authorization: `Bearer ${token}` } });
  const r1 = await issue(customer.token);
  const p1 = ((await r1.json()) as { pass?: string }).pass ?? "";
  check(r1.status === 200 && /^[A-Za-z0-9_-]{43}$/.test(p1), "customer session -> 200 with a pass");
  const { data: stored } = await db.from("call_passes").select("user_id, role, used_at, expires_at, created_at").eq("pass_hash", sha(p1)).maybeSingle();
  check(stored?.user_id === customer.userId && stored?.role === "customer" && stored?.used_at === null
    && Math.round((Date.parse(stored.expires_at) - Date.parse(stored.created_at)) / 1000) === 300, "stored as its hash: this user, role customer, unused, 5-minute expiry", JSON.stringify(stored));
  const r2 = await issue(staff.token);
  check(r2.status === 200, "staff session -> 200 (role staff may call too)");

  console.log("\n== Turns without a valid pass: the login line, no agent run");
  await expectDenied("no pass", `test-login-${RUN}-none`);
  await expectDenied("forged pass", `test-login-${RUN}-forged`, randomBytes(32).toString("base64url"));
  const expired = randomBytes(32).toString("base64url");
  await db.from("call_passes").insert({ pass_hash: sha(expired), user_id: customer.userId, role: "customer", created_at: new Date(Date.now() - 6 * 60_000).toISOString(), expires_at: new Date(Date.now() - 60_000).toISOString() });
  await expectDenied("expired pass", `test-login-${RUN}-expired`, expired);

  console.log("\n== A valid pass: a normal turn; later turns need no pass; the pass can't be reused");
  const okCall = `test-login-${RUN}-valid`;
  const q = "What fees does RelayPay charge for international payments?";
  const a1 = await turn(okCall, [q], [], p1);
  const row1 = await recorded(okCall, 0);
  check(a1 !== LOGIN_LINE && a1.length > 20 && row1?.["answer_type"] !== "error", "valid pass -> a normal agent turn", `${row1?.["answer_type"]}: ${a1.slice(0, 120)}`);
  const { data: used } = await db.from("call_passes").select("used_at, conversation_id").eq("pass_hash", sha(p1)).maybeSingle();
  check(used?.used_at !== null && used?.conversation_id === okCall, "the pass is marked used and linked to the conversation");
  const a2 = await turn(okCall, [q, "Thanks, that's all."], [a1]);
  check(a2 !== LOGIN_LINE && a2.length > 0, "a later turn of the same call without the pass -> served", a2);
  await expectDenied("reused pass (another conversation)", `test-login-${RUN}-reused`, p1);

  console.log(`\nPASS ${pass}  FAIL ${fail}`);
  console.log(fail === 0 ? "TEST-LOGIN OK" : "TEST-LOGIN FAILED");
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
