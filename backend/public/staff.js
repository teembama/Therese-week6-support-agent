// RelayPay staff dashboard (L2, D87). Supabase Auth in the browser with the PUBLISHABLE key only
// (session in sessionStorage, this tab only); records come only from GET /staff/records, which
// verifies the staff token and role on the server. The browser never reads tables.

import { loginErrorMessage, MESSAGES, SUPABASE_JS_URL, validLoginForm } from "/auth.js";
import { badgeClass, cardFor, countText, emptyText, recordsOutcome, recordsPath, STAFF_MESSAGES } from "/staff-view.js";

const el = (id) => document.getElementById(id);
const ui = {
  pageError: el("page-error"), login: el("login"), loginForm: el("login-form"), loginEmail: el("login-email"),
  loginPassword: el("login-password"), loginError: el("login-error"), loginMessage: el("login-message"), loginSubmit: el("login-submit"),
  dashboard: el("dashboard"), account: el("account"), accountEmail: el("account-email"), logout: el("logout"), refresh: el("refresh"),
  status: el("records-status"), list: el("records-list"), filters: [...document.querySelectorAll(".filter-button")],
};

let supabase = null;
let loggingOut = false;
let current = "tickets";
let loadSeq = 0;
const includeTest = new URLSearchParams(location.search).get("include_test") === "1";

function showLogin(message) {
  ui.dashboard.hidden = true;
  ui.account.hidden = true;
  ui.login.hidden = false;
  ui.loginMessage.textContent = message ?? "";
  ui.loginError.hidden = true;
  ui.loginSubmit.disabled = false;
  ui.list.replaceChildren();
}

function showDashboard(email) {
  ui.login.hidden = true;
  ui.dashboard.hidden = false;
  ui.account.hidden = false;
  ui.accountEmail.textContent = email;
  // Outside the auth callback: supabase-js can deadlock if its methods are awaited inside it.
  setTimeout(() => void load(), 0);
}

function showLoginError(message) {
  ui.loginError.textContent = message;
  ui.loginError.hidden = false;
  ui.loginSubmit.disabled = false;
  ui.loginEmail.focus();
}

function cardItem(type, record) {
  const card = cardFor(type, record);
  const li = document.createElement("li");
  li.className = "staff-item";
  const h = Object.assign(document.createElement("h3"), { textContent: card.title });
  const badges = document.createElement("p");
  badges.className = "badges";
  for (const b of card.badges) badges.append(Object.assign(document.createElement("span"), { className: badgeClass(b), textContent: b }));
  const dl = document.createElement("dl");
  for (const [label, value] of card.fields) {
    dl.append(Object.assign(document.createElement("dt"), { textContent: label }), Object.assign(document.createElement("dd"), { textContent: value }));
  }
  li.append(h, badges, dl);
  return li;
}

async function load() {
  const seq = ++loadSeq;
  const type = current;
  ui.status.textContent = "Loading…";
  ui.refresh.disabled = true;
  try {
    const { data } = await supabase.auth.getSession();
    const token = data?.session?.access_token;
    if (!token) return showLogin(STAFF_MESSAGES.expired);
    let res;
    try {
      res = await fetch(recordsPath(type, includeTest), { headers: { Authorization: `Bearer ${token}` }, cache: "no-store" });
    } catch {
      if (seq === loadSeq) ui.status.textContent = STAFF_MESSAGES.network;
      return;
    }
    if (seq !== loadSeq) return; // a newer filter or refresh superseded this load
    const outcome = recordsOutcome(res.status);
    if (outcome.kind === "relogin") {
      await supabase.auth.signOut({ scope: "local" }).catch(() => undefined);
      return showLogin(outcome.message);
    }
    if (outcome.kind === "error") {
      ui.list.replaceChildren();
      ui.status.textContent = outcome.message;
      return;
    }
    const body = await res.json();
    const records = Array.isArray(body?.records) ? body.records : [];
    ui.list.replaceChildren(...records.map((r) => cardItem(type, r)));
    ui.status.textContent = records.length ? countText(type, records.length) : emptyText(type);
  } finally {
    if (seq === loadSeq) ui.refresh.disabled = false;
  }
}

function selectFilter(type) {
  current = type;
  for (const b of ui.filters) b.setAttribute("aria-pressed", String(b.dataset.type === type));
  void load();
}

async function submitLogin(e) {
  e.preventDefault();
  const email = ui.loginEmail.value.trim();
  const password = ui.loginPassword.value;
  if (!validLoginForm(email, password)) return showLoginError(MESSAGES.missing);
  ui.loginSubmit.disabled = true;
  try {
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) return showLoginError(loginErrorMessage(error));
    ui.loginPassword.value = "";
  } catch (err) {
    showLoginError(loginErrorMessage(err));
  } finally {
    ui.loginSubmit.disabled = false;
  }
}

function pageError(message) {
  ui.pageError.textContent = message;
  ui.pageError.hidden = false;
}

async function init() {
  let config;
  try {
    const res = await fetch("/config", { cache: "no-store" });
    config = await res.json();
  } catch {
    return pageError(STAFF_MESSAGES.network);
  }
  if (!config?.staffDashboard || !config.supabaseUrl || !config.supabasePublishableKey) return pageError(STAFF_MESSAGES.disabled);
  let createClient;
  try {
    ({ createClient } = await import(SUPABASE_JS_URL));
  } catch {
    return pageError(STAFF_MESSAGES.unavailable);
  }
  supabase = createClient(config.supabaseUrl, config.supabasePublishableKey, {
    auth: { storage: window.sessionStorage, persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
  });
  ui.loginForm.addEventListener("submit", submitLogin);
  ui.logout.addEventListener("click", async () => {
    loggingOut = true;
    // UI round (D93): Log out signs out and goes to the landing page.
    try { await supabase.auth.signOut(); } catch { /* signed out locally anyway */ }
    location.assign("/");
  });
  ui.refresh.addEventListener("click", () => void load());
  for (const b of ui.filters) b.addEventListener("click", () => selectFilter(b.dataset.type));
  supabase.auth.onAuthStateChange((event, session) => {
    if (session?.user && event !== "SIGNED_OUT") {
      // Token refreshes keep the dashboard as it is; only a new sign-in (or the first load) reloads.
      if (event === "SIGNED_IN" || event === "INITIAL_SESSION") showDashboard(String(session.user.email ?? ""));
      return;
    }
    const message = event === "SIGNED_OUT" ? (loggingOut ? STAFF_MESSAGES.loggedOut : STAFF_MESSAGES.expired) : "";
    loggingOut = false;
    showLogin(message);
  });
}

init();
