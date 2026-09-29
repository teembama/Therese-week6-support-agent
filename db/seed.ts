// Loads assets/seed-data/*.csv into Supabase with upserts (safe to rerun).
//
// - Uses the service-role/secret key from .env; refuses a publishable/anon key.
// - Validates each CSV's header against the expected columns before sending anything.
// - Empty CSV cells become NULL.
// - Tables are upserted in FK order. Each table is one request (one statement), so a table is
//   either fully upserted or not at all. Any error aborts the run with a non-zero exit and
//   says which tables were already upserted; because upserts are idempotent, fix and rerun.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { parse } from "csv-parse/sync";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SEED_DIR = resolve(REPO, "assets", "seed-data");

type Row = Record<string, string | null>;

interface SeedTable {
  table: string;
  file: string;
  key: string;
  columns: readonly string[];
}

// FK order: customers -> transactions -> payouts.
const SEED_TABLES: readonly SeedTable[] = [
  {
    table: "customers",
    file: "customers.csv",
    key: "customer_id",
    columns: ["customer_id", "company_name", "contact_name", "contact_email", "plan",
      "account_status", "region", "kyc_status", "support_notes"],
  },
  {
    table: "transactions",
    file: "transactions.csv",
    key: "transaction_id",
    columns: ["transaction_id", "customer_id", "transaction_type", "amount", "currency",
      "destination_country", "status", "created_at", "estimated_arrival", "support_summary"],
  },
  {
    table: "payouts",
    file: "payouts.csv",
    key: "payout_id",
    columns: ["payout_id", "transaction_id", "customer_id", "recipient_name", "amount",
      "currency", "status", "scheduled_for", "failure_reason"],
  },
];

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set in .env`);
  return value;
}

// Refuse keys that would silently hit RLS (anon/publishable) instead of failing loudly.
function assertServiceKey(key: string): void {
  if (key.startsWith("sb_publishable_")) {
    throw new Error("SUPABASE_SERVICE_ROLE_KEY is a publishable key; the seed needs the secret key");
  }
  if (key.startsWith("eyJ")) {
    const payload: unknown = JSON.parse(
      Buffer.from(key.split(".")[1] ?? "", "base64url").toString("utf8"),
    );
    const role = (payload as { role?: unknown }).role;
    if (role !== "service_role") {
      throw new Error(`SUPABASE_SERVICE_ROLE_KEY has role "${String(role)}", expected "service_role"`);
    }
  }
}

function readCsv({ file, columns, key }: SeedTable): Row[] {
  const text = readFileSync(resolve(SEED_DIR, file), "utf8");
  const records: string[][] = parse(text, { bom: true, skip_empty_lines: true });
  const [header, ...body] = records;
  if (!header || header.join(",") !== columns.join(",")) {
    throw new Error(`${file}: header is [${header?.join(", ")}], expected [${columns.join(", ")}]`);
  }
  const rows = body.map((cells, i) => {
    if (cells.length !== columns.length) {
      throw new Error(`${file} line ${i + 2}: ${cells.length} cells, expected ${columns.length}`);
    }
    return Object.fromEntries(columns.map((c, j) => [c, cells[j] === "" ? null : cells[j]!])) as Row;
  });
  const seen = new Set<string>();
  for (const row of rows) {
    const id = row[key];
    if (!id) throw new Error(`${file}: row with empty ${key}`);
    if (seen.has(id)) throw new Error(`${file}: duplicate ${key} ${id}`);
    seen.add(id);
  }
  return rows;
}

async function main(): Promise<void> {
  process.loadEnvFile(resolve(REPO, ".env"));
  const url = requireEnv("SUPABASE_URL");
  const key = requireEnv("SUPABASE_SERVICE_ROLE_KEY");
  assertServiceKey(key);

  // Parse and validate every file before writing anything.
  const plan = SEED_TABLES.map((t) => ({ ...t, rows: readCsv(t) }));

  const supabase = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const done: string[] = [];
  for (const { table, key: conflictKey, rows } of plan) {
    const { data, error } = await supabase
      .from(table)
      .upsert(rows, { onConflict: conflictKey })
      .select(conflictKey);
    if (error) {
      throw new Error(
        `${table}: upsert failed (${error.code}): ${error.message}` +
          (error.details ? ` | ${error.details}` : "") +
          ` | tables already upserted: [${done.join(", ")}]`,
      );
    }
    if (!data || data.length !== rows.length) {
      throw new Error(
        `${table}: upserted ${data?.length ?? 0} rows, expected ${rows.length}` +
          ` | tables already upserted: [${done.join(", ")}]`,
      );
    }
    console.log(`${table}: upserted ${data.length} rows`);
    done.push(table);
  }
  console.log("SEED OK");
}

main().catch((err: unknown) => {
  console.error(`SEED FAILED: ${err instanceof Error ? err.message : String(err)}`);
  console.error("Upserts are idempotent: fix the cause and rerun.");
  process.exit(1);
});
