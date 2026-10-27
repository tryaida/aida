// `aida ci --publish` (build-plan.md M19 "Merge behaviour hook"): re-captures what a push
// affected and republishes it via `runIndexStage`, skipping video. Mocks the capture/pages/index
// stages (each already tested on its own) so this is a fast unit test of the wiring: which
// walkthroughs get published, which get skipped as failed, and that `runIndexStage` is called
// with just the republished pages plus the full walkthrough id list (for pruning).
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ResolvedConfig } from "../../src/config/types.js";
import type { BuildPageResult } from "../../src/pages/types.js";

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
  for (const m of ["config/index.js", "impact/index.js", "impact/walkthroughs.js", "ci/capture.js", "pages/index.js", "build/index-stage.js", "safety/index.js"]) {
    vi.doUnmock(`../../src/${m}`);
  }
});

/** Real walkthrough files (the capture plan loads them): `extra` lines go after the title. */
function walkthroughsDir(walkthroughs: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "aida-ci-publish-"));
  dirs.push(dir);
  for (const [id, extra] of Object.entries(walkthroughs)) {
    writeFileSync(join(dir, `${id}.yaml`), [`walkthrough: ${id}`, `title: "${id}"`, extra, "steps:", "  - id: only-step", '    title: "Do"'].join("\n"));
  }
  return dir;
}

function fakeConfig(dir: string, overrides: Partial<ResolvedConfig> = {}): ResolvedConfig {
  return {
    app: { baseUrl: "http://localhost:3000" },
    configDir: "/tmp",
    walkthroughsDir: dir,
    outDir: "/tmp/help",
    buildDir: "/tmp/.build",
    helpApp: "/tmp/help-app",
    viewport: { width: 1440, height: 810 },
    deviceScaleFactor: 1,
    ...overrides,
  };
}

function page(id: string, publishable: boolean): BuildPageResult {
  return {
    id,
    outDir: `/tmp/.build/ci/pages/${id}`,
    indexFile: `/tmp/.build/ci/pages/${id}/index.mdx`,
    plainFile: `/tmp/.build/ci/pages/${id}/index.plain.md`,
    screenshotsDir: `/tmp/.build/ci/pages/${id}/screenshots`,
    screenshots: [],
    passed: publishable,
    publishable,
    problems: publishable ? [] : ["capture failed"],
    suggestions: [],
  };
}

