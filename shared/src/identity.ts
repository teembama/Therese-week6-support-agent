// Normalisation for identity matching and spoken identifiers (Batch 2B, D39). Pure functions.
//
// Voice transcripts split and case words unpredictably ("Lagos Ledger", "lagosledger") and
// spell emails out ("amara at lagos ledger dot example"), so every comparison runs on a
// normalised form.

/** Lowercase letters and digits only: "Lagos Ledger" = "LagosLedger" = "lagos-ledger". */
export function normaliseName(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "") // strip diacritics: "Efúa" -> "Efua"
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

/**
 * True if a spoken contact name matches the record's contact name: the whole name, or exactly
 * one of its words ("Amara" or "Okafor" for "Amara Okafor"). No prefixes or fuzzy matching:
 * "Ama" does not match. Empty input never matches.
 */
export function contactNameMatches(spoken: string, recordName: string): boolean {
  const s = normaliseName(spoken);
  if (!s) return false;
  if (s === normaliseName(recordName)) return true;
  return recordName.split(/\s+/).some((word) => normaliseName(word) === s);
}

const EMAIL = /^[a-z0-9](?:[a-z0-9._%+-]*[a-z0-9])?@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/;

/**
 * Normalises a spoken or written email and validates its format. Returns null when the result
 * is not a plausible address.
 *   "amara at lagos ledger dot example" -> "amara@lagosledger.example"
 *   "Amara@LagosLedger.example"         -> "amara@lagosledger.example"
 * Spoken words are only replaced as whole words: "at", "dot", "underscore", "dash"/"hyphen",
 * "plus". Everything else is lowercased and its spaces removed.
 */
export function normaliseEmail(text: string): string | null {
  const words = text
    .normalize("NFKC")
    .toLowerCase()
    .trim()
    .replace(/[<>"',;:!?()]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  const spoken: Record<string, string> = { at: "@", dot: ".", period: ".", underscore: "_", dash: "-", hyphen: "-", plus: "+" };
  const joined = words.map((w) => spoken[w] ?? w).join("");
  if (joined.length > 254 || (joined.match(/@/g) ?? []).length !== 1) return null;
  if (joined.includes("..")) return null;
  return EMAIL.test(joined) ? joined : null;
}

/**
 * Normalises a record reference: "txn 9001", "TXN9001", "txn-9001" -> "TXN-9001". Returns null
 * unless it is the prefix plus exactly four digits (the seed-data format).
 */
export function normaliseReference(text: string, prefix: "CUS" | "TXN" | "PAY"): string | null {
  const m = new RegExp(`^\\s*${prefix}[\\s_-]?(\\d{4})\\s*$`, "i").exec(text);
  return m ? `${prefix}-${m[1]}` : null;
}
