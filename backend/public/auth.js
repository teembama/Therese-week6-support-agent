// Customer login for the voice page (L1, D86). Pure functions, no DOM, so they are unit-tested
// (backend/src/auth-page.test.ts) and imported by app.js. The browser uses Supabase Auth with the
// PUBLISHABLE key only, and never reads tables. The session lives in sessionStorage (this tab only).

export const SUPABASE_JS_URL = "https://esm.sh/@supabase/supabase-js@2.109.0";

export const MESSAGES = {
  expired: "Your session has expired. Please log in again.",
  loggedOut: "You've logged out.",
  badCredentials: "That email and password don't match. Please try again.",
  notAllowed: "This account can't use voice support. Please contact RelayPay.",
  rateLimited: "Too many attempts. Please wait a minute and try again.",
  network: "We couldn't reach the login service. Check your connection and try again.",
  unavailable: "Voice support is unavailable right now. Please try again in a moment.",
  missing: "Enter your email and password.",
};

/** The message for a failed signInWithPassword (Supabase AuthError: status and code). */
export function loginErrorMessage(err) {
  const status = Number(err?.status ?? 0);
  const code = String(err?.code ?? "");
  if (code === "invalid_credentials" || status === 400) return MESSAGES.badCredentials;
  if (status === 429 || code === "over_request_rate_limit") return MESSAGES.rateLimited;
  if (status === 0 || /fetch|network/i.test(String(err?.message ?? ""))) return MESSAGES.network;
  return MESSAGES.unavailable;
}

/**
 * What to do with a POST /calls/pass response status:
 *   200 -> start the call; 401 -> back to login (session expired); 403 -> not allowed;
 *   429 -> slow down; anything else -> unavailable.
 */
export function passOutcome(status) {
  if (status === 200) return { kind: "ok" };
  if (status === 401) return { kind: "relogin", message: MESSAGES.expired };
  if (status === 403) return { kind: "error", message: MESSAGES.notAllowed };
  if (status === 429) return { kind: "error", message: MESSAGES.rateLimited };
  return { kind: "error", message: MESSAGES.unavailable };
}

/**
 * Supabase auth events -> the page's view. SIGNED_OUT that the user didn't ask for (a refresh
 * failed, or the session was revoked) shows the expiry message.
 */
export function authView(event, session, { userInitiated = false } = {}) {
  if (session?.user && event !== "SIGNED_OUT") return { view: "call", email: String(session.user.email ?? "") };
  if (event === "SIGNED_OUT") return { view: "login", message: userInitiated ? MESSAGES.loggedOut : MESSAGES.expired };
  return { view: "login", message: "" };
}

/** Basic form check before calling Supabase. */
export function validLoginForm(email, password) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email ?? "").trim()) && String(password ?? "").length > 0;
}

/** The Vapi assistant overrides that carry the one-time pass to the backend. */
export function callOverrides(pass) {
  return { variableValues: { callPass: pass } };
}
