// The Supabase sign-in adapter template (src/init/templates/supabase-sign-in.mjs): its pure parts,
// the refusals that run before Supabase is called, and a full sign-in against a fake local auth
// server in a real browser.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { afterEach, describe, expect, it } from "vitest";
import { isSupabaseAuth, signInTemplateFor, writeSupabaseSignIn } from "../../src/init/sign-in-template.js";
import { detectFramework } from "../../src/init/detect.js";
// @ts-expect-error -- plain .mjs template, no type declarations
import * as tpl from "../../src/init/templates/supabase-sign-in.mjs";

const createdDirs: string[] = [];
const servers: Server[] = [];
function tmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "aida-supabase-test-"));
  createdDirs.push(dir);
  return dir;
}
afterEach(async () => {
  while (createdDirs.length > 0) rmSync(createdDirs.pop()!, { recursive: true, force: true });
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
});

async function listen(handler: (req: IncomingMessage, res: ServerResponse, body: string) => void): Promise<string> {
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => handler(req, res, body));
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

/** What `@supabase/ssr` does to read the session back: join `<key>` or `<key>.0..n`, strip
 * `base64-`, base64url-decode, parse. */
function readSsrCookie(cookies: { name: string; value: string }[], key: string): unknown {
  const byName = new Map(cookies.map((c) => [c.name, c.value]));
  let value = byName.get(key);
  if (value === undefined) {
    const parts: string[] = [];
    for (let i = 0; byName.has(`${key}.${i}`); i++) parts.push(byName.get(`${key}.${i}`)!);
    value = parts.join("");
  }
  const raw = value.startsWith("base64-") ? Buffer.from(value.slice(7), "base64url").toString("utf8") : decodeURIComponent(value);
  return JSON.parse(raw);
}

describe("which template", () => {
  it("picks the Supabase template for Supabase Auth, detected from any Supabase client package", () => {
    expect(isSupabaseAuth("Supabase Auth")).toBe(true);
    expect(signInTemplateFor("Supabase Auth")).toBe("supabase");
    for (const dep of ["@supabase/ssr", "@supabase/auth-helpers-nextjs", "@supabase/supabase-js"]) {
      const dir = tmpDir();
      writeFileSync(join(dir, "package.json"), JSON.stringify({ dependencies: { [dep]: "^2.0.0" } }));
      expect(detectFramework(dir).authLibrary).toBe("Supabase Auth");
    }
  });

  it("prefers another sign-in library when supabase-js is only there for data", () => {
    const dir = tmpDir();
    writeFileSync(join(dir, "package.json"), JSON.stringify({ dependencies: { "@supabase/supabase-js": "^2", "better-auth": "^1" } }));
    expect(detectFramework(dir).authLibrary).toBe("better-auth");
  });
});

describe("storageKey", () => {
  it("is supabase-js's default key from the API hostname, unless overridden", () => {
    expect(tpl.storageKey("http://127.0.0.1:54321")).toBe("sb-127-auth-token");
    expect(tpl.storageKey("http://localhost:54321")).toBe("sb-localhost-auth-token");
    expect(tpl.storageKey("https://abcdefgh.supabase.co")).toBe("sb-abcdefgh-auth-token");
    expect(tpl.storageKey("http://127.0.0.1:54321", "my-key")).toBe("my-key");
  });
});

describe("sessionCookies", () => {
  const session = { access_token: "a".repeat(40), refresh_token: "r", user: { id: "u1", email: "pat@example.com" } };

  it("writes one base64- cookie when it fits", () => {
    const cookies = tpl.sessionCookies("sb-127-auth-token", session);
    expect(cookies).toHaveLength(1);
    expect(cookies[0][0]).toBe("sb-127-auth-token");
    expect(cookies[0][1]).toMatch(/^base64-[A-Za-z0-9_-]+$/);
    expect(readSsrCookie(cookies.map(([name, value]: string[]) => ({ name, value })), "sb-127-auth-token")).toEqual(session);
  });

  it("splits a long session into .0, .1, ... chunks no longer than the limit", () => {
    const big = { ...session, user: { ...session.user, user_metadata: { note: "x".repeat(5000) } } };
    const cookies = tpl.sessionCookies("sb-127-auth-token", big);
    expect(cookies.map(([name]: string[]) => name)).toEqual(["sb-127-auth-token.0", "sb-127-auth-token.1", "sb-127-auth-token.2"]);
    for (const [, value] of cookies) expect(value.length).toBeLessThanOrEqual(tpl.MAX_CHUNK_SIZE);
    expect(readSsrCookie(cookies.map(([name, value]: string[]) => ({ name, value })), "sb-127-auth-token")).toEqual(big);
  });

  it("URL-encodes raw JSON for auth-helpers and never splits a %XX escape", () => {
    const odd = { ...session, user: { ...session.user, user_metadata: { note: "é ".repeat(800) } } };
    const cookies = tpl.sessionCookies("k", odd, "raw", 100);
    for (const [, value] of cookies) {
      expect(value.length).toBeLessThanOrEqual(100);
      expect(value).not.toMatch(/%.?$/);
    }
    expect(readSsrCookie(cookies.map(([name, value]: string[]) => ({ name, value })), "k")).toEqual(odd);
  });
});

