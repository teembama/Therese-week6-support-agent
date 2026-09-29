// Verifies the Supabase seed against the seed CSVs.
//
// Checks: CSV row count vs DB row count per table, orphaned FK count (must be 0), and exact
// values of the test-scenario fixtures in BOTH the CSV source and the DB. Prints a
// deterministic report; exits 1 on any mismatch.
//
// Usage: verify-seed [--csv-dir <dir>]   (default: assets/seed-data)
// --csv-dir exists for negative testing against a modified copy of the CSVs; it never
// changes what is read from or written to the database (this script only reads).

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { createClient } from "@supabase/supabase-js";
import { parse } from "csv-parse/sync";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_CSV_DIR = resolve(REPO, "assets", "seed-data");

type Row = Record<string, unknown>;

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

function readCsvRows(dir: string, file: string): Row[] {
  const records: string[][] = parse(readFileSync(resolve(dir, file), "utf8"), {
    bom: true,
    skip_empty_lines: true,
  });
  const [header, ...body] = records;
  if (!header) throw new Error(`${file}: empty file`);
  return body.map((cells) => Object.fromEntries(header.map((c, i) => [c, cells[i] === "" ? null : cells[i]])));
}

async function main(): Promise<number> {
  const { values } = parseArgs({ options: { "csv-dir": { type: "string" } } });
  const csvDir = values["csv-dir"] ? resolve(values["csv-dir"]) : DEFAULT_CSV_DIR;

  process.loadEnvFile(resolve(REPO, ".env"));
  const supabase = createClient(requireEnv("SUPABASE_URL"), requireEnv("SUPABASE_SERVICE_ROLE_KEY"), {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const failures: string[] = [];
  const dbRows: Record<string, Row[]> = {};
  const csvRows: Record<string, Row[]> = {};

  if (csvDir !== DEFAULT_CSV_DIR) console.log(`CSV dir override: ${csvDir}`);
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
    dbRows[table] = data as Row[];
    csvRows[table] = readCsvRows(csvDir, file);
    const csv = csvRows[table].length;
    const ok = csv === count;
    console.log(`${ok ? "OK  " : "FAIL"} ${table.padEnd(13)} csv=${csv} db=${count}`);
    if (!ok) failures.push(`${table} count csv=${csv} db=${count}`);
  }

  console.log("== Orphaned foreign keys");
  const rows = (table: string) => dbRows[table] ?? [];
  const ids = (table: string, key: string) => new Set(rows(table).map((r) => r[key]));
  const customerIds = ids("customers", "customer_id");
  const transactionIds = ids("transactions", "transaction_id");
  const txCustomer = new Map(rows("transactions").map((r) => [r["transaction_id"], r["customer_id"]]));
  const orphanChecks: Array<[string, number]> = [
    ["transactions.customer_id -> customers",
      rows("transactions").filter((r) => !customerIds.has(r["customer_id"])).length],
    ["payouts.transaction_id -> transactions",
      rows("payouts").filter((r) => !transactionIds.has(r["transaction_id"])).length],
    ["payouts.customer_id -> customers",
      rows("payouts").filter((r) => !customerIds.has(r["customer_id"])).length],
    ["payouts.customer_id = transaction's customer",
      rows("payouts").filter((r) => txCustomer.get(r["transaction_id"]) !== r["customer_id"]).length],
  ];
  let orphans = 0;
  for (const [label, n] of orphanChecks) {
    orphans += n;
    console.log(`${n === 0 ? "OK  " : "FAIL"} ${label}: ${n}`);
    if (n !== 0) failures.push(`${label}: ${n}`);
  }
  console.log(`orphaned total: ${orphans}`);

  for (const [source, data] of [["CSV", csvRows], ["DB", dbRows]] as const) {
    console.log(`== Fixtures (${source})`);
    for (const { table, key, id, expect } of FIXTURES) {
      const row = (data[table] ?? []).find((r) => r[key] === id);
      if (!row) {
        console.log(`FAIL ${id}: not found in ${source} ${table}`);
        failures.push(`${source} ${id} missing`);
        continue;
      }
      for (const [field, want] of Object.entries(expect)) {
        const got = row[field];
        const ok = got === want;
        console.log(`${ok ? "OK  " : "FAIL"} ${id}.${field} = ${JSON.stringify(got)}${ok ? "" : ` (expected ${JSON.stringify(want)})`}`);
        if (!ok) failures.push(`${source} ${id}.${field}`);
      }
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
