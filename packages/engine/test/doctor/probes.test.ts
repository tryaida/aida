// realProbes exercised against real local servers and a real filesystem (no network beyond
// 127.0.0.1): the pure checks in checks.test.ts cover the decision logic, this covers the probes
// that feed them — the first-request timeout (docs: a `next dev` server compiles on request, 4.7
// s observed), a fast failure when nothing is listening, and the help-app `aida` resolution
// through hoisted/workspace `node_modules`.
import { createServer } from "node:http";
import type { Server } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { realProbes } from "../../src/doctor/index.js";

const dirs: string[] = [];
const servers: Server[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
  while (servers.length) servers.pop()!.close();
});

function listen(server: Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve((server.address() as { port: number }).port));
  });
}

describe("realProbes.fetchStatus", () => {
  it("counts any HTTP response as reachable, even a 5xx", async () => {
    const server = createServer((_req, res) => {
      res.statusCode = 503;
      res.end("not ready");
    });
    servers.push(server);
    const port = await listen(server);
    const result = await realProbes.fetchStatus(`http://127.0.0.1:${port}`, 5000);
    expect(result).toEqual({ status: 503 });
  });

  it("waits out a slow first response instead of giving up early", async () => {
    const server = createServer((_req, res) => {
      setTimeout(() => res.end("ok"), 150);
    });
    servers.push(server);
    const port = await listen(server);
    const started = Date.now();
    const result = await realProbes.fetchStatus(`http://127.0.0.1:${port}`, 5000);
    expect(result).toEqual({ status: 200 });
    expect(Date.now() - started).toBeGreaterThanOrEqual(140);
  });

  it("times out with a named error when nothing answers in time", async () => {
    const server = createServer(() => {
      // never responds
    });
    servers.push(server);
    const port = await listen(server);
    const result = await realProbes.fetchStatus(`http://127.0.0.1:${port}`, 100);
    expect(result).toEqual({ error: "TimeoutError" });
  });

  it("fails fast on a connection refused, well under the timeout budget", async () => {
    // A port nothing is listening on, so the OS refuses the connection immediately.
    const server = createServer(() => undefined);
    const port = await listen(server);
    await new Promise<void>((resolve) => server.close(() => resolve()));

    const started = Date.now();
    const result = await realProbes.fetchStatus(`http://127.0.0.1:${port}`, 20_000);
    expect(result).toMatchObject({ error: expect.stringMatching(/ECONNREFUSED/) });
    expect(Date.now() - started).toBeLessThan(2000);
  });
});

describe("realProbes.helpApp", () => {
  it("resolves aida through a hoisted/workspace node_modules above the help app dir, not just <dir>/node_modules", () => {
    const root = mkdtempSync(join(tmpdir(), "aida-helpapp-"));
    dirs.push(root);
    const helpDir = join(root, "examples", "acme", "site", "help");
    mkdirSync(helpDir, { recursive: true });
    mkdirSync(join(helpDir, "node_modules"), { recursive: true }); // present, but no aida in it

    const aidaDir = join(root, "node_modules", "aida");
    mkdirSync(join(aidaDir, "dist"), { recursive: true });
    writeFileSync(
      join(aidaDir, "package.json"),
      JSON.stringify({ name: "aida", description: "aida engine: capture, voice...", main: "dist/index.js", aidaRuntime: true }),
    );
    writeFileSync(join(aidaDir, "dist", "index.js"), "export default {};");

    const info = realProbes.helpApp(helpDir);
    expect(info.hasNodeModules).toBe(true);
    expect(info.aidaPackagePath).toBe(join(aidaDir, "package.json"));
    expect(info.aidaPackage?.aidaRuntime).toBe(true);
    expect(info.aidaMainExists).toBe(true);
  });

  it("reports unresolved when aida isn't installed anywhere Node would look", () => {
    const root = mkdtempSync(join(tmpdir(), "aida-helpapp-"));
    dirs.push(root);
    const helpDir = join(root, "help");
    mkdirSync(helpDir, { recursive: true });

    const info = realProbes.helpApp(helpDir);
    expect(info.aidaPackagePath).toBeUndefined();
    expect(info.aidaPackage).toBeUndefined();
  });

  it("flags an unrelated npm package that happens to be named aida", () => {
    const root = mkdtempSync(join(tmpdir(), "aida-helpapp-"));
    dirs.push(root);
    const helpDir = join(root, "help");
    mkdirSync(join(helpDir, "node_modules", "aida"), { recursive: true });
    writeFileSync(
      join(helpDir, "node_modules", "aida", "package.json"),
      JSON.stringify({ name: "aida", description: "Generate docs from source comments", main: "index.js" }),
    );

    const info = realProbes.helpApp(helpDir);
    expect(info.aidaPackagePath).toBe(join(helpDir, "node_modules", "aida", "package.json"));
    expect(info.aidaPackage?.description).toMatch(/Generate docs/);
  });
});
