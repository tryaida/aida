// The better-auth sign-in adapter template (src/init/templates/better-auth-sign-in.mjs): its pure
// parts and the refusals that run before any database is touched.
import { createHmac } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { isBetterAuth, signInTemplateFor, writeBetterAuthSignIn } from "../../src/init/sign-in-template.js";
// @ts-expect-error -- plain .mjs template, no type declarations
import * as tpl from "../../src/init/templates/better-auth-sign-in.mjs";

const createdDirs: string[] = [];
function tmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "aida-better-auth-test-"));
  createdDirs.push(dir);
  return dir;
}
afterEach(() => {
  while (createdDirs.length > 0) rmSync(createdDirs.pop()!, { recursive: true, force: true });
});

describe("which template", () => {
  it("picks better-auth for better-auth and Auth.js for next-auth", () => {
    expect(isBetterAuth("better-auth")).toBe(true);
    expect(signInTemplateFor("better-auth")).toBe("better-auth");
    expect(signInTemplateFor("Auth.js (next-auth)")).toBe("auth-js");
    expect(signInTemplateFor("Clerk")).toBeUndefined();
    expect(signInTemplateFor(undefined)).toBeUndefined();
  });
});

describe("signedCookieValue", () => {
  it("matches better-auth's signed cookie: token, a dot, base64 HMAC-SHA256, URL-encoded", () => {
    const token = "abc123_-XYZ";
    const secret = "a-test-secret-that-is-long-enough-000";
    const sig = createHmac("sha256", secret).update(token).digest("base64");
    expect(tpl.signedCookieValue(token, secret)).toBe(encodeURIComponent(`${token}.${sig}`));
    expect(tpl.signedCookieValue(token, secret)).not.toContain("+");
  });
});

describe("cookieName", () => {
  it("adds __Secure- on https only, and honours an override", () => {
    expect(tpl.cookieName("http://localhost:3000")).toBe("better-auth.session_token");
    expect(tpl.cookieName("https://localhost:3000")).toBe("__Secure-better-auth.session_token");
    expect(tpl.cookieName("http://localhost:3000", "my.session")).toBe("my.session");
  });
});

describe("assertLocal", () => {
  it("allows this machine only, for the app and the database", () => {
    expect(() => tpl.assertLocal("http://localhost:3000", "app")).not.toThrow();
    expect(() => tpl.assertLocal("http://127.0.0.1:3000", "app")).not.toThrow();
    expect(() => tpl.assertLocal("postgres://u:p@localhost:5432/db", "database")).not.toThrow();
    expect(() => tpl.assertLocal("https://app.example.com", "app")).toThrow(/app is on app\.example\.com/);
    expect(() => tpl.assertLocal("postgres://u:p@db.example.com:5432/db", "database")).toThrow(/database is on db\.example\.com/);
    expect(() => tpl.assertLocal("not a url", "app")).toThrow(/isn't a URL/);
  });
});

describe("findSecret and appEnv", () => {
  it("prefers the environment, then .env.local, then .env, never .env.production", () => {
    const app = tmpDir();
    writeFileSync(join(app, ".env.production"), "BETTER_AUTH_SECRET=prod\n");
    expect(() => tpl.findSecret({}, app)).toThrow(/never reads \.env\.production/);
    writeFileSync(join(app, ".env"), "BETTER_AUTH_SECRET=from-env\n");
    expect(tpl.findSecret({}, app)).toBe("from-env");
    writeFileSync(join(app, ".env.local"), 'BETTER_AUTH_SECRET="from-local"\n');
    expect(tpl.findSecret({}, app)).toBe("from-local");
    expect(tpl.findSecret({ BETTER_AUTH_SECRET: "from-run" }, app)).toBe("from-run");
  });
  it("falls back to AUTH_SECRET", () => {
    const app = tmpDir();
    expect(tpl.findSecret({ AUTH_SECRET: "x" }, app)).toBe("x");
  });
});

describe("personaEmail", () => {
  it("uses the persona's email, else the USERS map, else says what to add", () => {
    expect(tpl.personaEmail({ role: "admin", email: "pat@example.com" }, { admin: "other@example.com" })).toBe("pat@example.com");
    expect(tpl.personaEmail({ role: "admin" }, { admin: "admin@example.com" })).toBe("admin@example.com");
    expect(() => tpl.personaEmail({ role: "staff" }, {})).toThrow(/add it to USERS/);
  });
});

describe("signIn refusals", () => {
  const context = { addCookies: async () => {}, request: { get: async () => ({ ok: () => false }) } };
  it("signs nobody in without a persona", async () => {
    await expect(tpl.default({ context, baseUrl: "https://app.example.com", persona: undefined, env: {} })).resolves.toBeUndefined();
  });
  it("refuses a non-local app before reading anything", async () => {
    await expect(tpl.default({ context, baseUrl: "https://app.example.com", persona: { role: "admin" }, env: {} })).rejects.toThrow(/not this machine/);
  });
  it("refuses a non-local database", async () => {
    await expect(
      tpl.default({ context, baseUrl: "http://localhost:3000", persona: { role: "admin" }, env: { DATABASE_URL: "postgres://u:p@db.example.com/x", BETTER_AUTH_SECRET: "s" } }),
    ).rejects.toThrow(/database is on db\.example\.com/);
  });
});

describe("writeBetterAuthSignIn", () => {
  it("writes the adapter pointing at the app, and never overwrites it", async () => {
    const root = tmpDir();
    const help = join(root, "help");
    const r = writeBetterAuthSignIn(help, root);
    expect(r.written).toBe(true);
    const content = readFileSync(r.file, "utf8");
    expect(content).toContain('resolve(dirname(fileURLToPath(import.meta.url)), "../..")');
    expect(content).not.toContain("__APP_DIR__");
    const mod = await import(r.file);
    expect(mod.APP_DIR).toBe(root);

    writeFileSync(r.file, "// mine\n");
    expect(writeBetterAuthSignIn(help, root).written).toBe(false);
    expect(readFileSync(r.file, "utf8")).toBe("// mine\n");
  });
});

describe("personaUser", () => {
  it("takes an email or a user id from USERS", async () => {
    const tpl = await import("../../src/init/templates/better-auth-sign-in.mjs");
    expect(tpl.personaUser({ role: "admin" }, { admin: "admin@example.com" })).toEqual({ email: "admin@example.com" });
    expect(tpl.personaUser({ role: "admin" }, { admin: { id: "user-1" } })).toEqual({ id: "user-1" });
    expect(tpl.personaUser({ role: "admin", email: "pat@example.com" }, { admin: { id: "user-1" } })).toEqual({ email: "pat@example.com" });
  });
});
