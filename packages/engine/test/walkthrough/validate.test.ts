import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { findWalkthroughFiles, runValidate, validatePath } from "../../src/commands/validate.js";

const VALID = `
walkthrough: add-competitor
title: Add a new competitor
steps:
  - do: click "Save" button
`;

const UNRESOLVED_TEMPLATE = `
walkthrough: add-competitor
title: Add a new competitor
data:
  competitor: { firstName: Jordan }
steps:
  - do: click "Save" button
    say: Hello {{competitor.lastName}}
`;

describe("validatePath", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "aida-validate-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("reports an unresolved template as a validation error instead of crashing", async () => {
    // Regression: resolveTemplate now throws for an unresolved {{path}} — validate must catch
    // that and report it as a normal per-file error, not blow up loading the directory.
    const file = path.join(dir, "a.yaml");
    await writeFile(file, UNRESOLVED_TEMPLATE, "utf8");

    const [result] = validatePath(file);
    expect(result.ok).toBe(false);
    expect(result.errors?.[0]?.message).toMatch(/unresolved template placeholder/);
    // Reported on the field it would print from (M35), not just by name.
    expect(result.errors?.[0]?.path).toBe("steps.0.say");
    expect(result.errors?.[0]?.message).toContain("{{competitor.lastName}}");
  });

  it("passes when every template resolves", async () => {
    const file = path.join(dir, "a.yaml");
    await writeFile(file, VALID, "utf8");
    const [result] = validatePath(file);
    expect(result.ok).toBe(true);
  });

  it("reports duplicate walkthrough ids across files in a directory", async () => {
    await writeFile(path.join(dir, "a.yaml"), VALID, "utf8");
    await writeFile(path.join(dir, "b.yaml"), VALID, "utf8"); // same `walkthrough: add-competitor`

    const results = validatePath(dir);
    expect(results).toHaveLength(2);
    expect(results.every((r) => !r.ok)).toBe(true);
    expect(results[0].errors?.[0]?.message).toMatch(/duplicate walkthrough id/);
  });

  it("does not flag unique ids as duplicates", async () => {
    await writeFile(path.join(dir, "a.yaml"), VALID, "utf8");
    await writeFile(
      path.join(dir, "b.yaml"),
      VALID.replace("add-competitor", "add-entry"),
      "utf8",
    );
    const results = validatePath(dir);
    expect(results.every((r) => r.ok)).toBe(true);
  });
});

describe("runValidate", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "aida-validate-cli-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("exits 1 and emits a short structured JSON error for a target that doesn't exist, instead of a raw stack", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const code = runValidate(path.join(dir, "does-not-exist"), true);
      expect(code).toBe(1);
      expect(log).toHaveBeenCalledTimes(1);
      const payload = JSON.parse(log.mock.calls[0][0] as string);
      expect(payload.error).toBeDefined();
      expect(payload.error.split("\n")).toHaveLength(1);
    } finally {
      log.mockRestore();
    }
  });

  it("exits 0 for a valid directory", async () => {
    await writeFile(path.join(dir, "a.yaml"), VALID, "utf8");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      expect(runValidate(dir, true)).toBe(0);
    } finally {
      log.mockRestore();
    }
  });
});

describe("findWalkthroughFiles", () => {
  it("throws a plain error for a nonexistent path (caught by runValidate)", () => {
    expect(() => findWalkthroughFiles("/nonexistent/aida-path")).toThrow();
  });
});