describe("cookieEncoding", () => {
  it("uses raw JSON only for auth-helpers without @supabase/ssr", () => {
    const dir = tmpDir();
    expect(tpl.cookieEncoding(dir)).toBe("base64url");
    writeFileSync(join(dir, "package.json"), JSON.stringify({ dependencies: { "@supabase/auth-helpers-nextjs": "^0.10" } }));
    expect(tpl.cookieEncoding(dir)).toBe("raw");
    writeFileSync(join(dir, "package.json"), JSON.stringify({ dependencies: { "@supabase/auth-helpers-nextjs": "^0.10", "@supabase/ssr": "^0.6" } }));
    expect(tpl.cookieEncoding(dir)).toBe("base64url");
  });
});

describe("keyHeaders", () => {
  it("puts legacy JWT keys in Authorization too, new-style keys in apikey only", () => {
    expect(tpl.keyHeaders("eyJhbGciOi.x.y")).toMatchObject({ apikey: "eyJhbGciOi.x.y", authorization: "Bearer eyJhbGciOi.x.y" });
    expect(tpl.keyHeaders("sb_secret_abc").authorization).toBeUndefined();
    expect(tpl.keyHeaders("sb_publishable_abc", "user-token").authorization).toBe("Bearer user-token");
  });
});

describe("supabaseSettings", () => {
  it("reads the app's own variables from the environment and its development env files, never production", () => {
    const dir = tmpDir();
    writeFileSync(join(dir, ".env.local"), "VITE_SUPABASE_URL=http://127.0.0.1:54321/\nVITE_SUPABASE_ANON_KEY=anon-local\n");
    writeFileSync(join(dir, ".env.production"), "SUPABASE_SERVICE_ROLE_KEY=prod-secret\n");
    const s = tpl.supabaseSettings({ SUPABASE_SERVICE_ROLE_KEY: "env-secret" }, dir, () => ({}));
    expect(s).toEqual({ url: "http://127.0.0.1:54321", anonKey: "anon-local", secretKey: "env-secret" });
  });

  it("falls back to `supabase status` for what the app doesn't set", () => {
    const dir = tmpDir();
    writeFileSync(join(dir, ".env"), "NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321\n");
    const s = tpl.supabaseSettings({}, dir, () => ({ API_URL: "http://127.0.0.1:9999", PUBLISHABLE_KEY: "sb_publishable_x", SECRET_KEY: "sb_secret_x" }));
    expect(s).toEqual({ url: "http://127.0.0.1:54321", anonKey: "sb_publishable_x", secretKey: "sb_secret_x" });
  });

  it("names what's missing and never reads production files", () => {
    const dir = tmpDir();
    writeFileSync(join(dir, ".env.production"), "NEXT_PUBLIC_SUPABASE_URL=https://x.supabase.co\nSUPABASE_SERVICE_ROLE_KEY=prod\n");
    expect(() => tpl.supabaseSettings({}, dir, () => ({}))).toThrow(/API URL.*publishable key.*secret key.*never reads \.env\.production/s);
  });
});

describe("supabaseStatus", () => {
  it("parses `supabase status -o env` and tries the PATH CLI when the project has none", () => {
    const calls: string[] = [];
    const run = (cmd: string) => {
      calls.push(cmd);
      if (cmd === "npx") throw new Error("not installed");
      return 'API_URL="http://127.0.0.1:54321"\nSERVICE_ROLE_KEY="eyJsecret"\nANON_KEY="eyJanon"\n';
    };
    expect(tpl.supabaseStatus("/nowhere", run)).toMatchObject({ API_URL: "http://127.0.0.1:54321", SERVICE_ROLE_KEY: "eyJsecret" });
    expect(calls).toEqual(["npx", "supabase"]);
    expect(tpl.supabaseStatus("/nowhere", () => { throw new Error("no stack"); })).toEqual({});
  });
});

describe("refusals", () => {
  it("refuses a hosted Supabase project or a remote app before calling anything", async () => {
    const env = { NEXT_PUBLIC_SUPABASE_URL: "https://abcdefgh.supabase.co", NEXT_PUBLIC_SUPABASE_ANON_KEY: "a", SUPABASE_SERVICE_ROLE_KEY: "s" };
    const page = { goto: () => { throw new Error("should not navigate"); } };
    const context = { addCookies: () => { throw new Error("should not set cookies"); } };
    await expect(tpl.default({ page, context, baseUrl: "http://localhost:3000", persona: { role: "admin", email: "pat@example.com" }, env })).rejects.toThrow(
      /Supabase API is on abcdefgh\.supabase\.co/,
    );
    await expect(tpl.default({ page, context, baseUrl: "https://app.example.com", persona: { role: "admin" }, env })).rejects.toThrow(/app is on app\.example\.com/);
  });

  it("does nothing for a walkthrough without a persona", async () => {
    await expect(tpl.default({ page: {}, context: {}, baseUrl: "https://app.example.com", env: {} })).resolves.toBeUndefined();
  });
});

