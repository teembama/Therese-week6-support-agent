// Loads assets/relaypay-knowledge-base.md into kb_chunks and keeps the table in sync with it.
//
// - One chunk per H3; its heading is "H2 > H3". An H2's intro text (before its first H3)
//   becomes its own chunk, headed with the H2 alone. The H1 intro is document metadata and
//   is skipped.
// - chunk_id is a stable slug of the heading path, so reloads upsert instead of duplicating.
// - Sync, not append: rows whose chunk_id is no longer produced by the file are deleted.
// - Prints the chunk count and any chunk over MAX_CHUNK_WORDS words.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServiceClient } from "@relaypay/shared";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const KB_FILE = resolve(REPO, "assets", "relaypay-knowledge-base.md");
const MAX_CHUNK_WORDS = 350;

interface Chunk {
  chunk_id: string;
  source_title: string;
  heading: string;
  content: string;
}

function slug(text: string): string {
  return text
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function wordCount(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

export function chunkKnowledgeBase(markdown: string): Chunk[] {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  let sourceTitle = "";
  let h2: string | null = null;
  let h3: string | null = null;
  let body: string[] = [];
  const chunks: Chunk[] = [];

  const flush = () => {
    const content = body.join("\n").replace(/\n{3,}/g, "\n\n").trim();
    body = [];
    if (!h2 || !content) return; // H1 intro (h2 === null) and empty sections are skipped
    chunks.push({
      chunk_id: h3 ? `${slug(h2)}--${slug(h3)}` : `${slug(h2)}--intro`,
      source_title: sourceTitle,
      heading: h3 ? `${h2} > ${h3}` : h2,
      content,
    });
  };

  for (const line of lines) {
    const heading = /^(#{1,3})\s+(.+?)\s*#*\s*$/.exec(line);
    if (!heading) {
      body.push(line);
      continue;
    }
    const [, hashes, text] = heading as unknown as [string, string, string];
    flush();
    if (hashes.length === 1) {
      sourceTitle = text;
      h2 = h3 = null;
    } else if (hashes.length === 2) {
      h2 = text;
      h3 = null;
    } else {
      if (!h2) throw new Error(`H3 "${text}" appears before any H2`);
      h3 = text;
    }
  }
  flush();

  if (!sourceTitle) throw new Error("knowledge base has no H1 title");
  const seen = new Set<string>();
  for (const c of chunks) {
    if (seen.has(c.chunk_id)) throw new Error(`duplicate chunk_id ${c.chunk_id}`);
    seen.add(c.chunk_id);
  }
  return chunks;
}

async function main(): Promise<void> {
  process.loadEnvFile(resolve(REPO, ".env"));
  const chunks = chunkKnowledgeBase(readFileSync(KB_FILE, "utf8"));
  if (chunks.length === 0) throw new Error("no chunks parsed; refusing to sync (would delete every row)");

  const db = createServiceClient();

  const { data: upserted, error: upsertError } = await db
    .from("kb_chunks")
    .upsert(chunks, { onConflict: "chunk_id" })
    .select("chunk_id");
  if (upsertError) throw new Error(`upsert failed (${upsertError.code}): ${upsertError.message}`);
  if (upserted?.length !== chunks.length) {
    throw new Error(`upserted ${upserted?.length ?? 0} rows, expected ${chunks.length}`);
  }

  // chunk_ids are [a-z0-9-] slugs, so they are safe inside the PostgREST in-list.
  const keep = `(${chunks.map((c) => `"${c.chunk_id}"`).join(",")})`;
  const { data: deleted, error: deleteError } = await db
    .from("kb_chunks")
    .delete()
    .not("chunk_id", "in", keep)
    .select("chunk_id");
  if (deleteError) throw new Error(`stale-row delete failed (${deleteError.code}): ${deleteError.message}`);

  const { count, error: countError } = await db.from("kb_chunks").select("*", { count: "exact", head: true });
  if (countError) throw new Error(`count failed (${countError.code}): ${countError.message}`);

  const intros = chunks.filter((c) => c.chunk_id.endsWith("--intro")).length;
  console.log(`chunks parsed: ${chunks.length} (${chunks.length - intros} H3, ${intros} H2 intro)`);
  console.log(`upserted: ${upserted.length}, stale deleted: ${deleted?.length ?? 0}` +
    (deleted?.length ? ` [${deleted.map((d) => d.chunk_id).join(", ")}]` : ""));
  console.log(`kb_chunks rows now: ${count}`);
  const words = chunks.map((c) => wordCount(c.content));
  console.log(`words per chunk: min ${Math.min(...words)}, max ${Math.max(...words)}`);
  const long = chunks.filter((c) => wordCount(c.content) > MAX_CHUNK_WORDS);
  console.log(long.length === 0
    ? `chunks over ${MAX_CHUNK_WORDS} words: none`
    : `chunks over ${MAX_CHUNK_WORDS} words: ${long.map((c) => `${c.chunk_id} (${wordCount(c.content)})`).join(", ")}`);
  if (count !== chunks.length) throw new Error(`kb_chunks has ${count} rows, expected ${chunks.length}`);
  console.log("LOAD-KB OK");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err: unknown) => {
    console.error(`LOAD-KB FAILED: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
