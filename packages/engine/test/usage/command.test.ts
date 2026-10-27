import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runUsageAdd, runUsageReport } from "../../src/commands/usage.js";
import { readUsage } from "../../src/usage/index.js";

const createdDirs: string[] = [];

function tmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "aida-usage-cmd-test-"));
  createdDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (createdDirs.length > 0) {
    rmSync(createdDirs.pop()!, { recursive: true, force: true });
  }
});

describe("runUsageAdd", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it("appends an entry and exits 0, printing a text summary by default", () => {
    const dir = tmpDir();
    const code = runUsageAdd(
      { buildDir: dir, stage: "voice", tier: "standard", model: "claude-sonnet-5", input: 10, output: 5 },
      false,
    );

    expect(code).toBe(0);
    expect(readUsage(dir)).toHaveLength(1);
    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(logSpy.mock.calls[0][0]).toContain("voice/standard");
  });

  it("prints a single JSON object with the written entry when --json is set", () => {
    const dir = tmpDir();
    const code = runUsageAdd(
      { buildDir: dir, stage: "pages", tier: "fast", model: "claude-haiku-4-5", input: 1, output: 2, cacheRead: 3 },
      true,
    );

    expect(code).toBe(0);
    expect(logSpy).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(logSpy.mock.calls[0][0] as string);
    expect(payload.ok).toBe(true);
    expect(payload.knownModel).toBe(true);
    expect(payload.entry).toMatchObject({
      stage: "pages",
      tier: "fast",
      model: "claude-haiku-4-5",
      input: 1,
      output: 2,
      cacheRead: 3,
    });
  });

  it("rejects an invalid tier without throwing, exit code 1", () => {
    const dir = tmpDir();
    const code = runUsageAdd(
      { buildDir: dir, stage: "voice", tier: "bogus" as never, model: "claude-sonnet-5", input: 1, output: 1 },
      false,
    );

    expect(code).toBe(1);
    expect(readUsage(dir)).toHaveLength(0);
    expect(errorSpy).toHaveBeenCalledTimes(1);
  });

  it("records --note and --estimate, and flags the estimate in the text summary", () => {
    const dir = tmpDir();
    const code = runUsageAdd(
      {
        buildDir: dir,
        stage: "inspect",
        tier: "fast",
        model: "claude-haiku-4-5",
        input: 600,
        output: 0,
        note: "~600 tokens/page estimate",
        estimate: true,
      },
      false,
    );

    expect(code).toBe(0);
    const entries = readUsage(dir);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ estimate: true, note: "~600 tokens/page estimate" });
    expect(logSpy.mock.calls[0][0]).toContain("[estimate]");
    expect(logSpy.mock.calls[0][0]).toContain("~600 tokens/page estimate");
  });

  it("allows omitting --model when --estimate is set, pricing at the tier's default model", () => {
    const dir = tmpDir();
    const code = runUsageAdd(
      { buildDir: dir, stage: "inspect", tier: "fast", input: 600, output: 0, estimate: true },
      false,
    );

    expect(code).toBe(0);
    const entries = readUsage(dir);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ estimate: true, model: "claude-haiku-4-5" });
    expect(entries[0].note).toContain("fast tier's default model");
  });

  it("still requires --model for a real (non-estimate) entry", () => {
    const dir = tmpDir();
    const code = runUsageAdd({ buildDir: dir, stage: "voice", tier: "standard", input: 10, output: 5 }, false);

    expect(code).toBe(1);
    expect(readUsage(dir)).toHaveLength(0);
    expect(errorSpy.mock.calls[0][0]).toContain("--model is required");
  });

  it("still records an entry for an unknown model, flagged rather than thrown", () => {
    const dir = tmpDir();
    const code = runUsageAdd(
      { buildDir: dir, stage: "voice", tier: "standard", model: "some-future-model", input: 10, output: 10 },
      true,
    );

    expect(code).toBe(0);
    const payload = JSON.parse(logSpy.mock.calls[0][0] as string);
    expect(payload.knownModel).toBe(false);
    expect(readUsage(dir)).toHaveLength(1);
  });
});

describe("runUsageReport", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  it("prints a text summary and returns 0 for an empty ledger", () => {
    const code = runUsageReport(tmpDir(), false);
    expect(code).toBe(0);
    expect(logSpy.mock.calls[0][0]).toContain("total:");
  });

  it("prints a single JSON object matching UsageReport shape with --json", () => {
    const dir = tmpDir();
    runUsageAdd({ buildDir: dir, stage: "voice", tier: "standard", model: "claude-sonnet-5", input: 10, output: 5 }, true);
    logSpy.mockClear();

    const code = runUsageReport(dir, true);
    expect(code).toBe(0);
    const payload = JSON.parse(logSpy.mock.calls[0][0] as string);
    expect(payload.ok).toBe(true);
    expect(payload.entries).toHaveLength(1);
    expect(payload.totals).toHaveLength(1);
    expect(typeof payload.totalCostUsd).toBe("number");
    expect(typeof payload.totalTokens).toBe("number");
  });
});
