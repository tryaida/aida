// The Auth.js sign-in adapter template (src/init/templates/auth-js-sign-in.mjs): its pure parts,
// with the encoder injected — no Auth.js install needed.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { isAuthJs, writeAuthJsSignIn } from "../../src/init/sign-in-template.js";
// @ts-expect-error -- plain .mjs template, no type declarations
import * as tpl from "../../src/init/templates/auth-js-sign-in.mjs";

const createdDirs: string[] = [];
function tmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "aida-sign-in-test-"));
  createdDirs.push(dir);
  return dir;
}
afterEach(() => {
  while (createdDirs.length > 0) rmSync(createdDirs.pop()!, { recursive: true, force: true });
});

const persona = { role: "office-staff", name: "Pat Example", email: "pat@example.com" };

describe("sessionCookieName", () => {
  it("uses authjs.session-token for v5 and next-auth.session-token for v4", () => {
    expect(tpl.sessionCookieName(5, false)).toBe("authjs.session-token");
    expect(tpl.sessionCookieName(4, false)).toBe("next-auth.session-token");
  });
  it("adds __Secure- for secure cookies", () => {
    expect(tpl.sessionCookieName(5, true)).toBe("__Secure-authjs.session-token");
    expect(tpl.sessionCookieName(4, true)).toBe("__Secure-next-auth.session-token");
  });
  it("honours an override", () => {
    expect(tpl.sessionCookieName(5, true, "my.session")).toBe("my.session");
  });
});

describe("usesSecureCookies (Auth.js's own rule, not baseUrl alone)", () => {
  it("v5: AUTH_URL or NEXTAUTH_URL, else the request URL", () => {
    const app = tmpDir();
    expect(tpl.usesSecureCookies(5, "http://localhost:3000", {}, app)).toBe(false);
    expect(tpl.usesSecureCookies(5, "https://localhost:3000", {}, app)).toBe(true);
    expect(tpl.usesSecureCookies(5, "http://localhost:3000", { AUTH_URL: "https://app.example.com" }, app)).toBe(true);
    expect(tpl.usesSecureCookies(5, "http://localhost:3000", { NEXTAUTH_URL: "https://app.example.com" }, app)).toBe(true);
    expect(tpl.usesSecureCookies(5, "https://localhost:3000", { AUTH_URL: "http://localhost:3000" }, app)).toBe(false);
  });
  it("v4: NEXTAUTH_URL only (default http://localhost:3000), or the request URL when trusting the host", () => {
    const app = tmpDir();
    expect(tpl.usesSecureCookies(4, "https://localhost:3000", {}, app)).toBe(false);
    expect(tpl.usesSecureCookies(4, "http://localhost:3000", { AUTH_URL: "https://x.example.com" }, app)).toBe(false);
    expect(tpl.usesSecureCookies(4, "http://localhost:3000", { NEXTAUTH_URL: "https://x.example.com" }, app)).toBe(true);
    expect(tpl.usesSecureCookies(4, "https://localhost:3000", { AUTH_TRUST_HOST: "true" }, app)).toBe(true);
  });
  it("reads the URL from the app's env files, and honours useSecureCookies", () => {
    const app = tmpDir();
    writeFileSync(join(app, ".env.local"), "NEXTAUTH_URL=https://localhost:3000\n");
    expect(tpl.usesSecureCookies(4, "http://localhost:3000", {}, app)).toBe(true);
    expect(tpl.usesSecureCookies(4, "http://localhost:3000", {}, app, false)).toBe(false);
  });
});

describe("claims", () => {
  it("maps the persona and drops missing fields", () => {
    expect(tpl.claims(persona)).toEqual({ name: "Pat Example", email: "pat@example.com", sub: "pat@example.com", role: "office-staff" });
    expect(tpl.claims({ role: "judge" })).toEqual({ role: "judge" });
  });
});

describe("assertLocalBaseUrl", () => {
  it("allows this machine only", () => {
    for (const url of ["http://localhost:3000", "http://127.0.0.1:3000", "http://[::1]:3000"]) {
      expect(() => tpl.assertLocalBaseUrl(url)).not.toThrow();
    }
    for (const url of ["https://app.example.com", "http://localhost.evil.example", "not a url"]) {
      expect(() => tpl.assertLocalBaseUrl(url)).toThrow();
    }
  });
});

