// doctor's app-setup checks: a Next.js standalone build, the app answering on one spelling of
// this machine's address only, and real-looking emails in demo data.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  checkDemoEmails,
  checkLoopback,
  checkStandaloneOutput,
  findStandaloneOutput,
  isDemoEmailDomain,
  otherLoopback,
  runDoctor,
  sampleDemoEmails,
  setsStandaloneOutput,
} from "../../src/doctor/index.js";
import type { DoctorProbes } from "../../src/doctor/index.js";

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "aida-app-setup-"));
  dirs.push(d);
  return d;
}

describe("standalone output", () => {
  it("spots a literal or conditional standalone output, not a comment", () => {
    expect(setsStandaloneOutput(`export default { output: "standalone" }`)).toBe(true);
    expect(setsStandaloneOutput(`const c = {\n  output:\n    process.env.SELF === "true" ? "standalone" : undefined,\n}`)).toBe(true);
    expect(setsStandaloneOutput(`const c = { output: "export", other: "standalone" }`)).toBe(false);
    expect(setsStandaloneOutput(`const c = { output: process.env.SELF === "true" ? "standalone" : undefined }`)).toBe(true);
    expect(setsStandaloneOutput(`// output: "standalone"\nexport default {}`)).toBe(false);
    expect(setsStandaloneOutput(`export default { output: "export" }`)).toBe(false);
  });

  it("gives the server.js path inside a workspace, with the copy steps and the port", () => {
    const root = tmp();
    writeFileSync(join(root, "pnpm-lock.yaml"), "");
    const app = join(root, "apps", "web");
    mkdirSync(app, { recursive: true });
    writeFileSync(join(app, "next.config.ts"), `export default { output: "standalone" };`);
    const info = findStandaloneOutput(app);
    expect(info?.appPath).toBe("apps/web");
    const check = checkStandaloneOutput(app, info, "http://localhost:3210");
    expect(check).toMatchObject({ status: "warn", id: "next-standalone" });
    expect(check?.fix).toContain("node .next/standalone/apps/web/server.js");
    expect(check?.fix).toContain("cp -r .next/static .next/standalone/apps/web/.next/");
    expect(check?.fix).toContain("PORT=3210 HOSTNAME=localhost");
  });

  it("says nothing for a regular build", () => {
    const app = tmp();
    writeFileSync(join(app, "next.config.mjs"), `export default {};`);
    expect(findStandaloneOutput(app)).toBeUndefined();
    expect(checkStandaloneOutput(app, undefined)).toBeUndefined();
  });
});

describe("loopback address", () => {
  it("swaps localhost and 127.0.0.1 only", () => {
    expect(otherLoopback("http://localhost:3210")).toBe("http://127.0.0.1:3210");
    expect(otherLoopback("http://127.0.0.1:3000/app")).toBe("http://localhost:3000/app");
    expect(otherLoopback("https://app.example.com")).toBeUndefined();
  });

  it("warns when only the other spelling answers", () => {
    const check = checkLoopback("http://127.0.0.1:3210", { error: "TimeoutError" }, { url: "http://localhost:3210", result: { status: 200 } }, true);
    expect(check).toMatchObject({ status: "warn", id: "app-address" });
    expect(check?.fix).toMatch(/http:\/\/localhost:3210/);
    expect(check?.fix).toMatch(/HOSTNAME/);
  });

  it("is quiet when app.baseUrl works, or neither does", () => {
    expect(checkLoopback("http://localhost:3210", { status: 200 }, { url: "http://127.0.0.1:3210", result: { error: "TimeoutError" } })).toBeUndefined();
    expect(checkLoopback("http://localhost:3210", { error: "ECONNREFUSED" }, { url: "http://127.0.0.1:3210", result: { error: "ECONNREFUSED" } })).toBeUndefined();
  });
});