describe("writeSupabaseSignIn", () => {
  it("writes the adapter pointing at the app, and never overwrites it", async () => {
    const root = tmpDir();
    const help = join(root, "help");
    const r = writeSupabaseSignIn(help, root);
    expect(r.written).toBe(true);
    expect(readFileSync(r.file, "utf8")).not.toContain("__APP_DIR__");
    expect((await import(r.file)).APP_DIR).toBe(root);
    writeFileSync(r.file, "// mine\n");
    expect(writeSupabaseSignIn(help, root).written).toBe(false);
  });
});

describe("signing in", () => {
  it("redeems a sign-in link for an existing user and puts the session in cookies and localStorage", async () => {
    const SECRET = "sb_secret_local";
    const ANON = "sb_publishable_local";
    const calls: string[] = [];
    const supabaseUrl = await listen((req, res, body) => {
      const url = new URL(req.url!, "http://x");
      calls.push(`${req.method} ${url.pathname}`);
      const key = req.headers.apikey;
      if (url.pathname === "/auth/v1/admin/users" && key === SECRET) {
        return json(res, 200, { users: [{ id: "u0", email: "someone@example.com" }, { id: "u1", email: "Pat@Example.com" }] });
      }
      if (url.pathname === "/auth/v1/admin/generate_link" && key === SECRET) {
        expect(JSON.parse(body)).toEqual({ type: "magiclink", email: "Pat@Example.com" });
        return json(res, 200, { id: "u1", email: "Pat@Example.com", hashed_token: "hash-1", action_link: "http://x" });
      }
      if (url.pathname === "/auth/v1/verify" && key === ANON) {
        const b = JSON.parse(body);
        if (b.type !== "email") return json(res, 400, { msg: "bad type" });
        expect(b.token_hash).toBe("hash-1");
        return json(res, 200, { access_token: "access-1", refresh_token: "refresh-1", expires_in: 3600, token_type: "bearer", user: { id: "u1", email: "pat@example.com" } });
      }
      if (url.pathname === "/auth/v1/user" && key === ANON && req.headers.authorization === "Bearer access-1") {
        return json(res, 200, { id: "u1", email: "pat@example.com" });
      }
      json(res, 401, { msg: "unexpected request" });
    });
    const appUrl = await listen((_req, res) => {
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<!doctype html><title>Acme</title><p>Sign in</p>");
    });

    const root = tmpDir();
    const { file } = writeSupabaseSignIn(join(root, "help"), root);
    const adapter = (await import(file)).default;
    const env = { NEXT_PUBLIC_SUPABASE_URL: supabaseUrl, NEXT_PUBLIC_SUPABASE_ANON_KEY: ANON, SUPABASE_SECRET_KEY: SECRET };

    const browser = await chromium.launch();
    try {
      const context = await browser.newContext();
      const page = await context.newPage();
      await adapter({ page, context, baseUrl: appUrl, persona: { role: "admin", email: "pat@example.com" }, env });

      expect(calls).toEqual(["GET /auth/v1/admin/users", "POST /auth/v1/admin/generate_link", "POST /auth/v1/verify", "GET /auth/v1/user"]);
      const key = "sb-127-auth-token";
      const session = readSsrCookie(await context.cookies(appUrl), key) as Record<string, unknown>;
      expect(session).toMatchObject({ access_token: "access-1", refresh_token: "refresh-1", user: { id: "u1" } });
      expect(typeof session.expires_at).toBe("number");

      // Kept in the saved sign-in state capture reuses for the next walkthroughs.
      const state = await context.storageState();
      const stored = state.origins.find((o) => o.origin === appUrl)?.localStorage.find((e) => e.name === key);
      expect(JSON.parse(stored!.value)).toEqual(session);
    } finally {
      await browser.close();
    }
  }, 60_000);

  it("refuses a persona with no user in the local stack, without making one", async () => {
    const calls: string[] = [];
    const supabaseUrl = await listen((req, res) => {
      calls.push(new URL(req.url!, "http://x").pathname);
      json(res, 200, { users: [] });
    });
    const env = { SUPABASE_URL: supabaseUrl, SUPABASE_ANON_KEY: "a", SUPABASE_SERVICE_ROLE_KEY: "s" };
    await expect(
      tpl.default({ page: {}, context: {}, baseUrl: "http://localhost:3000", persona: { role: "admin", email: "nobody@example.com" }, env }),
    ).rejects.toThrow(/no user nobody@example\.com in the local Supabase stack/);
    expect(calls).toEqual(["/auth/v1/admin/users"]);
  });
});
