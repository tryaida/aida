// CI installs the help app's own packages (init/help-install.ts) from its lockfile, and refuses a
// help app that would pull `aida` from the npm registry (decisions #29). The runner is faked.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { installHelpAppForCi, planHelpAppInstall } from "../../src/init/help-install.js";
import { fakeRunner } from "./fake-runner.js";

const createdDirs: string[] = [];
function tmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "aida-help-install-test-"));
  createdDirs.push(dir);
  return dir;
}
afterEach(() => {
  while (createdDirs.length > 0) rmSync(createdDirs.pop()!, { recursive: true, force: true });
});

function helpApp(aida: string, lock?: Record<string, { resolved?: string; link?: boolean }>): string {
  const dir = tmpDir();
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "help", dependencies: { aida, next: "16.4.2" } }));
  if (lock) writeFileSync(join(dir, "package-lock.json"), JSON.stringify({ lockfileVersion: 3, packages: { "": {}, ...lock } }));
  writeFileSync(join(dir, "aida.config.ts"), "export default {};\n");
  return dir;
}

const TARBALL = "file:vendor/aida-0.0.1-0123456789.tgz";

describe("planHelpAppInstall", () => {
  it("uses npm ci with a lockfile and npm install without one", () => {
    expect(planHelpAppInstall(helpApp(TARBALL, { "node_modules/aida": { resolved: TARBALL } }))).toMatchObject({ action: "install", args: ["ci", "--no-audit", "--no-fund"] });
    expect(planHelpAppInstall(helpApp(TARBALL))).toMatchObject({ action: "install", args: ["install", "--no-audit", "--no-fund"] });
  });

  it("skips a folder with no package.json", () => {
    expect(planHelpAppInstall(tmpDir())).toMatchObject({ action: "skip" });
  });

  it("refuses a registry aida in package.json or the lockfile", () => {
    expect(planHelpAppInstall(helpApp("*"))).toMatchObject({ action: "refuse", reason: expect.stringMatching(/registry/) });
    expect(planHelpAppInstall(helpApp("^0.0.1"))).toMatchObject({ action: "refuse" });
    const registry = { resolved: "https://registry.npmjs.org/aida/-/aida-1.0.0.tgz" };
    expect(planHelpAppInstall(helpApp(TARBALL, { "node_modules/aida": registry }))).toMatchObject({ action: "refuse" });
    // A transitive aida pulled from the registry by another package is refused too.
    expect(planHelpAppInstall(helpApp(TARBALL, { "node_modules/aida": { resolved: TARBALL }, "node_modules/x/node_modules/aida": registry }))).toMatchObject({ action: "refuse" });
    expect(planHelpAppInstall(helpApp(TARBALL, { "node_modules/aida": {} }))).toMatchObject({ action: "refuse" });
  });
});

describe("installHelpAppForCi", () => {
  it("runs the install in the config's folder, and throws on a refusal without running npm", () => {
    const help = helpApp(TARBALL, { "node_modules/aida": { resolved: TARBALL } });
    const f = fakeRunner(tmpDir());
    installHelpAppForCi(join(help, "aida.config.ts"), f.run);
    expect(f.calls).toEqual([{ command: "npm", args: ["ci", "--no-audit", "--no-fund"], opts: { cwd: help, output: "stream" } }]);

    const bad = helpApp("*");
    const g = fakeRunner(tmpDir());
    expect(() => installHelpAppForCi(join(bad, "aida.config.ts"), g.run)).toThrow(/aida init/);
    expect(g.calls).toEqual([]);
  });

  it("reports a failed install", () => {
    const help = helpApp(TARBALL);
    const f = fakeRunner(tmpDir(), { failOn: "install" });
    expect(() => installHelpAppForCi(join(help, "aida.config.ts"), f.run)).toThrow(/npm install .*failed/);
  });
});
