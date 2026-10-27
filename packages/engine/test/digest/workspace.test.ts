import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { countRoutesForApp, findWorkspaceNextApps } from "../../src/digest/workspace.js";

const createdDirs: string[] = [];

function tmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "aida-workspace-test-"));
  createdDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (createdDirs.length > 0) {
    rmSync(createdDirs.pop()!, { recursive: true, force: true });
  }
});

function writeNextApp(dir: string, routeCount: number): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ dependencies: { next: "15.0.0" } }));
  for (let i = 0; i < routeCount; i++) {
    const routeDir = join(dir, "app", `r${i}`);
    mkdirSync(routeDir, { recursive: true });
    writeFileSync(join(routeDir, "page.tsx"), "export default function Page() { return null; }");
  }
}

describe("findWorkspaceNextApps", () => {
  it("finds a single Next.js app under apps/* declared in pnpm-workspace.yaml", () => {
    const repo = tmpDir();
    writeFileSync(join(repo, "pnpm-workspace.yaml"), "packages:\n  - apps/*\n  - packages/*\n");
    writeNextApp(join(repo, "apps", "web"), 3);
    mkdirSync(join(repo, "packages", "ui"), { recursive: true });
    writeFileSync(join(repo, "packages", "ui", "package.json"), JSON.stringify({ name: "@x/ui" }));

    const apps = findWorkspaceNextApps(repo);
    expect(apps).toEqual([join(repo, "apps", "web")]);
  });

  it("finds several Next.js apps and reports a route count for each", () => {
    const repo = tmpDir();
    writeFileSync(join(repo, "pnpm-workspace.yaml"), "packages:\n  - apps/*\n");
    writeNextApp(join(repo, "apps", "web"), 4);
    writeNextApp(join(repo, "apps", "docs"), 2);

    const apps = findWorkspaceNextApps(repo);
    expect(apps.sort()).toEqual([join(repo, "apps", "docs"), join(repo, "apps", "web")].sort());
    expect(countRoutesForApp(join(repo, "apps", "web"))).toBe(4);
    expect(countRoutesForApp(join(repo, "apps", "docs"))).toBe(2);
  });

  it("detects workspaces from package.json#workspaces when there's no pnpm-workspace.yaml", () => {
    const repo = tmpDir();
    writeFileSync(join(repo, "package.json"), JSON.stringify({ name: "root", workspaces: ["apps/*"] }));
    writeNextApp(join(repo, "apps", "web"), 1);

    expect(findWorkspaceNextApps(repo)).toEqual([join(repo, "apps", "web")]);
  });

  it("returns nothing for a plain non-workspace repo", () => {
    const repo = tmpDir();
    writeFileSync(join(repo, "package.json"), JSON.stringify({ name: "root" }));
    expect(findWorkspaceNextApps(repo)).toEqual([]);
  });
});
