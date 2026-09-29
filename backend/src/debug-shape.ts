// TEMPORARY (live Vapi test, D26): request STRUCTURE only. Enabled with
// RELAYPAY_DEBUG_REQUEST_SHAPE=1. Prints header NAMES and the body's key tree with every value
// replaced by its type. Never header values, the token, or message content.

export function shapeOf(value: unknown, depth = 0): unknown {
  if (depth > 8) return "…";
  if (value === null) return "null";
  if (Array.isArray(value)) {
    const merged: Record<string, unknown> = {};
    const scalarTypes = new Set<string>();
    for (const item of value.slice(0, 100)) {
      const s = shapeOf(item, depth + 1);
      if (s && typeof s === "object" && !Array.isArray(s)) Object.assign(merged, s);
      else scalarTypes.add(String(s));
    }
    const items = Object.keys(merged).length ? merged : [...scalarTypes].join("|") || "empty";
    return { [`array(${value.length})`]: items };
  }
  if (typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, shapeOf(v, depth + 1)]));
  }
  return typeof value;
}
