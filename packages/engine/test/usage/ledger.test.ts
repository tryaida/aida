import { appendFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { appendUsage, formatUsageReport, ledgerPath, readUsage, reportUsage } from "../../src/usage/index.js";

const createdDirs: string[] = [];

function tmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "aida-usage-test-"));
  createdDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (createdDirs.length > 0) {
    rmSync(createdDirs.pop()!, { recursive: true, force: true });
  }
});

describe("ledgerPath", () => {
  it("joins the build dir with usage.jsonl", () => {
    expect(ledgerPath("/foo/bar")).toBe(join("/foo/bar", "usage.jsonl"));
  });
});

describe("appendUsage + readUsage", () => {
  it("round-trips a single entry, filling ts when omitted", () => {
    const dir = tmpDir();
    const written = appendUsage(dir, {
      stage: "voice",
      tier: "standard",
      model: "claude-sonnet-5",
      input: 100,
      output: 50,
      cacheRead: 0,
    });

    expect(written.ts).toBeTruthy();
    expect(() => new Date(written.ts).toISOString()).not.toThrow();

    const entries = readUsage(dir);
    expect(entries).toEqual([written]);
  });

  it("defaults cacheRead to 0 when not given", () => {
    const dir = tmpDir();
    const written = appendUsage(dir, { stage: "pages", tier: "fast", model: "claude-haiku-4-5", input: 10, output: 5 });
    expect(written.cacheRead).toBe(0);
  });

  it("creates the build dir if missing", () => {
    const dir = join(tmpDir(), "nested", "build");
    appendUsage(dir, { stage: "discover", tier: "deep", model: "claude-opus-5-5", input: 1, output: 1 });
    expect(readUsage(dir)).toHaveLength(1);
  });

  it("appends multiple entries as separate JSON lines", () => {
    const dir = tmpDir();
    appendUsage(dir, { stage: "voice", tier: "standard", model: "claude-sonnet-5", input: 1, output: 1 });
    appendUsage(dir, { stage: "pages", tier: "fast", model: "claude-haiku-4-5", input: 2, output: 2 });

    const lines = readFileSync(ledgerPath(dir), "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(readUsage(dir)).toHaveLength(2);
  });

  it("returns [] when no ledger file exists yet", () => {
    expect(readUsage(tmpDir())).toEqual([]);
  });

  it("tolerates and skips unparsable lines", () => {
    const dir = tmpDir();
    appendUsage(dir, { stage: "voice", tier: "standard", model: "claude-sonnet-5", input: 1, output: 1 });
    // Append a garbage line directly.
    appendFileSync(ledgerPath(dir), "not json at all\n");
    appendUsage(dir, { stage: "pages", tier: "fast", model: "claude-haiku-4-5", input: 2, output: 2 });

    expect(readUsage(dir)).toHaveLength(2);
  });
});

describe("reportUsage", () => {
  it("aggregates mixed models/tiers with correct per-row and total math", () => {
    const dir = tmpDir();
    appendUsage(dir, {
      stage: "voice",
      tier: "standard",
      model: "claude-sonnet-5",
      input: 1_000_000,
      output: 500_000,
      cacheRead: 0,
    });
    appendUsage(dir, {
      stage: "pages",
      tier: "standard",
      model: "claude-sonnet-5",
      input: 500_000,
      output: 250_000,
      cacheRead: 100_000,
    });
    appendUsage(dir, {
      stage: "discover",
      tier: "fast",
      model: "claude-haiku-4-5",
      input: 2_000_000,
      output: 1_000_000,
      cacheRead: 0,
    });

    const report = reportUsage(dir);
    expect(report.entries).toHaveLength(3);
    expect(report.totals).toHaveLength(2);

    const sonnet = report.totals.find((r) => r.model === "claude-sonnet-5" && r.tier === "standard");
    expect(sonnet).toBeDefined();
    expect(sonnet!.calls).toBe(2);
    expect(sonnet!.input).toBe(1_500_000);
    expect(sonnet!.output).toBe(750_000);
    expect(sonnet!.cacheRead).toBe(100_000);
    // sonnet-5: $2/$10/$0.20 per MTok
    const expectedSonnetCost = 1.5 * 2 + 0.75 * 10 + 0.1 * 0.2;
    expect(sonnet!.costUsd).toBeCloseTo(expectedSonnetCost, 6);

    const haiku = report.totals.find((r) => r.model === "claude-haiku-4-5" && r.tier === "fast");
    expect(haiku).toBeDefined();
    expect(haiku!.calls).toBe(1);
    // haiku-4-5: $1/$5 per MTok
    const expectedHaikuCost = 2 * 1 + 1 * 5;
    expect(haiku!.costUsd).toBeCloseTo(expectedHaikuCost, 6);

    expect(report.totalCostUsd).toBeCloseTo(expectedSonnetCost + expectedHaikuCost, 6);
    expect(report.totalTokens).toBe(1_500_000 + 750_000 + 100_000 + 2_000_000 + 1_000_000);
  });

  it("returns empty totals and zero cost/tokens for an empty ledger", () => {
    const report = reportUsage(tmpDir());
    expect(report.entries).toEqual([]);
    expect(report.totals).toEqual([]);
    expect(report.totalCostUsd).toBe(0);
    expect(report.totalTokens).toBe(0);
  });

  it("treats an unknown model as zero cost rather than throwing", () => {
    const dir = tmpDir();
    appendUsage(dir, { stage: "voice", tier: "standard", model: "some-unknown-model", input: 1000, output: 1000 });
    const report = reportUsage(dir);
    expect(report.totals[0].costUsd).toBe(0);
    expect(report.totalCostUsd).toBe(0);
  });

  it("with `since`, counts only entries recorded at or after it (bug: a per-run budget check saw the whole ledger's history)", () => {
    const dir = tmpDir();
    appendUsage(dir, {
      ts: "2026-01-01T00:00:00.000Z",
      stage: "pages",
      tier: "standard",
      model: "claude-sonnet-5",
      input: 1_000_000,
      output: 1_000_000,
      cacheRead: 0,
    });
    const runStartedAt = "2026-06-01T00:00:00.000Z";
    appendUsage(dir, {
      ts: "2026-06-01T00:00:05.000Z",
      stage: "pages",
      tier: "standard",
      model: "claude-sonnet-5",
      input: 100,
      output: 100,
      cacheRead: 0,
    });

    const full = reportUsage(dir);
    const thisRun = reportUsage(dir, runStartedAt);

    expect(full.entries).toHaveLength(2);
    expect(thisRun.entries).toHaveLength(1);
    expect(thisRun.totalTokens).toBe(200);
    expect(thisRun.totalCostUsd).toBeLessThan(full.totalCostUsd);
  });

  it("groups dotted and hyphenated variants of the same model into one row (bug: claude-haiku-4.5 and claude-haiku-4-5 appeared as separate rows)", () => {
    const dir = tmpDir();
    appendUsage(dir, { stage: "discover", tier: "fast", model: "claude-haiku-4.5", input: 1000, output: 1000 });
    appendUsage(dir, { stage: "discover", tier: "fast", model: "claude-haiku-4-5", input: 2000, output: 2000 });
    appendUsage(dir, { stage: "discover", tier: "fast", model: "claude-haiku-4-5-20251001", input: 500, output: 500 });

    const report = reportUsage(dir);
    expect(report.totals).toHaveLength(1);
    const row = report.totals[0];
    expect(row.model).toBe("claude-haiku-4-5");
    expect(row.calls).toBe(3);
    expect(row.input).toBe(3500);
    expect(row.output).toBe(3500);
  });

  it("with `since`, returns an empty report when nothing in the ledger is this recent", () => {
    const dir = tmpDir();
    appendUsage(dir, { ts: "2026-01-01T00:00:00.000Z", stage: "pages", tier: "fast", model: "claude-haiku-4-5", input: 10, output: 10 });
    const report = reportUsage(dir, "2027-01-01T00:00:00.000Z");
    expect(report.entries).toEqual([]);
    expect(report.totalCostUsd).toBe(0);
  });
});

describe("formatUsageReport", () => {
  it("renders one line per row plus a total line", () => {
    const dir = tmpDir();
    appendUsage(dir, { stage: "voice", tier: "standard", model: "claude-sonnet-5", input: 1_000_000, output: 500_000 });

    const text = formatUsageReport(reportUsage(dir));
    const lines = text.split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("claude-sonnet-5");
    expect(lines[0]).toContain("[standard]");
    expect(lines[1]).toMatch(/^total:/);
  });

  it("flags an unknown model inline", () => {
    const dir = tmpDir();
    appendUsage(dir, { stage: "voice", tier: "standard", model: "mystery-model", input: 100, output: 100 });
    const text = formatUsageReport(reportUsage(dir));
    expect(text).toContain("unknown model");
  });

  it("keeps an estimated entry's tokens/cost out of the real total, reported separately", () => {
    const dir = tmpDir();
    appendUsage(dir, { stage: "voice", tier: "standard", model: "claude-sonnet-5", input: 1_000_000, output: 0 });
    appendUsage(dir, {
      stage: "inspect",
      tier: "fast",
      model: "claude-haiku-4-5",
      input: 600,
      output: 0,
      estimate: true,
      note: "~600 tokens/page estimate — see references/tokens.md",
    });

    const report = reportUsage(dir);
    // The real total only counts the real (non-estimate) entry.
    expect(report.totalTokens).toBe(1_000_000);
    expect(report.estimatedTokens).toBe(600);
    expect(report.estimatedCostUsd).toBeGreaterThan(0);

    const text = formatUsageReport(report);
    expect(text).toContain("[estimate]");
    expect(text).toMatch(/^estimated \(not counted above\):/m);
  });
});
