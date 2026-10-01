// Discord team notifications (D83): the sender for notification_outbox (migration 006, D82).
//
// - Kicked after each turn is persisted (the tool's ticket/escalation transaction has committed
//   by then), and swept every DISCORD_SWEEP_MS (60s) for anything still pending.
// - Claim before send: a row is claimed by a compare-and-set on `attempts` (one UPDATE ... WHERE
//   status = 'pending' AND attempts = n), so two sweeps or two replicas never both send it.
// - Sent only on a 2xx (status 'sent', sent_at). One retry (respecting a 429's retry_after),
//   then 'failed' with last_error. A row left mid-send by a crash (pending, attempts > 0, older
//   than STUCK_MS) is marked failed, not resent: a possible miss is better than a double post.
// - Messages are built from a whitelist of payload fields: never amounts or support notes (an
//   amount inside free text is masked), never the webhook URL or any secret; mentions disabled.
// - Rows from channel 'test' conversations (test:tools, the eval runner) are not posted: they are
//   marked sent with last_error 'skipped (not posted): test conversation', so the channel only
//   gets real calls.
// - No DISCORD_WEBHOOK_URL: the sender stays off, rows stay pending, one log line.
// - Never blocks or fails a ticket, escalation or turn: everything here is fire-and-forget and
//   every error is caught and logged.

import type { Db } from "@relaypay/shared";

export type OutboxKind = "ticket_created" | "escalation_created" | "escalation_updated";

export interface OutboxRow {
  id: number;
  kind: OutboxKind;
  ref_id: string;
  payload: Record<string, unknown>;
  attempts: number;
  channel: string | null;
}

export interface SendResult {
  ok: boolean;
  status: number;
  retryAfterMs?: number;
  error?: string;
}

type Log = (event: Record<string, unknown>) => void;

export const SKIPPED_TEST_NOTE = "skipped (not posted): test conversation";
const MAX_RETRY_WAIT_MS = 30_000;
const DEFAULT_RETRY_WAIT_MS = 2_000;
const SEND_TIMEOUT_MS = 10_000;
const STUCK_MS = 10 * 60_000;
const BATCH = 20;

/** A Discord webhook URL (the only shape the sender will post to). */
export function isDiscordWebhookUrl(url: string): boolean {
  return /^https:\/\/(?:(?:canary|ptb)\.)?discord(?:app)?\.com\/api\/webhooks\/\d+\/[\w-]+$/.test(url);
}

/** Masks money amounts in free text (the structured payload has none; a summary or reason might). */
export function maskAmounts(text: string): string {
  const codes = "USD|EUR|GBP|NGN|GHS|KES|ZAR|CAD|AUD";
  return text
    .replace(new RegExp(`[$€£₦₵]\\s?\\d[\\d,]*(?:\\.\\d+)?|\\b(?:${codes})\\s?\\d[\\d,]*(?:\\.\\d+)?|\\b\\d[\\d,]*(?:\\.\\d+)?\\s?(?:${codes}|dollars|euros|pounds|naira|cedis)\\b`, "gi"), "[amount]");
}

/** Removes anything that looks like a webhook URL or token from an error before it is stored or logged. */
export function scrubSecrets(text: string, webhookUrl?: string): string {
  let s = webhookUrl ? text.split(webhookUrl).join("[webhook]") : text;
  s = s.replace(/https?:\/\/\S*\/api\/webhooks\/\S+/gi, "[webhook]");
  return s.slice(0, 300);
}

const clean = (v: unknown, max = 300): string | null => {
  if (v === null || v === undefined || v === "") return null;
  const s = maskAmounts(String(v)).replace(/\s+/g, " ").trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
};

