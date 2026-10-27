// Verifies the "separate docs repo" setup (build-plan.md M19 item 3; `aida init --ci
// --docs-repo <owner/repo>`) actually works end to end at the engine level: the aida config,
// walkthroughs and baseline screenshots can live in a completely different git repo/directory
// from the app being documented — exactly what the generated workflow's `.aida-docs` checkout
// produces — and `aida ci`'s pieces (config loading, the impact map, the baseline source)
// still resolve correctly when pointed across that split with two independent temp git repos.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config/index.js";
import { computeAffected } from "../../src/impact/index.js";
import { diskBaselineSource } from "../../src/ci/baseline.js";

// Absolute file:// URL to the real define.ts — the fixture config file lives in a throwaway tmp
// dir far from the repo, so a relative import specifier can't reach it.
const defineConfigModuleUrl = new URL("../../src/config/define.ts", import.meta.url).href;

const createdDirs: string[] = [];
function tmpDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  createdDirs.push(dir);
  return dir;
}
afterEach(() => {
  while (createdDirs.length > 0) rmSync(createdDirs.pop()!, { recursive: true, force: true });
});

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd });
}
function commitAll(repo: string, message: string): void {
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-q", "-m", message]);
}
function initRepo(prefix: string): string {
  const repo = tmpDir(prefix);
  git(repo, ["init", "-q"]);
  git(repo, ["config", "user.email", "test@example.com"]);
  git(repo, ["config", "user.name", "test"]);
  return repo;
}

describe("separate docs repo: config/baselines resolve from the docs checkout, not the app repo", () => {
  it("loads config, maps the app diff, and reads the baseline screenshot all from the docs repo's own checkout", async () => {
    // Repo 1: the app being documented (what the push/PR actually changes).
    const appRepo = initRepo("aida-docsrepo-app-");
    mkdirSync(join(appRepo, "app", "sponsors"), { recursive: true });
    writeFileSync(join(appRepo, "app", "sponsors", "page.tsx"), "export default function Page() { return null; }");
    mkdirSync(join(appRepo, "app", "other"), { recursive: true });
    writeFileSync(join(appRepo, "app", "other", "page.tsx"), "export default function Page() { return null; }");
    commitAll(appRepo, "init");
    git(appRepo, ["tag", "base"]);
    writeFileSync(join(appRepo, "app", "sponsors", "page.tsx"), "export default function Page() { return <div/>; }");
    commitAll(appRepo, "edit sponsors page");

    // Repo 2: the separate docs repo — what `.aida-docs` would be after the workflow's own
    // checkout step. Config, walkthroughs, manifest and the published baseline screenshot all
    // live here, nowhere near appRepo on disk.
    const docsRepo = initRepo("aida-docsrepo-docs-");
    const helpDir = join(docsRepo, "help");
    const walkthroughsDir = join(helpDir, "walkthroughs");
    const buildDir = join(helpDir, ".build");
    mkdirSync(walkthroughsDir, { recursive: true });
    writeFileSync(join(walkthroughsDir, "view-sponsors.yaml"), "walkthrough: view-sponsors\nversion: 1\ntitle: View sponsors\nsteps:\n  - id: step1\n    title: Step one\n");

    const manifestDir = join(buildDir, "view-sponsors", "capture");
    mkdirSync(manifestDir, { recursive: true });
    writeFileSync(
      join(manifestDir, "manifest.json"),
      JSON.stringify({
        workflow: "view-sponsors",
        baseUrl: "http://localhost:3000",
        viewport: { width: 1440, height: 810 },
        deviceScaleFactor: 1,
        steps: [{ id: "s1", camera: "full", cameraBox: null, events: [], doc: { image: null, highlights: [] }, impact: { urls: ["/sponsors"], requests: [] }, checks: [] }],
      }),
    );

    const screenshotsDir = join(helpDir, "public", "screenshots", "view-sponsors");
    mkdirSync(screenshotsDir, { recursive: true });
    writeFileSync(join(screenshotsDir, "step-01.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47])); // fixture bytes, not a real PNG — baseline lookup only needs the file to exist

    writeFileSync(
      join(helpDir, "aida.config.ts"),
      `import { defineConfig } from ${JSON.stringify(defineConfigModuleUrl)};\nexport default defineConfig({ app: { baseUrl: "http://localhost:3000" }, walkthroughsDir: "./walkthroughs", buildDir: "./.build", helpApp: ".", impact: { appRepo: ${JSON.stringify(appRepo)} } });\n`,
    );
    commitAll(docsRepo, "docs repo init");

    // 1. Config loads from the docs repo's own checkout, with paths resolved relative to it.
    const config = await loadConfig(join(helpDir, "aida.config.ts"));
    expect(config.walkthroughsDir).toBe(walkthroughsDir);
    expect(config.buildDir).toBe(buildDir);
    expect(config.helpApp).toBe(helpDir);
    expect(config.impact?.appRepo).toBe(appRepo);

    // 2. The impact map reads the app repo's git history (not the docs repo's) but the
    // walkthrough/manifest it matches against come from the docs repo's checkout.
    const affected = await computeAffected({ appRepo, base: "base", config });
    expect(affected.all).toBe(false);
    const wt = affected.walkthroughs.find((w) => w.id === "view-sponsors")!;
    expect(wt.affected).toBe(true);
    expect(wt.reasons[0]).toMatch(/sponsors\/page\.tsx -> \/sponsors/);

    // 3. The baseline screenshot source reads straight off the docs repo's own `public/` —
    // exactly what `publicDirFor(config)` in ci/run.ts resolves to for this config.
    const source = diskBaselineSource(join(config.helpApp!, "public"));
    expect(source.listWalkthroughIds()).toEqual(["view-sponsors"]);
    expect(source.getScreenshot("view-sponsors", "step-01.png")).not.toBeNull();
  });
});
