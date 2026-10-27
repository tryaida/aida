// Change tiers (docs/scope.md "Three kinds of change"; build-plan.md M19): tier classification
// is a pure function of status; "new" route detection is a deterministic git+route check, no
// model involved (decisions #22).
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { tierForStatus, getAddedFiles, findNewUncoveredRoutes, repairCommandFor, draftCommandFor, claudeRepairCommentFor, claudeDraftCommentFor } from "../../src/ci/tiers.js";
import type { WalkthroughEntry } from "../../src/impact/walkthroughs.js";

const createdDirs: string[] = [];

function tmpDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  createdDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (createdDirs.length > 0) {
    rmSync(createdDirs.pop()!, { recursive: true, force: true });
  }
});

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd });
}

function commitAll(repo: string, message: string): void {
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-q", "-m", message]);
}

function initAppRepo(): string {
  const repo = tmpDir("aida-ci-tiers-app-");
  git(repo, ["init", "-q"]);
  git(repo, ["config", "user.email", "test@example.com"]);
  git(repo, ["config", "user.name", "test"]);
  return repo;
}

describe("tierForStatus", () => {
  it("maps failed capture to broken", () => {
    expect(tierForStatus("failed")).toBe("broken");
  });

  it("maps every other status to cosmetic (no action needed, publishes on merge)", () => {
    expect(tierForStatus("unchanged")).toBe("cosmetic");
    expect(tierForStatus("changed")).toBe("cosmetic");
    expect(tierForStatus("new")).toBe("cosmetic");
  });
});

describe("repairCommandFor / draftCommandFor / claude comment shortcuts", () => {
  it("builds an exact aida-repair command naming the CI failure report path", () => {
    const cmd = repairCommandFor("add-entry", "help/aida.config.ts");
    expect(cmd).toContain("aida-repair skill");
    expect(cmd).toContain("'add-entry'");
    expect(cmd).toContain("--config help/aida.config.ts");
    expect(cmd).toContain(".build/add-entry/ci/capture/failure.json");
  });

  it("builds an exact aida-write command naming the uncovered route and the docs:new label", () => {
    const cmd = draftCommandFor({ path: "/dashboard/sponsors", file: "app/dashboard/sponsors/page.tsx", dynamic: false }, "help/aida.config.ts");
    expect(cmd).toContain("aida-write skill");
    expect(cmd).toContain("/dashboard/sponsors");
    expect(cmd).toContain("docs:new");
  });

  it("builds short @claude comment shortcuts", () => {
    expect(claudeRepairCommentFor("add-entry")).toBe('@claude load the aida-repair skill and fix the "add-entry" walkthrough');
    expect(claudeDraftCommentFor({ path: "/dashboard/sponsors" })).toContain("/dashboard/sponsors");
  });
});

describe("getAddedFiles", () => {
  it("lists only added files, not modified ones", () => {
    const repo = initAppRepo();
    writeFileSync(join(repo, "a.txt"), "1");
    commitAll(repo, "init");
    git(repo, ["tag", "base"]);

    writeFileSync(join(repo, "a.txt"), "2"); // modified
    writeFileSync(join(repo, "b.txt"), "new"); // added
    commitAll(repo, "edit + add");

    const added = getAddedFiles(repo, "base");
    expect(added).toEqual(["b.txt"]);
  });
});

describe("findNewUncoveredRoutes", () => {
  it("flags a newly added page route that no walkthrough's manifest visits", () => {
    const repo = initAppRepo();
    mkdirSync(join(repo, "app", "other"), { recursive: true });
    writeFileSync(join(repo, "app", "other", "page.tsx"), "export default function Page() { return null; }");
    commitAll(repo, "init");
    git(repo, ["tag", "base"]);

    mkdirSync(join(repo, "app", "sponsors"), { recursive: true });
    writeFileSync(join(repo, "app", "sponsors", "page.tsx"), "export default function Page() { return null; }");
    commitAll(repo, "add sponsors page");

    const walkthroughs: WalkthroughEntry[] = [
      { id: "view-other", file: "/tmp/view-other.yaml", manifest: { workflow: "view-other", baseUrl: "http://localhost:3000", viewport: { width: 1440, height: 810 }, deviceScaleFactor: 1, steps: [{ id: "s1", camera: "full", cameraBox: null, events: [], doc: { image: null, highlights: [] }, impact: { urls: ["/other"], requests: [] }, checks: [] }] } as never },
    ];

    const result = findNewUncoveredRoutes({ appRepo: repo, base: "base", routes: [{ path: "/sponsors", file: "app/sponsors/page.tsx", dynamic: false }, { path: "/other", file: "app/other/page.tsx", dynamic: false }], walkthroughs, configPath: "help/aida.config.ts" });

    expect(result).toHaveLength(1);
    expect(result[0].path).toBe("/sponsors");
    expect(result[0].draftCommand).toContain("/sponsors");
  });

  it("doesn't flag a new route a walkthrough already visits", () => {
    const repo = initAppRepo();
    writeFileSync(join(repo, "README.md"), "hi");
    commitAll(repo, "init");
    git(repo, ["tag", "base"]);

    mkdirSync(join(repo, "app", "sponsors"), { recursive: true });
    writeFileSync(join(repo, "app", "sponsors", "page.tsx"), "export default function Page() { return null; }");
    commitAll(repo, "add sponsors page");

    const walkthroughs: WalkthroughEntry[] = [
      { id: "view-sponsors", file: "/tmp/view-sponsors.yaml", manifest: { workflow: "view-sponsors", baseUrl: "http://localhost:3000", viewport: { width: 1440, height: 810 }, deviceScaleFactor: 1, steps: [{ id: "s1", camera: "full", cameraBox: null, events: [], doc: { image: null, highlights: [] }, impact: { urls: ["/sponsors"], requests: [] }, checks: [] }] } as never },
    ];

    const result = findNewUncoveredRoutes({ appRepo: repo, base: "base", routes: [{ path: "/sponsors", file: "app/sponsors/page.tsx", dynamic: false }], walkthroughs, configPath: "help/aida.config.ts" });

    expect(result).toEqual([]);
  });

  it("doesn't flag a route that already existed before the diff (modified, not added)", () => {
    const repo = initAppRepo();
    mkdirSync(join(repo, "app", "sponsors"), { recursive: true });
    writeFileSync(join(repo, "app", "sponsors", "page.tsx"), "export default function Page() { return null; }");
    commitAll(repo, "init");
    git(repo, ["tag", "base"]);

    writeFileSync(join(repo, "app", "sponsors", "page.tsx"), "export default function Page() { return <div/>; }");
    commitAll(repo, "edit sponsors page");

    const result = findNewUncoveredRoutes({ appRepo: repo, base: "base", routes: [{ path: "/sponsors", file: "app/sponsors/page.tsx", dynamic: false }], walkthroughs: [], configPath: "help/aida.config.ts" });

    expect(result).toEqual([]);
  });
});