describe("findSecret", () => {
  it("v5 prefers AUTH_SECRET, then NEXTAUTH_SECRET, from the environment", () => {
    expect(tpl.findSecret({ AUTH_SECRET: "a", NEXTAUTH_SECRET: "n" }, tmpDir(), 5)).toBe("a");
    expect(tpl.findSecret({ NEXTAUTH_SECRET: "n" }, tmpDir(), 5)).toBe("n");
  });
  it("v4 reads NEXTAUTH_SECRET only", () => {
    expect(tpl.findSecret({ AUTH_SECRET: "a", NEXTAUTH_SECRET: "n" }, tmpDir(), 4)).toBe("n");
    expect(() => tpl.findSecret({ AUTH_SECRET: "a" }, tmpDir(), 4)).toThrow(/no NEXTAUTH_SECRET found/);
  });
  it("falls back to .env.local then .env, never .env.production or development-only files", () => {
    const app = tmpDir();
    writeFileSync(join(app, ".env.production"), "AUTH_SECRET=prod\n");
    writeFileSync(join(app, ".env.production.local"), "AUTH_SECRET=prod\n");
    writeFileSync(join(app, ".env.development.local"), "AUTH_SECRET=dev\n");
    expect(() => tpl.findSecret({}, app)).toThrow(/Set AUTH_SECRET in the environment of the capture run \(the same secret the app server under capture uses\)/);
    writeFileSync(join(app, ".env"), "AUTH_SECRET=base\n");
    expect(tpl.findSecret({}, app)).toBe("base");
    writeFileSync(join(app, ".env.local"), 'export AUTH_SECRET="local" # dev\n');
    expect(tpl.findSecret({}, app)).toBe("local");
    expect(tpl.findSecret({ AUTH_SECRET: "env" }, app)).toBe("env");
  });
  it("expands ${VAR} and $VAR the way Next does, but not in single quotes", () => {
    const app = tmpDir();
    writeFileSync(join(app, ".env"), "BASE=from-file\nAUTH_SECRET=${BASE}-x\nNEXTAUTH_SECRET='$BASE'\n");
    expect(tpl.findSecret({}, app, 5)).toBe("from-file-x");
    expect(tpl.findSecret({ BASE: "from-env" }, app, 5)).toBe("from-env-x");
    expect(tpl.findSecret({}, app, 4)).toBe("$BASE");
    writeFileSync(join(app, ".env"), "AUTH_SECRET=${MISSING:-fallback}\\$literal\n");
    expect(tpl.findSecret({}, app, 5)).toBe("fallback$literal");
  });
});

describe("mintSessionCookie", () => {
  it("encodes the claims with the cookie name as v5's salt", async () => {
    const seen: unknown[] = [];
    const encoder = { generation: 5, encode: async (p: unknown) => (seen.push(p), "jwe-v5") };
    const cookie = await tpl.mintSessionCookie({
      baseUrl: "http://localhost:3000",
      persona,
      env: { AUTH_SECRET: "s" },
      appDir: tmpDir(),
      encoder,
      now: 1_700_000_000_000,
    });
    expect(cookie).toMatchObject({ name: "authjs.session-token", value: "jwe-v5", url: "http://localhost:3000", httpOnly: true, secure: false });
    expect(seen[0]).toMatchObject({ secret: "s", salt: "authjs.session-token", maxAge: tpl.MAX_AGE, token: { email: "pat@example.com", iat: 1_700_000_000 } });
    expect(cookie.expires).toBe(1_700_000_000 + tpl.MAX_AGE);
  });

  it("uses an empty salt for v4", async () => {
    const seen: Array<{ salt: string }> = [];
    const encoder = { generation: 4, encode: async (p: { salt: string }) => (seen.push(p), "jwe-v4") };
    const cookie = await tpl.mintSessionCookie({ baseUrl: "http://localhost:3000", persona, env: { NEXTAUTH_SECRET: "s" }, appDir: tmpDir(), encoder });
    expect(cookie.name).toBe("next-auth.session-token");
    expect(seen[0].salt).toBe("");
  });

  it("picks the secret by version and the cookie prefix by the app's URL", async () => {
    const seen: Array<{ secret: string; salt: string }> = [];
    const v4 = { generation: 4, encode: async (p: { secret: string; salt: string }) => (seen.push(p), "x") };
    const env = { AUTH_SECRET: "v5-only", NEXTAUTH_SECRET: "v4", NEXTAUTH_URL: "https://localhost:3000" };
    const c4 = await tpl.mintSessionCookie({ baseUrl: "http://localhost:3000", persona, env, appDir: tmpDir(), encoder: v4 });
    expect(seen[0].secret).toBe("v4");
    expect(c4).toMatchObject({ name: "__Secure-next-auth.session-token", secure: true });
    const v5 = { generation: 5, encode: async (p: { secret: string; salt: string }) => (seen.push(p), "x") };
    const c5 = await tpl.mintSessionCookie({ baseUrl: "http://localhost:3000", persona, env: { ...env, AUTH_URL: "http://localhost:3000" }, appDir: tmpDir(), encoder: v5 });
    expect(seen[1]).toMatchObject({ secret: "v5-only", salt: "authjs.session-token" });
    expect(c5.secure).toBe(false);
  });

  it("refuses a non-local baseUrl before reading any secret", async () => {
    const encoder = { generation: 5, encode: async () => "never" };
    await expect(tpl.mintSessionCookie({ baseUrl: "https://app.example.com", persona, env: {}, encoder })).rejects.toThrow(/refusing/);
  });
});

