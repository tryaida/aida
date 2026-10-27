import { mkdtemp, rm } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendUsage } from "../../src/usage/index.js";
import { assembleReport, buildModelsSection, checkBudget, formatReport, writeReport } from "../../src/build/index.js";
import type { ResolvedConfig } from "../../src/config/index.js";
import type { WalkthroughBuildResult } from "../../src/build/index.js";

function fakeConfig(buildDir: string, budget?: { usd?: number; tokens?: number }): ResolvedConfig {
  return {
    app: { baseUrl: "http://localhost:3000" },
    walkthroughsDir: "/tmp/walkthroughs",
    outDir: "/tmp/out",
    buildDir,
    configDir: "/tmp",
    budget,
  } as ResolvedConfig;
}

function okWalkthrough(id: string): WalkthroughBuildResult {
  return {
    walkthrough: id,
    ok: true,
    stages: {
      capture: { status: "ok", skipped: false, ms: 10 },
      voice: { status: "skipped", skipped: true, ms: 1, detail: "all lines cached, nothing billed" },
      render: { status: "ok", skipped: false, ms: 20 },
      pages: { status: "ok", skipped: false, ms: 5 },
      qa: { status: "ok", skipped: false, ms: 2 },
    },
    voice: { charsBilled: 0, cached: 3, synthesized: 0, costUsd: 0 },
    render: { durationSec: 12.3, wallTimeMs: 20 },
    qa: { ok: true, problems: 0 },
  };
}

