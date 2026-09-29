// Verifies the Supabase seed against assets/seed-data/*.csv.
//
// Checks: CSV row count vs DB row count per table, orphaned FK count (must be 0), and exact
// values of the test-scenario fixtures. Prints a deterministic report; exits 1 on any mismatch.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { parse } from "csv-parse/sync";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SEED_DIR = resolve(REPO, "assets", "seed-data");

type DbRow = Record<string, unknown>;

const TABLES = [
  { table: "customers", file: "customers.csv", key: "customer_id" },
  { table: "transactions", file: "transactions.csv", key: "transaction_id" },
  { table: "payouts", file: "payouts.csv", key: "payout_id" },
] as const;

const FIXTURES: ReadonlyArray<{ table: string; key: string; id: string; expect: Record<string, string> }> = [
  {
    table: "customers", key: "customer_id", id: "CUS-1001",
    expect: { contact_name: "Amara Okafor", company_name: "LagosLedger", account_status: "active", kyc_status: "approved" },
  },
  { table: "transactions", key: "transaction_id", id: "TXN-9001", expect: { status: "processing" } },
  { table: "payouts", key: "payout_id", id: "PAY-7002", expect: { status: "review required", transaction_id: "TXN-9003" } },
  { table: "transactions", key: "transaction_id", id: "TXN-9003", expect: { status: "review required" } },
];

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set in .env`);
  return value;
}

function csvRowCount(file: string): number {
  const records: string[][] = parse(readFileSync(resolve(SEED_DIR, file), "utf8"), {
    bom: true,
    skip_empty_lines: true,
  });
  return records.length - 1; // minus header
}

async function main(): Promise<number> {
  process.loadEnvFile(resolve(REPO, ".env"));
  const supabase = createClient(requireEnv("SUPABASE_URL"), requireEnv("SUPABASE_SERVICE_ROLE_KEY"), {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const failures: string[] = [];
  const rows: Record<string, DbRow[]> = {};

  console.log("== Row counts (CSV vs DB)");
  for (const { table, file, key } of TABLES) {
    const { data, error, count } = await supabase
      .from(table)
      .select("*", { count: "exact" })
      .order(key);
    if (error) throw new Error(`${table}: select failed (${error.code}): ${error.message}`);
    if (!data || data.length !== count) {
      throw new Error(`${table}: fetched ${data?.length ?? 0} of ${count} rows (pagination needed)`);
    }
    rows[table] = data as DbRow[];
    const csv = csvRowCount(file);
    const ok = csv === count;
    console.log(`${ok ? "OK  " : "FAIL"} ${table.padEnd(13)} csv=${csv} db=${count}`);
    if (!ok) failures.push(`${table} count csv=${csv} db=${count}`);
  }

  console.log("== Orphaned foreign keys");
  const ids = (table: string, key: string) => new Set((rows[table] ?? []).map((r) => r[key]));
  const customerIds = ids("customers", "customer_id");
  const transactionIds = ids("transactions", "transaction_id");
  const txCustomer = new Map((rows["transactions"] ?? []).map((r) => [r["transaction_id"], r["customer_id"]]));
  const orphanChecks: Array<[string, number]> = [
    ["transactions.customer_id -> customers",
      (rows["transactions"] ?? []).filter((r) => !customerIds.has(r["customer_id"])).length],
    ["payouts.transaction_id -> transactions",
      (rows["payouts"] ?? []).filter((r) => !transactionIds.has(r["transaction_id"])).length],
    ["payouts.customer_id -> customers",
      (rows["payouts"] ?? []).filter((r) => !customerIds.has(r["customer_id"])).length],
    ["payouts.customer_id = transaction's customer",
      (rows["payouts"] ?? []).filter((r) => txCustomer.get(r["transaction_id"]) !== r["customer_id"]).length],
  ];
  let orphans = 0;
  for (const [label, n] of orphanChecks) {
    orphans += n;
    console.log(`${n === 0 ? "OK  " : "FAIL"} ${label}: ${n}`);
    if (n !== 0) failures.push(`${label}: ${n}`);
  }
  console.log(`orphaned total: ${orphans}`);

  console.log("== Fixtures");
  for (const { table, key, id, expect } of FIXTURES) {
    const row = (rows[table] ?? []).find((r) => r[key] === id);
    if (!row) {
      console.log(`FAIL ${id}: not found in ${table}`);
      failures.push(`${id} missing`);
      continue;
    }
    for (const [field, want] of Object.entries(expect)) {
      const got = row[field];
      const ok = got === want;
      console.log(`${ok ? "OK  " : "FAIL"} ${id}.${field} = ${JSON.stringify(got)}${ok ? "" : ` (expected ${JSON.stringify(want)})`}`);
      if (!ok) failures.push(`${id}.${field}`);
    }
  }

  console.log(failures.length === 0 ? "VERIFY OK" : `VERIFY FAILED (${failures.length}): ${failures.join("; ")}`);
  return failures.length === 0 ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    console.error(`VERIFY ERROR: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  },
);
