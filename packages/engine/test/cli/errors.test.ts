// The CLI's top-level error handling: an error a command doesn't catch prints as a plain message.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..", "..", "..", "..");
const cliTs = join(repoRoot, "packages", "engine", "src", "cli.ts");
const tsxCli = join(repoRoot, "node_modules", "tsx", "dist", "cli.mjs");

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function projectWithBadWalkthrough(): string {
  const dir = mkdtempSync(join(tmpdir(), "aida-cli-errors-"));
  dirs.push(dir);
  writeFileSync(join(dir, "aida.config.mjs"), 'export default { app: { baseUrl: "http://localhost:3000" }, walkthroughsDir: "./walkthroughs" };\n');
  const wf = join(dir, "walkthroughs");
  mkdirSync(wf);
  writeFileSync(
    join(wf, "bad.yaml"),
    "walkthrough: bad\nversion: 1\ntitle: Bad\nstart:\n  page: /\nsteps:\n  - id: one\n    actions:\n      - do: point\n        target: { role: heading, level: 1 }\n",
  );
  return dir;
}

function run(cwd: string, env: Record<string, string> = {}) {
  return spawnSync(process.execPath, [tsxCli, cliTs, "build", "--config", join(cwd, "aida.config.mjs"), "--skip-capture"], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, AIDA_DEBUG: "", ...env },
  });
}

describe("uncaught command errors", () => {
  it("print one plain message and exit 1, with the stack only under AIDA_DEBUG", () => {
    const dir = projectWithBadWalkthrough();
    const plain = run(dir);
    expect(plain.status).toBe(1);
    expect(plain.stderr).toMatch(/error: .*bad\.yaml:\d+: Unrecognized key: "level"/);
    expect(plain.stderr).toContain("AIDA_DEBUG=1");
    expect(plain.stderr).not.toMatch(/\n\s+at /);

    const debug = run(dir, { AIDA_DEBUG: "1" });
    expect(debug.status).toBe(1);
    expect(debug.stderr).toMatch(/\n\s+at /);
  }, 60_000);
});
