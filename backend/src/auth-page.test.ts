// Voice page login logic (L1, D86). The module is the browser file backend/public/auth.js,
// loaded by URL; the markup is read from index.html.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const publicDir = resolve(dirname(fileURLToPath(import.meta.url)), "..", "public");
interface Auth {
  SUPABASE_JS_URL: string;
  MESSAGES: Record<string, string>;
  loginErrorMessage(err: unknown): string;
  passOutcome(status: number): { kind: string; message?: string };
  authView(event: string, session: unknown, opts?: { userInitiated?: boolean }): { view: string; email?: string; message?: string };
  validLoginForm(email: unknown, password: unknown): boolean;
  callOverrides(pass: string): unknown;
}
const a = (await import(pathToFileURL(resolve(publicDir, "auth.js")).href)) as Auth;

describe("page login (D86)", () => {
  it("signed in -> call view with the email; signed out by the user -> 'logged out'; otherwise -> 'expired'", () => {
    assert.deepEqual(a.authView("SIGNED_IN", { user: { email: "x@y.example" } }), { view: "call", email: "x@y.example" });
    assert.deepEqual(a.authView("INITIAL_SESSION", null), { view: "login", message: "" });
    assert.deepEqual(a.authView("SIGNED_OUT", null, { userInitiated: true }), { view: "login", message: a.MESSAGES["loggedOut"] });
    assert.deepEqual(a.authView("SIGNED_OUT", null), { view: "login", message: "Your session has expired. Please log in again." });
  });
  it("pass responses: 401 -> back to login (expired); 403 / 429 / other -> a clear error", () => {
    assert.deepEqual(a.passOutcome(200), { kind: "ok" });
    assert.deepEqual(a.passOutcome(401), { kind: "relogin", message: a.MESSAGES["expired"] });
    assert.equal(a.passOutcome(403).message, a.MESSAGES["notAllowed"]);
    assert.equal(a.passOutcome(429).message, a.MESSAGES["rateLimited"]);
    assert.equal(a.passOutcome(503).message, a.MESSAGES["unavailable"]);
  });
  it("login errors: bad credentials, rate limit, network", () => {
    assert.equal(a.loginErrorMessage({ status: 400, code: "invalid_credentials" }), a.MESSAGES["badCredentials"]);
    assert.equal(a.loginErrorMessage({ status: 429 }), a.MESSAGES["rateLimited"]);
    assert.equal(a.loginErrorMessage(new TypeError("Failed to fetch")), a.MESSAGES["network"]);
  });
  it("form check and the call overrides that carry the pass", () => {
    assert.ok(a.validLoginForm("customer@relaypay.example", "x"));
    assert.ok(!a.validLoginForm("nope", "x") && !a.validLoginForm("a@b.co", ""));
    assert.deepEqual(a.callOverrides("P"), { variableValues: { callPass: "P" } });
  });
  it("supabase-js is pinned to the version the backend uses", () => {
    const pkg = JSON.parse(readFileSync(resolve(publicDir, "..", "..", "node_modules", "@supabase", "supabase-js", "package.json"), "utf8")) as { version: string };
    assert.equal(a.SUPABASE_JS_URL, `https://esm.sh/@supabase/supabase-js@${pkg.version}`);
  });
  it("markup: a labelled login form (email, password autocomplete), an alert for errors, log out, the call UI wrapper", () => {
    const html = readFileSync(resolve(publicDir, "index.html"), "utf8");
    assert.match(html, /<section id="login"[^>]*hidden>/);
    assert.match(html, /<label for="login-email">Email<\/label>\s*<input id="login-email"[^>]*autocomplete="username"/);
    assert.match(html, /<input id="login-password"[^>]*type="password"[^>]*autocomplete="current-password"/);
    assert.match(html, /id="login-error"[^>]*role="alert"/);
    assert.match(html, /id="logout"/);
    assert.match(html, /<div id="call-ui"/);
  });
});
