import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildDigest, formatDigest } from "../../src/digest/index.js";

const createdDirs: string[] = [];

function tmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "aida-digest-monorepo-test-"));
  createdDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (createdDirs.length > 0) {
    rmSync(createdDirs.pop()!, { recursive: true, force: true });
  }
});

function writeNextApp(dir: string, routeCount: number, groups = 1): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ dependencies: { next: "15.0.0" } }));
  for (let i = 0; i < routeCount; i++) {
    const group = `area${i % groups}`;
    const routeDir = join(dir, "app", group, `r${i}`);
    mkdirSync(routeDir, { recursive: true });
    writeFileSync(join(routeDir, "page.tsx"), "export default function Page() { return null; }");
  }
}

describe("buildDigest — workspace monorepo", () => {
  it("auto-resolves a monorepo with exactly one Next.js app", () => {
    const repo = tmpDir();
    writeFileSync(join(repo, "pnpm-workspace.yaml"), "packages:\n  - apps/*\n");
    writeNextApp(join(repo, "apps", "web"), 5);

    const result = buildDigest(repo);
    expect(result.framework).toBe("nextjs-app");
    expect(result.routes.length).toBe(5);
    expect(result.apps).toBeUndefined();
  });

  it("lists candidates and a short message when several apps are found, with no --app given", () => {
    const repo = tmpDir();
    writeFileSync(join(repo, "pnpm-workspace.yaml"), "packages:\n  - apps/*\n");
    writeNextApp(join(repo, "apps", "web"), 7);
    writeNextApp(join(repo, "apps", "docs"), 2);

    const result = buildDigest(repo);
    expect(result.framework).toBe("unknown");
    expect(result.apps).toBeDefined();
    expect(result.apps!.map((a) => a.path).sort()).toEqual(["apps/docs", "apps/web"]);
    expect(result.message).toMatch(/--app/);

    const text = formatDigest(result);
    expect(text).toMatch(/--app/);
    expect(text).toMatch(/apps\/web \(7 routes\)/);
  });

  it("uses the given --app to resolve an otherwise-ambiguous monorepo", () => {
    const repo = tmpDir();
    writeFileSync(join(repo, "pnpm-workspace.yaml"), "packages:\n  - apps/*\n");
    writeNextApp(join(repo, "apps", "web"), 7);
    writeNextApp(join(repo, "apps", "docs"), 2);

    const result = buildDigest(repo, { app: "apps/web" });
    expect(result.framework).toBe("nextjs-app");
    expect(result.routes.length).toBe(7);
  });

  it("summarises by route group instead of truncating mid-list once a large app's routes exceed the cap", () => {
    const repo = tmpDir();
    writeFileSync(join(repo, "pnpm-workspace.yaml"), "packages:\n  - apps/*\n");
    writeNextApp(join(repo, "apps", "web"), 142, 12);

    const result = buildDigest(repo, { app: "apps/web" });
    expect(result.routes.length).toBe(142);

    // Within the default cap (200 lines), 142 one-line routes + header still fits — no grouping needed.
    const full = formatDigest(result);
    expect(result.truncated).toBe(false);
    expect(full.split("\n").length).toBeLessThanOrEqual(200);

    // A smaller cap (as a stand-in for a bigger app, or labels pushing most routes to two lines
    // each) must fall back to a per-route-group summary rather than a half-cut list.
    const capped = formatDigest(result, { maxLines: 50 });
    const lines = capped.split("\n");
    expect(lines.length).toBeLessThanOrEqual(50);
    expect(result.truncated).toBe(true);
    expect(capped).toMatch(/too many to list in full/);
    expect(capped).toMatch(/--area/);
    // every group should be summarised with a count, not individually listed
    expect(capped).toMatch(/area0: \d+ route\(s\)/);
  });
});
