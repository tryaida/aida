// `deploy()` runs everything through an injectable `CommandRunner` — these tests assert on the
// exact command without a network call or a real host CLI installed, and never actually deploy.
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createVercelAdapter } from "../../../src/publish/hosts/vercel.js";
import { createStaticAdapter } from "../../../src/publish/hosts/static.js";
import { createAmplifyAdapter } from "../../../src/publish/hosts/amplify.js";
import { createFakeCommandRunner } from "../../../src/publish/runner.js";
import { cleanupTmpDirs, makeHelpRoot, makeResolvedConfig } from "../helpers.js";

afterEach(cleanupTmpDirs);

describe("deploy() via an injected runner", () => {
  it("vercel preview runs `vercel deploy` without --prod", async () => {
    const helpRoot = makeHelpRoot();
    const adapter = createVercelAdapter();
    const plan = await adapter.plan(helpRoot, makeResolvedConfig());
    const { runner, calls } = createFakeCommandRunner({ code: 0, stdout: "https://example-preview.vercel.app\n", stderr: "" });
    const result = await adapter.deploy(helpRoot, plan, { prod: false }, runner);
    expect(calls).toHaveLength(1);
    expect(calls[0].cmd).toBe("npx");
    expect(calls[0].args).toEqual(["vercel", "deploy", "--yes", "--cwd", helpRoot]);
    expect(result.ok).toBe(true);
    expect(result.url).toBe("https://example-preview.vercel.app");
  });

  it("vercel production run adds --prod", async () => {
    const helpRoot = makeHelpRoot();
    const adapter = createVercelAdapter();
    const plan = await adapter.plan(helpRoot, makeResolvedConfig());
    const { runner, calls } = createFakeCommandRunner({ code: 0, stdout: "https://example.vercel.app\n", stderr: "" });
    await adapter.deploy(helpRoot, plan, { prod: true }, runner);
    expect(calls[0].args).toContain("--prod");
  });

  it("vercel --dry-run never calls the runner", async () => {
    const helpRoot = makeHelpRoot();
    const adapter = createVercelAdapter();
    const plan = await adapter.plan(helpRoot, makeResolvedConfig());
    const { runner, calls } = createFakeCommandRunner();
    const result = await adapter.deploy(helpRoot, plan, { dryRun: true }, runner);
    expect(calls).toHaveLength(0);
    expect(result.ok).toBe(true);
  });

  it("surfaces a non-zero exit as a failed deploy", async () => {
    const helpRoot = makeHelpRoot();
    const adapter = createVercelAdapter();
    const plan = await adapter.plan(helpRoot, makeResolvedConfig());
    const { runner } = createFakeCommandRunner({ code: 1, stdout: "", stderr: "not logged in" });
    const result = await adapter.deploy(helpRoot, plan, { prod: false }, runner);
    expect(result.ok).toBe(false);
    expect(result.summary).toContain("not logged in");
  });

  it("amplify never calls the runner — it's a Git-integration-only route", async () => {
    const helpRoot = makeHelpRoot();
    const adapter = createAmplifyAdapter();
    const plan = await adapter.plan(helpRoot, makeResolvedConfig());
    const { runner, calls } = createFakeCommandRunner();
    const result = await adapter.deploy(helpRoot, plan, { prod: true }, runner);
    expect(calls).toHaveLength(0);
    expect(result.ok).toBe(true);
    expect(result.summary).toMatch(/Git integration/);
  });

  it("static deploy() runs `npm run build` from the staged copy and reports out/ size without uploading anywhere", async () => {
    const helpRoot = makeHelpRoot();
    const adapter = createStaticAdapter();
    const applyPlan = await adapter.plan(helpRoot, makeResolvedConfig());
    await adapter.apply(helpRoot, applyPlan);
    const { runner, calls } = createFakeCommandRunner({ code: 0, stdout: "", stderr: "" });
    const result = await adapter.deploy(helpRoot, applyPlan, { prod: false }, runner);
    expect(calls).toHaveLength(1);
    expect(calls[0].cmd).toBe("npm");
    expect(calls[0].args).toEqual(["run", "build"]);
    // Built from the staged copy, not helpRoot itself (static-export-stage.ts).
    expect(calls[0].cwd).toBe(join(helpRoot, ".aida", "static-export-stage"));
    expect(result.ok).toBe(true);
    // The fake runner doesn't actually write out/, so the summary says so rather than a size.
    expect(result.summary).toMatch(/no out\/ directory/);
  });

  it("static deploy() passes AIDA_STATIC_EXPORT=1 to the actual build run, not just the plan (Opus review finding)", async () => {
    const helpRoot = makeHelpRoot();
    const adapter = createStaticAdapter();
    const plan = await adapter.plan(helpRoot, makeResolvedConfig());
    await adapter.apply(helpRoot, plan);
    let seenEnv: Record<string, string | undefined> | undefined;
    const runner = async (cmd: string, args: string[], opts?: { cwd?: string; env?: Record<string, string | undefined> }) => {
      seenEnv = opts?.env;
      return { code: 0, stdout: "", stderr: "" };
    };
    await adapter.deploy(helpRoot, plan, { prod: false }, runner);
    expect(seenEnv).toEqual({ AIDA_STATIC_EXPORT: "1", NEXT_PUBLIC_AIDA_STATIC_EXPORT: "1" });
  });
});
