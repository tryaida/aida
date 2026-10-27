import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { computeAffected } from "../../src/impact/compute.js";
import type { ResolvedConfig } from "../../src/config/types.js";

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
  const repo = tmpDir("aida-impact-compute-app-");
  git(repo, ["init", "-q"]);
  git(repo, ["config", "user.email", "test@example.com"]);
  git(repo, ["config", "user.name", "test"]);
  return repo;
}

function writeWalkthrough(dir: string, id: string, title = "Title"): void {
  writeFileSync(
    join(dir, `${id}.yaml`),
    `walkthrough: ${id}\nversion: 1\ntitle: ${title}\nsteps:\n  - id: step1\n    title: Step one\n`,
  );
}

function writeManifest(buildDir: string, id: string, steps: { id: string; urls?: string[]; requests?: { method: string; path: string }[] }[]): void {
  const dir = join(buildDir, id, "capture");
  mkdirSync(dir, { recursive: true });
  const manifest = {
    workflow: id,
    baseUrl: "http://localhost:3000",
    viewport: { width: 1440, height: 810 },
    deviceScaleFactor: 1,
    steps: steps.map((s) => ({
      id: s.id,
      camera: "full",
      cameraBox: null,
      events: [],
      doc: { image: null, highlights: [] },
      impact: { urls: s.urls ?? [], requests: s.requests ?? [] },
      checks: [],
    })),
  };
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest, null, 2));
}

function baseConfig(walkthroughsDir: string, buildDir: string): ResolvedConfig {
  return {
    app: { baseUrl: "http://localhost:3000" },
    configDir: walkthroughsDir,
    walkthroughsDir,
    outDir: tmpdir(),
    buildDir,
    viewport: { width: 1440, height: 810 },
    deviceScaleFactor: 1,
  };
}