function fakeContext(session: unknown, status = 200) {
  const requested: string[] = [];
  return {
    requested,
    addCookies: async () => {},
    request: {
      get: async (url: string) => {
        requested.push(url);
        return { ok: () => status < 400, status: () => status, json: async () => session };
      },
    },
  };
}

describe("verifySession", () => {
  const base = { baseUrl: "http://localhost:3000", persona, cookieName: "authjs.session-token" };
  it("passes when the app's session is the persona", async () => {
    const context = fakeContext({ user: { email: "PAT@example.com" }, expires: "x" });
    await expect(tpl.verifySession({ ...base, context, appDir: tmpDir() })).resolves.toBeTruthy();
    expect(context.requested).toEqual(["http://localhost:3000/api/auth/session"]);
  });
  it("fails loudly on an empty session (v5 null, v4 {})", async () => {
    for (const empty of [null, {}]) {
      await expect(tpl.verifySession({ ...base, context: fakeContext(empty), appDir: tmpDir() })).rejects.toThrow(
        /didn't accept the minted authjs.session-token cookie.*environment of the capture run/,
      );
    }
  });
  it("names .env.production files it didn't read", async () => {
    const app = tmpDir();
    writeFileSync(join(app, ".env.production"), "AUTH_SECRET=prod\n");
    await expect(tpl.verifySession({ ...base, context: fakeContext({}), appDir: app })).rejects.toThrow(/\.env\.production, which this adapter never reads/);
  });
  it("fails when someone else is signed in, or the endpoint errors", async () => {
    await expect(tpl.verifySession({ ...base, context: fakeContext({ user: { email: "sam@example.com" } }), appDir: tmpDir() })).rejects.toThrow(
      /signed in sam@example.com, not pat@example.com/,
    );
    await expect(tpl.verifySession({ ...base, context: fakeContext(null, 500), appDir: tmpDir() })).rejects.toThrow(/couldn't check the session.*HTTP 500/);
  });
});

describe("default export", () => {
  it("does nothing for a walkthrough with no persona", async () => {
    const added: unknown[] = [];
    await tpl.default({ context: { addCookies: async (c: unknown[]) => added.push(...c) }, baseUrl: "https://app.example.com", env: {} });
    expect(added).toEqual([]);
  });
});

describe("writeAuthJsSignIn", () => {
  it("writes the adapter pointing at the app, and never overwrites it", async () => {
    const root = tmpDir();
    const help = join(root, "help");
    const r = writeAuthJsSignIn(help, root);
    expect(r.written).toBe(true);
    const content = readFileSync(r.file, "utf8");
    expect(content).toContain('resolve(dirname(fileURLToPath(import.meta.url)), "../..")');
    expect(content).not.toContain("__APP_DIR__");
    const mod = await import(r.file);
    expect(mod.APP_DIR).toBe(root);

    writeFileSync(r.file, "// mine\n");
    expect(writeAuthJsSignIn(help, root).written).toBe(false);
    expect(readFileSync(r.file, "utf8")).toBe("// mine\n");
  });

  it("writes paths with quotes and $& patterns literally", async () => {
    const root = join(tmpDir(), `it's "$&" $' app`);
    const help = join(root, "help");
    const r = writeAuthJsSignIn(help, root);
    const mod = await import(r.file);
    expect(mod.APP_DIR).toBe(root);
  });

  it("recognises Auth.js labels only", () => {
    expect(isAuthJs("Auth.js (next-auth)")).toBe(true);
    expect(isAuthJs("Auth.js")).toBe(true);
    expect(isAuthJs("Clerk")).toBe(false);
    expect(isAuthJs(undefined)).toBe(false);
  });
});