/** The Discord message for one outbox row. Only whitelisted fields; no amounts, notes or secrets. */
export function formatMessage(row: Pick<OutboxRow, "kind" | "ref_id" | "payload">): { content: string; allowed_mentions: { parse: [] } } {
  const p = row.payload;
  const lines: string[] = [];
  const field = (label: string, value: string | null) => { if (value) lines.push(`**${label}:** ${value}`); };
  if (row.kind === "ticket_created") {
    lines.push(`🎫 **New support ticket ${clean(p["ticket_id"]) ?? row.ref_id}**`);
    field("Category", clean(p["category"]));
    field("Priority", clean(p["priority"]));
    field("Customer", clean(p["customer_id"]) ?? "unverified");
    field("Summary", clean(p["summary"], 500));
  } else {
    lines.push(row.kind === "escalation_created"
      ? `🚨 **New escalation ${clean(p["escalation_id"]) ?? row.ref_id}**`
      : `🔄 **Escalation ${clean(p["escalation_id"]) ?? row.ref_id} updated** (preferred callback time added)`);
    field("Ticket", clean(p["ticket_id"]));
    field("Category", clean(p["category"]));
    field("Customer", clean(p["customer_id"]) ?? "unverified");
    field("Reason", clean(p["reason"], 500));
    field("Preferred time", clean(p["preferred_time_text"]) ?? "not given");
    field("Call booked", p["call_booked"] === true ? "yes" : "no");
    field("Caller email", clean(p["user_email"]));
  }
  return { content: lines.join("\n").slice(0, 1900), allowed_mentions: { parse: [] } };
}

/** Parses a 429's wait (body retry_after in seconds, else the Retry-After header). */
export function retryAfterMs(bodyText: string, header: string | null): number | undefined {
  try {
    const v = Number((JSON.parse(bodyText) as { retry_after?: unknown }).retry_after);
    if (Number.isFinite(v) && v >= 0) return Math.ceil(v * 1000);
  } catch {
    /* not JSON */
  }
  const h = Number(header);
  return Number.isFinite(h) && h >= 0 ? Math.ceil(h * 1000) : undefined;
}