describe("computeAffected", () => {
  it("marks a walkthrough affected when a changed route's step recorded that URL", async () => {
    const repo = initAppRepo();
    mkdirSync(join(repo, "app", "teams", "[id]"), { recursive: true });
    writeFileSync(join(repo, "app", "teams", "[id]", "page.tsx"), "export default function Page() { return null; }");
    mkdirSync(join(repo, "app", "other"), { recursive: true });
    writeFileSync(join(repo, "app", "other", "page.tsx"), "export default function Page() { return null; }");
    commitAll(repo, "init");
    git(repo, ["tag", "base"]);

    // Change only the teams/[id] page.
    writeFileSync(join(repo, "app", "teams", "[id]", "page.tsx"), "export default function Page() { return <div/>; }");
    commitAll(repo, "edit teams page");

    const walkthroughsDir = tmpDir("aida-impact-compute-wt-");
    const buildDir = tmpDir("aida-impact-compute-build-");
    writeWalkthrough(walkthroughsDir, "view-team");
    writeWalkthrough(walkthroughsDir, "view-other");
    writeManifest(buildDir, "view-team", [{ id: "s1", urls: ["/teams/42"] }]);
    writeManifest(buildDir, "view-other", [{ id: "s1", urls: ["/other"] }]);

    const result = await computeAffected({ appRepo: repo, base: "base", config: baseConfig(walkthroughsDir, buildDir) });

    expect(result.all).toBe(false);
    const viewTeam = result.walkthroughs.find((w) => w.id === "view-team")!;
    const viewOther = result.walkthroughs.find((w) => w.id === "view-other")!;
    expect(viewTeam.affected).toBe(true);
    expect(viewTeam.reasons[0]).toMatch(/teams\/\[id\]\/page\.tsx -> \/teams\/\[id\] -> step "s1"/);
    expect(viewOther.affected).toBe(false);
    expect(viewOther.reasons).toEqual([]);
  });

  it("marks a walkthrough affected when a changed API route's step recorded that request", async () => {
    const repo = initAppRepo();
    mkdirSync(join(repo, "app", "api", "teams", "[id]"), { recursive: true });
    writeFileSync(join(repo, "app", "api", "teams", "[id]", "route.ts"), "export async function PATCH() {}");
    // A second, unrelated route — without it this fixture is 100% of all routes, which trips the
    // "imported by too many routes" all-threshold regardless of the real per-route precision this
    // test means to check.
    mkdirSync(join(repo, "app", "other"), { recursive: true });
    writeFileSync(join(repo, "app", "other", "page.tsx"), "export default function Page() { return null; }");
    commitAll(repo, "init");
    git(repo, ["tag", "base"]);

    writeFileSync(join(repo, "app", "api", "teams", "[id]", "route.ts"), "export async function PATCH() { return 1; }");
    commitAll(repo, "edit api route");

    const walkthroughsDir = tmpDir("aida-impact-compute-wt-");
    const buildDir = tmpDir("aida-impact-compute-build-");
    writeWalkthrough(walkthroughsDir, "edit-team");
    writeManifest(buildDir, "edit-team", [{ id: "s1", requests: [{ method: "PATCH", path: "/api/teams/42" }] }]);

    const result = await computeAffected({ appRepo: repo, base: "base", config: baseConfig(walkthroughsDir, buildDir) });

    expect(result.all).toBe(false);
    const wt = result.walkthroughs.find((w) => w.id === "edit-team")!;
    expect(wt.affected).toBe(true);
    expect(wt.reasons[0]).toMatch(/PATCH \/api\/teams\/\[id\]/);
  });

  it("treats a walkthrough file change as affected regardless of route mapping", async () => {
    const repo = initAppRepo();
    // walkthroughsDir lives inside the app repo here, so its own git history can show the change —
    // in practice it's usually a separate aida-config repo, but computeAffected only compares
    // absolute paths, so this is an equivalent (and simpler) fixture.
    const walkthroughsDir = join(repo, "walkthroughs");
    mkdirSync(walkthroughsDir, { recursive: true });
    writeWalkthrough(walkthroughsDir, "view-team");
    commitAll(repo, "init");
    git(repo, ["tag", "base"]);

    writeFileSync(join(walkthroughsDir, "view-team.yaml"), "walkthrough: view-team\nversion: 1\ntitle: View team v2\nsteps:\n  - id: step1\n");
    commitAll(repo, "edit walkthrough");

    const buildDir = tmpDir("aida-impact-compute-build-");
    writeManifest(buildDir, "view-team", [{ id: "s1", urls: ["/teams/42"] }]);

    const result = await computeAffected({ appRepo: repo, base: "base", config: baseConfig(walkthroughsDir, buildDir) });
    const wt = result.walkthroughs.find((w) => w.id === "view-team")!;
    expect(wt.affected).toBe(true);
    expect(wt.reasons.some((r) => r.includes("walkthrough file changed"))).toBe(true);
  });

  it("falls back to affecting every walkthrough when a changed file matches an always-all pattern", async () => {
    const repo = initAppRepo();
    writeFileSync(join(repo, "package.json"), JSON.stringify({ name: "app" }));
    commitAll(repo, "init");
    git(repo, ["tag", "base"]);
    writeFileSync(join(repo, "package.json"), JSON.stringify({ name: "app", version: "2" }));
    commitAll(repo, "bump deps");

    const walkthroughsDir = tmpDir("aida-impact-compute-wt-");
    const buildDir = tmpDir("aida-impact-compute-build-");
    writeWalkthrough(walkthroughsDir, "view-team");
    writeManifest(buildDir, "view-team", [{ id: "s1", urls: ["/teams/42"] }]);

    const result = await computeAffected({ appRepo: repo, base: "base", config: baseConfig(walkthroughsDir, buildDir) });
    expect(result.all).toBe(true);
    expect(result.reason).toMatch(/package\.json/);
    expect(result.walkthroughs.every((w) => w.affected)).toBe(true);
  });

  it("falls back to affecting every walkthrough when a changed file maps to nothing known", async () => {
    const repo = initAppRepo();
    mkdirSync(join(repo, "app"), { recursive: true });
    writeFileSync(join(repo, "app", "mystery.ts"), "export const x = 1;");
    commitAll(repo, "init");
    git(repo, ["tag", "base"]);
    writeFileSync(join(repo, "app", "mystery.ts"), "export const x = 2;");
    commitAll(repo, "edit mystery file");

    const walkthroughsDir = tmpDir("aida-impact-compute-wt-");
    const buildDir = tmpDir("aida-impact-compute-build-");
    writeWalkthrough(walkthroughsDir, "view-team");
    writeManifest(buildDir, "view-team", [{ id: "s1", urls: ["/teams/42"] }]);

    const result = await computeAffected({ appRepo: repo, base: "base", config: baseConfig(walkthroughsDir, buildDir) });
    expect(result.all).toBe(true);
    expect(result.reason).toMatch(/mystery\.ts/);
  });

  it("maps a changed shared component to only the routes that import it, via the import graph", async () => {
    const repo = initAppRepo();
    mkdirSync(join(repo, "components"), { recursive: true });
    writeFileSync(join(repo, "components", "roster.tsx"), "export const Roster = () => null;");
    mkdirSync(join(repo, "app", "teams"), { recursive: true });
    writeFileSync(
      join(repo, "app", "teams", "page.tsx"),
      'import { Roster } from "../../components/roster";\nexport default function Page() { return null; }',
    );
    mkdirSync(join(repo, "app", "other"), { recursive: true });
    writeFileSync(join(repo, "app", "other", "page.tsx"), "export default function Page() { return null; }");
    commitAll(repo, "init");
    git(repo, ["tag", "base"]);

    writeFileSync(join(repo, "components", "roster.tsx"), "export const Roster = () => 'v2';");
    commitAll(repo, "edit shared component");

    const walkthroughsDir = tmpDir("aida-impact-compute-wt-");
    const buildDir = tmpDir("aida-impact-compute-build-");
    writeWalkthrough(walkthroughsDir, "view-teams");
    writeWalkthrough(walkthroughsDir, "view-other");
    writeManifest(buildDir, "view-teams", [{ id: "s1", urls: ["/teams"] }]);
    writeManifest(buildDir, "view-other", [{ id: "s1", urls: ["/other"] }]);

    const result = await computeAffected({ appRepo: repo, base: "base", config: baseConfig(walkthroughsDir, buildDir) });

    expect(result.all).toBe(false); // 1 of 2 routes (50%) — under the default 60% threshold
    const viewTeams = result.walkthroughs.find((w) => w.id === "view-teams")!;
    const viewOther = result.walkthroughs.find((w) => w.id === "view-other")!;
    expect(viewTeams.affected).toBe(true);
    expect(viewTeams.reasons[0]).toMatch(/components\/roster\.tsx -> \/teams/);
    expect(viewOther.affected).toBe(false);
  });

  it("treats a file imported by more than the all-threshold of routes as affecting everything", async () => {
    const repo = initAppRepo();
    mkdirSync(join(repo, "lib"), { recursive: true });
    writeFileSync(join(repo, "lib", "widely-shared.ts"), "export const helper = () => 1;");
    for (const name of ["a", "b", "c"]) {
      mkdirSync(join(repo, "app", name), { recursive: true });
      writeFileSync(
        join(repo, "app", name, "page.tsx"),
        'import { helper } from "../../lib/widely-shared";\nexport default function Page() { return null; }',
      );
    }
    // A fourth route that doesn't import it — 3/4 = 75%, over the default 60% threshold.
    mkdirSync(join(repo, "app", "d"), { recursive: true });
    writeFileSync(join(repo, "app", "d", "page.tsx"), "export default function Page() { return null; }");
    commitAll(repo, "init");
    git(repo, ["tag", "base"]);

    writeFileSync(join(repo, "lib", "widely-shared.ts"), "export const helper = () => 2;");
    commitAll(repo, "edit widely shared helper");

    const walkthroughsDir = tmpDir("aida-impact-compute-wt-");
    const buildDir = tmpDir("aida-impact-compute-build-");
    writeWalkthrough(walkthroughsDir, "wt");
    writeManifest(buildDir, "wt", [{ id: "s1", urls: ["/a"] }]);

    const result = await computeAffected({ appRepo: repo, base: "base", config: baseConfig(walkthroughsDir, buildDir) });
    expect(result.all).toBe(true);
    expect(result.reason).toMatch(/3\/4 routes/);
  });

  it("treats a changed /login page as affecting every walkthrough when a sign-in adapter is configured", async () => {
    const repo = initAppRepo();
    mkdirSync(join(repo, "app", "login"), { recursive: true });
    writeFileSync(join(repo, "app", "login", "page.tsx"), "export default function Page() { return null; }");
    mkdirSync(join(repo, "app", "other"), { recursive: true });
    writeFileSync(join(repo, "app", "other", "page.tsx"), "export default function Page() { return null; }");
    commitAll(repo, "init");
    git(repo, ["tag", "base"]);

    writeFileSync(join(repo, "app", "login", "page.tsx"), "export default function Page() { return 'v2'; }");
    commitAll(repo, "edit login page");

    const walkthroughsDir = tmpDir("aida-impact-compute-wt-");
    const buildDir = tmpDir("aida-impact-compute-build-");
    writeWalkthrough(walkthroughsDir, "view-other");
    // No step ever records visiting /login (the adapter signs in before capture attaches).
    writeManifest(buildDir, "view-other", [{ id: "s1", urls: ["/other"] }]);

    const config = baseConfig(walkthroughsDir, buildDir);
    config.signIn = async () => {};

    const result = await computeAffected({ appRepo: repo, base: "base", config });
    expect(result.all).toBe(false);
    const wt = result.walkthroughs.find((w) => w.id === "view-other")!;
    expect(wt.affected).toBe(true);
    expect(wt.reasons[0]).toMatch(/sign-in page/);
  });

  it("does not affect any walkthrough for a changed /login page when no sign-in adapter is configured", async () => {
    const repo = initAppRepo();
    mkdirSync(join(repo, "app", "login"), { recursive: true });
    writeFileSync(join(repo, "app", "login", "page.tsx"), "export default function Page() { return null; }");
    mkdirSync(join(repo, "app", "other"), { recursive: true });
    writeFileSync(join(repo, "app", "other", "page.tsx"), "export default function Page() { return null; }");
    commitAll(repo, "init");
    git(repo, ["tag", "base"]);

    writeFileSync(join(repo, "app", "login", "page.tsx"), "export default function Page() { return 'v2'; }");
    commitAll(repo, "edit login page");

    const walkthroughsDir = tmpDir("aida-impact-compute-wt-");
    const buildDir = tmpDir("aida-impact-compute-build-");
    writeWalkthrough(walkthroughsDir, "view-other");
    writeManifest(buildDir, "view-other", [{ id: "s1", urls: ["/other"] }]);

    const result = await computeAffected({ appRepo: repo, base: "base", config: baseConfig(walkthroughsDir, buildDir) });
    expect(result.all).toBe(false);
    const wt = result.walkthroughs.find((w) => w.id === "view-other")!;
    expect(wt.affected).toBe(false);
  });

  it("marks a walkthrough with no capture manifest as always affected", async () => {
    const repo = initAppRepo();
    writeFileSync(join(repo, "README.md"), "hi");
    commitAll(repo, "init");
    git(repo, ["tag", "base"]);
    writeFileSync(join(repo, "README.md"), "hi there");
    commitAll(repo, "edit readme");

    const walkthroughsDir = tmpDir("aida-impact-compute-wt-");
    const buildDir = tmpDir("aida-impact-compute-build-");
    writeWalkthrough(walkthroughsDir, "never-captured");

    const result = await computeAffected({ appRepo: repo, base: "base", config: baseConfig(walkthroughsDir, buildDir) });
    const wt = result.walkthroughs.find((w) => w.id === "never-captured")!;
    expect(wt.affected).toBe(true);
    expect(wt.reasons[0]).toMatch(/no capture manifest/);
    // A doc-only change (README.md) is ignored, so this alone shouldn't force `all`.
    expect(result.all).toBe(false);
  });
});