describe("runCiPublish", () => {
  it("publishes a cosmetic walkthrough and skips a broken one, passing the full id list for pruning", async () => {
    vi.resetModules();
    const dir = walkthroughsDir({ "add-entry": "", "broken-one": "", untouched: "" });
    vi.doMock("../../src/config/index.js", () => ({ loadConfig: vi.fn(async () => fakeConfig(dir)) }));
    vi.doMock("../../src/impact/index.js", () => ({
      computeAffected: vi.fn(async () => ({
        base: "base",
        head: "HEAD",
        changedFiles: [],
        all: false,
        walkthroughs: [
          { id: "add-entry", affected: true, reasons: [] },
          { id: "broken-one", affected: true, reasons: [] },
          { id: "untouched", affected: false, reasons: [] },
        ],
      })),
    }));
    vi.doMock("../../src/impact/walkthroughs.js", () => ({
      listWalkthroughs: vi.fn(() => [
        { id: "add-entry", file: join(dir, "add-entry.yaml"), manifest: undefined },
        { id: "broken-one", file: join(dir, "broken-one.yaml"), manifest: undefined },
        { id: "untouched", file: join(dir, "untouched.yaml"), manifest: undefined },
      ]),
    }));
    vi.doMock("../../src/ci/capture.js", () => ({
      captureWalkthroughForCi: vi.fn(async (file: string) => {
        const ok = !file.includes("broken-one");
        return { walkthrough: { walkthrough: file.includes("broken-one") ? "broken-one" : "add-entry" }, captureDir: "/tmp/.build/ci/capture", ok, failure: ok ? undefined : { error: "boom" } };
      }),
    }));
    vi.doMock("../../src/pages/index.js", () => ({
      buildPage: vi.fn(async (wt: { walkthrough: string }) => page(wt.walkthrough, true)),
    }));
    let indexStageOpts: unknown;
    vi.doMock("../../src/build/index-stage.js", () => ({
      runIndexStage: vi.fn((opts: unknown) => {
        indexStageOpts = opts;
        return { contentDir: "/tmp/help-app/content/docs", searchIndexFile: "x", llmsTxtFile: "y", pageCount: 1, copiedToHelpApp: true };
      }),
    }));

    const { runCiPublish } = await import("../../src/ci/publish.js");
    const result = await runCiPublish({ configPath: "aida.config.ts", base: "base" });

    expect(result.published).toEqual(["add-entry"]);
    expect(result.failed).toEqual(["broken-one"]);
    expect(result.ok).toBe(false);
    expect(result.copiedToHelpApp).toBe(true);
    expect((indexStageOpts as { pages: BuildPageResult[] }).pages.map((p) => p.id)).toEqual(["add-entry"]);
    expect((indexStageOpts as { walkthroughIds: string[] }).walkthroughIds).toEqual(["add-entry", "broken-one", "untouched"]);
    // public/screenshots (the PR check's disk baseline) is refreshed only for what published.
    const sources = (indexStageOpts as { procedureSources: { walkthrough: { walkthrough: string } }[] }).procedureSources;
    expect(sources.map((s) => s.walkthrough.walkthrough)).toEqual(["add-entry"]);
  });

  /** `overbook` (affected) needs data that `add-session` (not affected) leaves. */
  async function publishWithProvider(providerOk: boolean) {
    vi.resetModules();
    const dir = walkthroughsDir({ "add-session": "leaves: [session-exists]", overbook: "needs: [session-exists]", other: "" });
    const reset = vi.fn(async () => {});
    const config = fakeConfig(dir, { database: { url: async () => "postgres://localhost:5432/app", reset } } as Partial<ResolvedConfig>);
    vi.doMock("../../src/config/index.js", () => ({ loadConfig: vi.fn(async () => config) }));
    vi.doMock("../../src/safety/index.js", () => ({ runCaptureSafetyChecks: vi.fn(async () => {}) }));
    vi.doMock("../../src/impact/index.js", () => ({
      computeAffected: vi.fn(async () => ({
        base: "base",
        head: "HEAD",
        changedFiles: [],
        all: false,
        walkthroughs: [
          { id: "add-session", affected: false, reasons: [] },
          { id: "other", affected: true, reasons: [] },
          { id: "overbook", affected: true, reasons: [] },
        ],
      })),
    }));
    vi.doMock("../../src/impact/walkthroughs.js", () => ({
      listWalkthroughs: vi.fn(() =>
        ["add-session", "other", "overbook"].map((id) => ({ id, file: join(dir, `${id}.yaml`), manifest: undefined })),
      ),
    }));
    const captures: { id: string; resetBefore?: boolean; runId?: string; persona: boolean }[] = [];
    vi.doMock("../../src/ci/capture.js", () => ({
      captureWalkthroughForCi: vi.fn(async (file: string, _config: unknown, _appUrl: unknown, planned: { resetBefore?: boolean; runId?: string; personaFor?: unknown }) => {
        const id = file.split("/").pop()!.replace(".yaml", "");
        captures.push({ id, resetBefore: planned?.resetBefore, runId: planned?.runId, persona: typeof planned?.personaFor === "function" });
        const ok = id !== "add-session" || providerOk;
        return { walkthrough: { walkthrough: id }, captureDir: `/tmp/.build/${id}/ci/capture`, ok, failure: ok ? undefined : { error: "boom" } };
      }),
    }));
    vi.doMock("../../src/pages/index.js", () => ({
      buildPage: vi.fn(async (wt: { walkthrough: string }) => page(wt.walkthrough, true)),
    }));
    let indexStageOpts: { pages: BuildPageResult[] } | undefined;
    vi.doMock("../../src/build/index-stage.js", () => ({
      runIndexStage: vi.fn((opts: { pages: BuildPageResult[] }) => {
        indexStageOpts = opts;
        return { contentDir: "x", searchIndexFile: "x", llmsTxtFile: "y", pageCount: opts.pages.length, copiedToHelpApp: true };
      }),
    }));
    const { runCiPublish } = await import("../../src/ci/publish.js");
    const result = await runCiPublish({ configPath: "aida.config.ts", base: "base" });
    return { result, captures, reset, indexStageOpts: indexStageOpts! };
  }

  it("captures in the planned order: the provider first, no reset inside its chain, one run id", async () => {
    const { result, captures } = await publishWithProvider(true);

    const order = captures.map((c) => c.id);
    expect(order.indexOf("add-session")).toBeLessThan(order.indexOf("overbook"));
    const byId = Object.fromEntries(captures.map((c) => [c.id, c]));
    expect(byId["add-session"].resetBefore).toBe(true);
    expect(byId.overbook.resetBefore).toBe(false); // a reset here would erase what add-session left
    expect(byId.other.resetBefore).toBe(true);
    expect(new Set(captures.map((c) => c.runId)).size).toBe(1);
    expect(captures[0].runId).toBeTruthy();
    expect(captures.every((c) => c.persona)).toBe(true);
    expect(result.published.sort()).toEqual(["add-session", "other", "overbook"]);
    expect(result.ok).toBe(true);
  });

  it("skips (never captures or publishes) a walkthrough whose provider failed this run", async () => {
    const { result, captures, indexStageOpts } = await publishWithProvider(false);

    expect(captures.map((c) => c.id)).not.toContain("overbook");
    expect(result.failed.sort()).toEqual(["add-session", "overbook"]);
    expect(result.published).toEqual(["other"]);
    expect(indexStageOpts.pages.map((p) => p.id)).toEqual(["other"]);
  });
});