describe("demo emails", () => {
  it("knows the reserved example domains", () => {
    for (const d of ["example.com", "Example.org", "example.net", "acme.example", "mail.test", "x.invalid", "localhost", "a.example.com"]) expect(isDemoEmailDomain(d)).toBe(true);
    for (const d of ["gmail.com", "acme.co", "examples.com", "example.co"]) expect(isDemoEmailDomain(d)).toBe(false);
  });

  it("samples read-only and reports domains, never addresses", async () => {
    const sql: string[] = [];
    const adapter = {
      async query(q: string) {
        sql.push(q);
        if (q.includes("information_schema")) return [{ table_name: "users", column_name: "email" }, { table_name: "invites", column_name: "email" }];
        if (q.includes('from "users"')) return [{ domain: "gmail.com", n: 3 }, { domain: "example.com", n: 9 }];
        return [{ domain: "example.com", n: 4 }];
      },
    };
    const sample = await sampleDemoEmails(adapter, "postgres://localhost/demo");
    expect(sample).toEqual({ ok: true, columns: [{ table: "users", column: "email", domains: ["gmail.com"] }] });
    expect(sql.every((q) => /^\s*select\b/i.test(q))).toBe(true);
    const check = checkDemoEmails(sample);
    expect(check.status).toBe("warn");
    expect(check.detail).toContain("gmail.com");
    expect(check.detail).toContain("users.email");
    expect(check.detail).not.toContain("@");
    expect(check.fix).toContain(`update "users" set "email" = split_part("email", '@', 1) || '@example.com'`);
  });

  it("skips quietly when the database can't be sampled, or there's no adapter", async () => {
    const sample = await sampleDemoEmails({ query: async () => { throw new Error("no such table: information_schema.columns"); } }, "sqlite://x");
    expect(checkDemoEmails(sample).status).toBe("skip");
    expect(checkDemoEmails(undefined, "no database adapter in aida.config")).toMatchObject({ status: "skip", detail: "skipped: no database adapter in aida.config" });
    expect(checkDemoEmails({ ok: true, columns: [] }).status).toBe("ok");
  });

  it("runDoctor samples through the config's adapter when the database is local", async () => {
    const root = tmp();
    const help = join(root, "help");
    mkdirSync(help);
    writeFileSync(join(root, "package.json"), "{}");
    writeFileSync(join(root, ".env.local"), "DATABASE_URL=postgres://u:p@localhost:5432/demo\n");
    writeFileSync(
      join(help, "aida.config.mjs"),
      `export default { app: { baseUrl: "http://localhost:3000", dir: ".." }, walkthroughsDir: "./walkthroughs",
        database: { url: () => "postgres://u:p@localhost:5432/demo",
          query: async (q) => q.includes("information_schema") ? [{ table_name: "users", column_name: "email" }] : [{ domain: "acme.co", n: 2 }] } };`,
    );
    const probes: DoctorProbes = {
      nodeVersion: () => "22.5.0",
      platform: () => "linux",
      commandVersion: async (cmd) => `${cmd} version 8`,
      ffmpegStatic: async () => undefined,
      playwright: async () => ({ version: "1.64.1", chromiumPath: "/c", chromiumInstalled: true }),
      launchChromium: async () => ({ ok: true }),
      freeBytes: () => 40 * 1024 ** 3,
      dirSize: async () => undefined,
      fetchStatus: async (url) => (url.includes("127.0.0.1") ? { status: 200 } : { error: "TimeoutError" }),
      helpApp: (dir) => ({ dir, hasNodeModules: true }),
    };
    const result = await runDoctor({ cwd: root, probes, env: {} });
    const byId = Object.fromEntries(result.checks.map((c) => [c.id, c]));
    expect(byId["demo-emails"]).toMatchObject({ status: "warn" });
    expect(byId["demo-emails"].detail).toContain("acme.co");
    expect(byId["app-address"]).toMatchObject({ status: "warn" });
    expect(byId["app-address"].fix).toContain("http://127.0.0.1:3000");
  });
});