describe("build report", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "aida-report-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("buildModelsSection aggregates the usage ledger", () => {
    appendUsage(dir, { stage: "pages", tier: "standard", model: "claude-sonnet-5", input: 1000, output: 500, cacheRead: 0 });
    appendUsage(dir, { stage: "qa", tier: "fast", model: "claude-haiku-4-5", input: 2000, output: 200, cacheRead: 0 });

    const models = buildModelsSection(dir);
    expect(models.totals.length).toBe(2);
    expect(models.totalTokens).toBe(1000 + 500 + 2000 + 200);
    expect(models.totalCostUsd).toBeGreaterThan(0);
  });

  it("buildModelsSection reports zero usage for a build dir with no ledger", () => {
    const models = buildModelsSection(dir);
    expect(models.totals).toEqual([]);
    expect(models.totalCostUsd).toBe(0);
    expect(models.totalTokens).toBe(0);
  });

  it("checkBudget is undefined when no budget configured", () => {
    const config = fakeConfig(dir);
    expect(checkBudget(config, buildModelsSection(dir))).toBeUndefined();
  });

  it("checkBudget flags a cost overrun", () => {
    appendUsage(dir, { stage: "pages", tier: "deep", model: "claude-opus-5-5", input: 1_000_000, output: 500_000, cacheRead: 0 });
    const config = fakeConfig(dir, { usd: 1 });
    const result = checkBudget(config, buildModelsSection(dir));
    expect(result?.exceeded).toBe(true);
    expect(result?.reasons.join(" ")).toMatch(/exceeds budget/);
  });

  it("checkBudget flags a token overrun", () => {
    appendUsage(dir, { stage: "pages", tier: "fast", model: "claude-haiku-4-5", input: 500, output: 500, cacheRead: 0 });
    const config = fakeConfig(dir, { tokens: 100 });
    const result = checkBudget(config, buildModelsSection(dir));
    expect(result?.exceeded).toBe(true);
  });

  it("checkBudget passes within limits", () => {
    appendUsage(dir, { stage: "pages", tier: "fast", model: "claude-haiku-4-5", input: 10, output: 10, cacheRead: 0 });
    const config = fakeConfig(dir, { usd: 100, tokens: 100_000 });
    const result = checkBudget(config, buildModelsSection(dir));
    expect(result?.exceeded).toBe(false);
  });

  it("checkBudget counts voice cost toward the USD budget alongside model cost (bug: voice spend was invisible to the budget check)", () => {
    const config = fakeConfig(dir, { usd: 1 });
    const models = buildModelsSection(dir); // no model usage recorded
    expect(checkBudget(config, models, 0)?.exceeded).toBe(false);
    const result = checkBudget(config, models, 2);
    expect(result?.exceeded).toBe(true);
    expect(result?.reasons.join(" ")).toMatch(/voice \$2\.0000/);
  });

  it("buildModelsSection with `since` only counts this run's ledger entries, not the whole build dir's history (bug: a per-run budget check saw every past run too)", () => {
    appendUsage(dir, { ts: "2026-01-01T00:00:00.000Z", stage: "pages", tier: "deep", model: "claude-opus-5-5", input: 1_000_000, output: 1_000_000, cacheRead: 0 });
    const runStartedAt = "2026-06-01T00:00:00.000Z";
    appendUsage(dir, { ts: "2026-06-01T00:00:05.000Z", stage: "pages", tier: "fast", model: "claude-haiku-4-5", input: 100, output: 100, cacheRead: 0 });

    const wholeHistory = buildModelsSection(dir);
    const thisRunOnly = buildModelsSection(dir, runStartedAt);
    expect(wholeHistory.totals.length).toBe(2);
    expect(thisRunOnly.totals.length).toBe(1);
    expect(thisRunOnly.totals[0].model).toBe("claude-haiku-4-5");
  });

  it("assembleReport is ok when every walkthrough passed and budget wasn't exceeded", () => {
    const config = fakeConfig(dir, { usd: 100 });
    const report = assembleReport(config, true, [okWalkthrough("add-competitor")], undefined);
    expect(report.ok).toBe(true);
    expect(report.draft).toBe(true);
  });

  it("assembleReport is not ok when a walkthrough failed", () => {
    const config = fakeConfig(dir);
    const failing = okWalkthrough("add-competitor");
    failing.ok = false;
    failing.stages.capture = { status: "failed", skipped: false, ms: 1, detail: "boom" };
    const report = assembleReport(config, false, [failing], undefined);
    expect(report.ok).toBe(false);
  });

  it("assembleReport is not ok when the budget is exceeded even if every walkthrough passed", () => {
    appendUsage(dir, { stage: "pages", tier: "deep", model: "claude-opus-5-5", input: 1_000_000, output: 1_000_000, cacheRead: 0 });
    const config = fakeConfig(dir, { usd: 0.01 });
    const report = assembleReport(config, false, [okWalkthrough("add-competitor")], undefined);
    expect(report.ok).toBe(false);
    expect(report.budget?.exceeded).toBe(true);
  });

  it("assembleReport sums each walkthrough's voice cost into a top-level voice section", () => {
    const config = fakeConfig(dir);
    const a = okWalkthrough("add-competitor");
    a.voice = { charsBilled: 500, cached: 0, synthesized: 1, costUsd: 0.015 };
    const b = okWalkthrough("edit-score");
    b.voice = { charsBilled: 300, cached: 1, synthesized: 0, costUsd: 0 };
    const report = assembleReport(config, false, [a, b], undefined);
    expect(report.voice).toEqual({ charsBilled: 800, costUsd: 0.015 });
  });

  it("assembleReport's models section only counts usage recorded during this run when runStartedAt is given", () => {
    appendUsage(dir, { ts: "2026-01-01T00:00:00.000Z", stage: "pages", tier: "deep", model: "claude-opus-5-5", input: 1_000_000, output: 1_000_000, cacheRead: 0 });
    const runStartedAt = "2026-06-01T00:00:00.000Z";
    appendUsage(dir, { ts: "2026-06-01T00:00:05.000Z", stage: "pages", tier: "fast", model: "claude-haiku-4-5", input: 100, output: 100, cacheRead: 0 });
    const config = fakeConfig(dir);

    const report = assembleReport(config, false, [okWalkthrough("add-competitor")], undefined, runStartedAt);
    expect(report.models.totals.length).toBe(1);
    expect(report.models.totals[0].model).toBe("claude-haiku-4-5");
  });

  it("assembleReport is not ok when this run's model cost + voice cost together exceed budget, even if neither alone would", () => {
    appendUsage(dir, { stage: "pages", tier: "standard", model: "claude-sonnet-5", input: 100_000, output: 0, cacheRead: 0 }); // $0.20
    const config = fakeConfig(dir, { usd: 0.3 });
    const withVoice = okWalkthrough("add-competitor");
    withVoice.voice = { charsBilled: 10_000, cached: 0, synthesized: 1, costUsd: 0.15 };
    const report = assembleReport(config, false, [withVoice], undefined);
    expect(report.budget?.exceeded).toBe(true);
  });

  it("formatReport includes a voice line when voice billed anything", () => {
    const config = fakeConfig(dir);
    const withVoice = okWalkthrough("add-competitor");
    withVoice.voice = { charsBilled: 1234, cached: 0, synthesized: 1, costUsd: 0.05 };
    const report = assembleReport(config, false, [withVoice], undefined);
    const text = formatReport(report);
    expect(text).toContain("voice: 1234 chars billed, $0.0500");
  });

  it("writeReport writes <buildDir>/report.json", () => {
    const config = fakeConfig(dir);
    const report = assembleReport(config, false, [okWalkthrough("add-competitor")], undefined);
    const file = writeReport(dir, report);
    expect(file).toBe(path.join(dir, "report.json"));
    expect(existsSync(file)).toBe(true);
    expect(JSON.parse(readFileSync(file, "utf8")).ok).toBe(true);
  });

  it("formatReport prints a terse summary including stage lines and models", () => {
    appendUsage(dir, { stage: "pages", tier: "standard", model: "claude-sonnet-5", input: 100, output: 100, cacheRead: 0 });
    const config = fakeConfig(dir);
    const report = assembleReport(config, false, [okWalkthrough("add-competitor")], undefined);
    const text = formatReport(report);
    expect(text).toContain("add-competitor");
    expect(text).toContain("capture: ok");
    expect(text).toContain("voice: skip");
    expect(text).toContain("claude-sonnet-5");
  });
});

describe("formatReport failed checks (M26)", () => {
  it("names each failed check, its count and files, then the first problem", () => {
    const w: WalkthroughBuildResult = {
      ...okWalkthrough("add-session"),
      ok: false,
      stages: { ...okWalkthrough("add-session").stages, qa: { status: "failed", skipped: false, ms: 1, detail: "1 check(s) failed" } },
      failures: [
        {
          stage: "qa",
          check: "captions:line-length",
          count: 3,
          problems: ["cue 2: line length 47 above max 42"],
          files: [path.join(process.cwd(), ".build", "add-session", "qa.json")],
        },
      ],
    };
    const text = formatReport({
      generatedAt: "",
      configPath: "",
      draft: false,
      walkthroughs: [w],
      models: { totals: [], totalCostUsd: 0, totalTokens: 0 },
      voice: { charsBilled: 0, costUsd: 0 },
      ok: false,
    });
    expect(text).toContain(`add-session: qa captions:line-length (3 problems) — ${path.join(".build", "add-session", "qa.json")}`);
    expect(text).toContain("cue 2: line length 47 above max 42");
  });
});
