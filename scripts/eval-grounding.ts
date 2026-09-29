// Grounding evaluation (D30, D32): a fixed question set through the real endpoint in text mode,
// each answer checked against the chunks it cited by the deterministic grounding checks.
// Checks FLAG; they do not fail. Social turns must speak the backend's fixed line.
// Usage: npm run eval:grounding -- --label before|after   (after npm run build)
// Writes docs-ready markdown to stdout and raw results to the scratchpad-style JSON path given
// by --out (optional).

import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { checkGrounding, createServiceClient, type GroundingFlag } from "@relaypay/shared";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SERVER = resolve(REPO, "backend", "dist", "server.js");
const PORT = 8793;
const COST_CAP_USD = 0.05;

export const QUESTIONS: ReadonlyArray<{ id: string; text: string }> = [
  { id: "S1", text: "What fees does RelayPay charge for international payments?" },
  { id: "S2", text: "My payment is stuck." },
  { id: "S3", text: "I am Amara from LagosLedger. Can you check my account?" },
  { id: "S4", text: "Can you check transaction TXN-9001?" },
  { id: "S5", text: "What is happening with payout PAY-7002?" },
  { id: "S6", text: "My invoice payment failed and I need someone to look at it." },
  { id: "S7", text: "My account was restricted and nobody is helping me." },
  { id: "S8", text: "Can RelayPay guarantee my payout arrives by 9am tomorrow?" },
  { id: "K1", text: "How long do payouts to Kenya take?" },
  { id: "T1", text: "Thank you." },
];
const THANKS_LINE = "You're welcome. Is there anything else I can help you with?";

interface Row {
  id: string;
  question: string;
  answerType: string;
  spoken: string;
  cited: string[];
  flags: GroundingFlag[];
  checked: boolean;
  costUsd: number;
  msFirstToken: number | null;
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { label: { type: "string" }, out: { type: "string" } } });
  const label = values.label ?? "run";
  process.loadEnvFile(resolve(REPO, ".env"));
  const secret = `test-${randomBytes(24).toString("hex")}`;
  const db = createServiceClient();
  const run = `${label}-${new Date().toISOString().replace(/[:.]/g, "-")}`;

  const logs: string[] = [];
  const proc: ChildProcess = spawn(process.execPath, [SERVER], { env: { ...process.env, PORT: String(PORT), VAPI_LLM_SECRET: secret }, stdio: ["ignore", "pipe", "pipe"] });
  proc.stdout!.on("data", (d: Buffer) => logs.push(d.toString()));
  proc.stderr!.on("data", (d: Buffer) => logs.push(d.toString()));
  for (let i = 0; i < 150 && !logs.join("").includes('"event":"listening"'); i++) await new Promise((r) => setTimeout(r, 100));

  const rows: Row[] = [];
  try {
    for (const q of QUESTIONS) {
      const id = `test-grounding-${run}-${q.id}`;
      const res = await fetch(`http://localhost:${PORT}/v/${secret}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ call: { id }, messages: [{ role: "system", content: "placeholder" }, { role: "user", content: q.text }] }),
      });
      await res.text();
      let turn: Record<string, unknown> | null = null;
      for (let w = 0; w < 120 && !turn; w++) {
        const { data } = await db.from("conversation_turns").select("*").eq("conversation_id", id).eq("turn_index", 0).maybeSingle();
        turn = (data as Record<string, unknown> | null) ?? null;
        if (!turn) await new Promise((r) => setTimeout(r, 250));
      }
      const { data: conv } = await db.from("conversations").select("total_cost_usd").eq("conversation_id", id).maybeSingle();
      const cited = ((turn?.["kb_chunk_ids"] ?? []) as string[]);
      const spoken = String(turn?.["assistant_response"] ?? "");
      const answerType = String(turn?.["answer_type"] ?? "missing");
      let flags: GroundingFlag[] = [];
      const checked = answerType === "answer" && cited.length > 0;
      if (checked) {
        // The chunk heading is part of the evidence the agent saw.
        const { data: chunks } = await db.from("kb_chunks").select("heading, content").in("chunk_id", cited);
        const evidence = ((chunks ?? []) as Array<{ heading: string; content: string }>).map((c) => `${c.heading}\n${c.content}`);
        flags = checkGrounding(spoken, evidence, q.text);
      }
      rows.push({ id: q.id, question: q.text, answerType, spoken, cited, flags, checked, costUsd: Number(conv?.["total_cost_usd"] ?? 0), msFirstToken: (turn?.["ms_first_token"] as number | null) ?? null });
    }
  } finally {
    proc.kill();
  }

  const total = rows.reduce((t, r) => t + r.costUsd, 0);
  const flagged = rows.filter((r) => r.flags.length).length;
  const social = rows.find((r) => r.id === "T1");
  console.log(`## Run: ${label} (${run})\n`);
  console.log("| Q | Answer type | Flags | Spoken |");
  console.log("| --- | --- | --- | --- |");
  for (const r of rows) {
    const f = !r.checked ? "not checked (no cited chunk)" : r.flags.length ? r.flags.map((x) => `${x.kind}: \`${x.term}\``).join("<br>") : "none";
    console.log(`| ${r.id} | ${r.answerType} | ${f} | ${r.spoken.replace(/\|/g, "\\|")} |`);
  }
  console.log(`\n- Answers checked: ${rows.filter((r) => r.checked).length}; answers with at least one flag: ${flagged}; total flags: ${rows.reduce((t, r) => t + r.flags.length, 0)}`);
  console.log(`- "Thank you" (T1): answer_type=${social?.answerType}, fixed line spoken: ${social?.spoken === THANKS_LINE}`);
  console.log(`- Cost (estimate, turns + attempts): $${total.toFixed(4)} (cap $${COST_CAP_USD}) ${total <= COST_CAP_USD ? "OK" : "OVER CAP"}`);
  const serverErrors = logs.join("").split(/\r?\n/).filter((l) => l.includes("[relaypay]"));
  console.log(`- Server-side errors during the run: ${serverErrors.length}`);
  for (const l of serverErrors) console.log(`  - ${l.slice(0, 220)}`);
  if (values.out) writeFileSync(values.out, JSON.stringify({ label, run, rows, totalCostUsd: total }, null, 2));
  if (total > COST_CAP_USD) process.exitCode = 1;
}

main().catch((err: unknown) => {
  console.error(`EVAL-GROUNDING ERROR: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
  process.exit(1);
});