export async function postToDiscord(webhookUrl: string, body: unknown, fetchImpl: typeof fetch = fetch): Promise<SendResult> {
  try {
    const res = await fetchImpl(`${webhookUrl}?wait=true`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
    const text = await res.text().catch(() => "");
    if (res.ok) return { ok: true, status: res.status };
    return {
      ok: false,
      status: res.status,
      ...(res.status === 429 ? { retryAfterMs: retryAfterMs(text, res.headers.get("retry-after")) ?? DEFAULT_RETRY_WAIT_MS } : {}),
      error: scrubSecrets(`HTTP ${res.status}: ${text}`, webhookUrl),
    };
  } catch (err) {
    return { ok: false, status: 0, error: scrubSecrets(err instanceof Error ? `${err.name}: ${err.message}` : String(err), webhookUrl) };
  }
}

export interface NotifierOptions {
  db: Db;
  webhookUrl: string | undefined;
  log: Log;
  intervalMs?: number;
  /** Post rows from channel 'test' conversations too (the one-off test send only). */
  includeTest?: boolean;
  /** Only these row ids (the one-off test send). */
  onlyIds?: number[];
  send?: (body: unknown) => Promise<SendResult>;
  sleep?: (ms: number) => Promise<void>;
  /** Start the interval timer (and a startup sweep). Off in tests and one-off scripts. */
  timer?: boolean;
}

export interface Notifier {
  enabled: boolean;
  /** Fire-and-forget sweep (after a turn is persisted). Never throws. */
  kick(): void;
  /** One sweep; resolves with what happened. Never throws. */
  runOnce(): Promise<{ sent: number; failed: number; skipped: number }>;
  stop(): void;
}

export function createDiscordNotifier(opts: NotifierOptions): Notifier {
  const { db, log } = opts;
  const url = opts.webhookUrl?.trim() ?? "";
  const zero = { sent: 0, failed: 0, skipped: 0 };
  if (!url || !isDiscordWebhookUrl(url)) {
    log({ event: "discord_notifier_off", reason: url ? "DISCORD_WEBHOOK_URL is not a Discord webhook URL" : "DISCORD_WEBHOOK_URL not set; outbox rows stay pending" });
    return { enabled: false, kick: () => undefined, runOnce: async () => zero, stop: () => undefined };
  }
  const send = opts.send ?? ((body: unknown) => postToDiscord(url, body));
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  const claim = async (id: number, attempts: number): Promise<boolean> => {
    const { data, error } = await db.from("notification_outbox").update({ attempts: attempts + 1 })
      .eq("id", id).eq("status", "pending").eq("attempts", attempts).select("id");
    if (error) throw new Error(`outbox claim failed (${error.code}): ${error.message}`);
    return (data ?? []).length === 1;
  };
  const finish = async (id: number, patch: Record<string, unknown>) => {
    const { error } = await db.from("notification_outbox").update(patch).eq("id", id).eq("status", "pending");
    if (error) throw new Error(`outbox update failed (${error.code}): ${error.message}`);
  };

  const deliver = async (row: OutboxRow): Promise<"sent" | "failed" | "skipped" | "lost"> => {
    if (row.channel === "test" && !opts.includeTest) {
      if (!(await claim(row.id, 0))) return "lost";
      await finish(row.id, { status: "sent", sent_at: new Date().toISOString(), last_error: SKIPPED_TEST_NOTE });
      return "skipped";
    }
    const body = formatMessage(row);
    let last: SendResult = { ok: false, status: 0 };
    for (let attempt = 0; attempt < 2; attempt++) {
      if (!(await claim(row.id, attempt))) return "lost"; // someone else has it
      last = await send(body);
      if (last.ok) {
        await finish(row.id, { status: "sent", sent_at: new Date().toISOString(), last_error: null });
        log({ event: "discord_sent", outbox_id: row.id, kind: row.kind, ref_id: row.ref_id, attempt: attempt + 1 });
        return "sent";
      }
      log({ event: "discord_send_failed", outbox_id: row.id, kind: row.kind, attempt: attempt + 1, status: last.status, error: last.error });
      if (attempt === 0) await sleep(Math.min(last.retryAfterMs ?? DEFAULT_RETRY_WAIT_MS, MAX_RETRY_WAIT_MS));
    }
    await finish(row.id, { status: "failed", last_error: (last.error ?? `HTTP ${last.status}`).slice(0, 500) });
    return "failed";
  };

  let running: Promise<{ sent: number; failed: number; skipped: number }> | null = null;
  let again = false;

  const sweep = async () => {
    const out = { ...zero };
    // Rows left mid-send (crash between claim and result): fail them rather than risk a double post.
    const stuckBefore = new Date(Date.now() - STUCK_MS).toISOString();
    const stuck = await db.from("notification_outbox").update({ status: "failed", last_error: "interrupted mid-send; not retried (avoids a double post)" })
      .eq("status", "pending").gt("attempts", 0).lt("created_at", stuckBefore).select("id");
    if (stuck.error) throw new Error(`outbox stuck check failed (${stuck.error.code}): ${stuck.error.message}`);
    if ((stuck.data ?? []).length) log({ event: "discord_stuck_failed", ids: (stuck.data as Array<{ id: number }>).map((r) => r.id) });

    let q = db.from("notification_outbox").select("id, kind, ref_id, payload, attempts, conversations(channel)")
      .eq("status", "pending").eq("attempts", 0).order("id").limit(BATCH);
    if (opts.onlyIds) q = q.in("id", opts.onlyIds);
    const { data, error } = await q;
    if (error) throw new Error(`outbox read failed (${error.code}): ${error.message}`);
    type Embedded = Omit<OutboxRow, "channel"> & { conversations: { channel: string } | Array<{ channel: string }> | null };
    for (const r of (data ?? []) as unknown as Embedded[]) {
      const conv = Array.isArray(r.conversations) ? r.conversations[0] : r.conversations;
      const result = await deliver({ ...r, channel: conv?.channel ?? null });
      if (result !== "lost") out[result]++;
    }
    return out;
  };

  const runOnce = async () => {
    if (running) {
      again = true;
      return running;
    }
    running = (async () => {
      const total = { ...zero };
      try {
        do {
          again = false;
          const r = await sweep();
          total.sent += r.sent; total.failed += r.failed; total.skipped += r.skipped;
        } while (again);
        if (total.sent || total.failed || total.skipped) log({ event: "discord_sweep", ...total });
      } catch (err) {
        log({ event: "discord_sweep_failed", message: scrubSecrets(err instanceof Error ? err.message : String(err), url) });
      } finally {
        running = null;
      }
      return total;
    })();
    return running;
  };

  let timer: NodeJS.Timeout | undefined;
  if (opts.timer) {
    void runOnce();
    timer = setInterval(() => void runOnce(), opts.intervalMs ?? 60_000);
    timer.unref();
  }
  log({ event: "discord_notifier_on", interval_ms: opts.timer ? opts.intervalMs ?? 60_000 : null });
  return { enabled: true, kick: () => void runOnce(), runOnce, stop: () => timer && clearInterval(timer) };
}
