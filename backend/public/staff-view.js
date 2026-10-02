// Staff dashboard view logic (L2, D87). Pure functions, no DOM, so they are unit-tested
// (backend/src/staff-view.test.ts) and imported by staff.js. The browser never reads tables: the
// records come from GET /staff/records, which verifies the staff token on the server.

export const FILTERS = [
  { type: "tickets", label: "Raised tickets" },
  { type: "callbacks", label: "Scheduled callbacks" },
];

export const STAFF_MESSAGES = {
  notStaff: "This account isn't staff. Log in with a RelayPay staff account.",
  expired: "Your session has expired. Please log in again.",
  loggedOut: "You've logged out.",
  rateLimited: "Too many requests. Please wait a minute and refresh.",
  unavailable: "Records are unavailable right now. Please try again in a moment.",
  network: "We couldn't reach RelayPay. Check your connection and refresh.",
  disabled: "The staff dashboard is not enabled.",
};

/** The records URL for a filter. */
export function recordsPath(type, includeTest = false) {
  return `/staff/records?type=${encodeURIComponent(type)}${includeTest ? "&include_test=1" : ""}`;
}

/** What to do with a GET /staff/records response status. */
export function recordsOutcome(status) {
  if (status === 200) return { kind: "ok" };
  if (status === 401) return { kind: "relogin", message: STAFF_MESSAGES.expired };
  if (status === 403) return { kind: "error", message: STAFF_MESSAGES.notStaff };
  if (status === 429) return { kind: "error", message: STAFF_MESSAGES.rateLimited };
  return { kind: "error", message: STAFF_MESSAGES.unavailable };
}

/** "2 Oct, 11:05" in Lagos time (WAT), or the raw value if unparsable. */
export function formatWhen(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso ?? "");
  return new Intl.DateTimeFormat("en-GB", { timeZone: "Africa/Lagos", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(d) + " WAT";
}

const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : "");

/**
 * One card: a title, a badge line, and labelled fields (label/value pairs, empty values dropped).
 * Built from whitelisted record fields only.
 */
export function cardFor(type, r) {
  if (type === "tickets") {
    return {
      title: `Ticket ${r.ticket_id}`,
      badges: [cap(r.category), `${cap(r.priority)} priority`, cap(r.status)].filter(Boolean),
      fields: [
        ["Customer", r.customer_id || "Not verified on the call"],
        ["Summary", r.summary],
        ["Raised", formatWhen(r.created_at)],
        ...(r.channel === "test" ? [["Source", "Test conversation"]] : []),
      ].filter(([, v]) => v),
    };
  }
  return {
    title: `Callback for escalation ${r.escalation_id}`,
    badges: [cap(r.category), cap(r.status)].filter(Boolean),
    fields: [
      ["Callback booked", r.callback_slot ? slotForStaff(r.callback_slot) : "Not booked"],
      ["Caller's words", r.preferred_time_text ? `“${r.preferred_time_text}”` : ""],
      ["Caller", r.user_name],
      ["Caller email", r.user_email],
      ["Customer", r.customer_id || "Not verified on the call"],
      ["Linked ticket", r.ticket_id],
      ["Reason", r.reason],
      ["Requested", formatWhen(r.created_at)],
      ...(r.channel === "test" ? [["Source", "Test conversation"]] : []),
    ].filter(([, v]) => v),
  };
}

/** D97: "Mon 5 Oct, 10:00 WAT" for a booked slot (Lagos is UTC+1, no DST). */
export function slotForStaff(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const l = new Date(d.getTime() + 60 * 60_000);
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${days[l.getUTCDay()]} ${l.getUTCDate()} ${months[l.getUTCMonth()]}, ${String(l.getUTCHours()).padStart(2, "0")}:${String(l.getUTCMinutes()).padStart(2, "0")} WAT`;
}

/** The empty-state line for a filter. */
export function emptyText(type) {
  return type === "tickets" ? "No raised tickets yet." : "No scheduled callbacks yet.";
}

/** The count line announced after a load. */
export function countText(type, n) {
  const [one, many] = type === "callbacks" ? ["scheduled callback", "scheduled callbacks"] : ["raised ticket", "raised tickets"];
  return `${n} ${n === 1 ? one : many}${n === 100 ? " (latest 100)" : ""}.`;
}

/** D98: every status the database allows (support_tickets / escalations: open, in progress, closed). */
export const STATUSES = ["open", "in progress", "closed"];

/**
 * The Close action for a record, or null when it is already closed. Tickets and escalations both
 * close; closing an escalation frees its callback slot, so the confirmation says so.
 */
export function closeAction(type, record) {
  const status = String(record?.status ?? "");
  if (!STATUSES.includes(status) || status === "closed") return null;
  if (type === "callbacks") {
    const id = String(record.escalation_id ?? "");
    return { kind: "escalation", id, label: `Close ${id}`, confirm: `Close ${id}? Its callback slot will be freed.` };
  }
  const id = String(record.ticket_id ?? "");
  return { kind: "ticket", id, label: `Close ${id}`, confirm: `Close ${id}?` };
}

/** Whether a card is shown as closed (still listed, marked closed). */
export function isClosed(record) {
  return String(record?.status ?? "") === "closed";
}
