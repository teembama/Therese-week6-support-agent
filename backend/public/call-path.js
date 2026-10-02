// The call page's two paths (L1b, D88). Pure functions, no DOM, so they are unit-tested
// (backend/src/call-path.test.ts) and imported by app.js.
//   - "I'm an existing customer": name + email, matched by the backend to ONE customer; the call is
//     then verified from its first turn. Identification, not authentication (name and email
//     aren't secrets).
//   - "Continue as a guest": the call behaves exactly as before (the agent verifies by voice).
// Nothing is stored: the name and email are sent once, for the pass, and kept in page memory only.

export const NO_MATCH_MESSAGE = "We couldn't find an account matching those details.";
export const GUEST_NUDGE = "Existing customer? Choose 'I'm an existing customer' next time for a faster, more secure check.";
const UNAVAILABLE = "Voice support is unavailable right now. Please try again in a moment.";
const RATE_LIMITED = "Too many attempts. Please wait a minute and try again.";
const NETWORK = "We couldn't reach RelayPay. Check your connection and try again.";

/** The POST /calls/pass body for a path, or an error message for the form. */
export function passRequest(path, name, email) {
  if (path === "guest") return { ok: true, body: { mode: "guest" } };
  if (path !== "customer") return { ok: false, message: "Choose how you'd like to continue." };
  const n = String(name ?? "").trim();
  const e = String(email ?? "").trim();
  if (!n || !e) return { ok: false, message: "Enter your name and email." };
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) return { ok: false, message: "Enter a valid email address." };
  return { ok: true, body: { mode: "customer", name: n, email: e } };
}

/** What to do with a /calls/pass response (status and parsed body). */
export function passResult(status, body) {
  if (status === 200 && typeof body?.pass === "string") {
    const firstName = typeof body.firstName === "string" && /^[\p{L}'-]{1,40}$/u.test(body.firstName) ? body.firstName : null;
    return { kind: "ok", pass: body.pass, firstName };
  }
  if (status === 422) return { kind: "no_match", message: NO_MATCH_MESSAGE };
  if (status === 429) return { kind: "error", message: RATE_LIMITED };
  if (status === 0) return { kind: "error", message: NETWORK };
  return { kind: "error", message: UNAVAILABLE };
}

/** The verified caller's greeting; guests keep the assistant's own first message. */
export function greeting(firstName) {
  return firstName ? `Hi ${firstName}, this is RelayPay support. How can I help you today?` : null;
}

/** Vapi assistant overrides: the pass (always) and, for a matched customer, the greeting. */
export function callOverrides(pass, firstName) {
  const first = greeting(firstName);
  return { variableValues: { callPass: pass }, ...(first ? { firstMessage: first } : {}) };
}

/** After a call ends: nudge a guest whose call checked an identity by voice. */
export function shouldNudge(path, identityChecked) {
  return path === "guest" && identityChecked === true;
}
