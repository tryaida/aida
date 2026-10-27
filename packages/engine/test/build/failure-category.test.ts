// M28: report.json's capture failures carry the failure report's category and reason, and the
// text report says when a failure looks like the app or the setup rather than the walkthrough.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { collectFailures } from "../../src/build/failures.js";
import { formatReport } from "../../src/build/report.js";
import type { BuildReport } from "../../src/build/types.js";
import type { ValidationResult } from "../../src/capture/types.js";

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

const validation: ValidationResult = {
  workflow: "amend",
  ranAt: "2026-10-26T00:00:00.000Z",
  baseUrl: "http://127.0.0.1:3000",
  ok: false,
  steps: [{ id: "save", title: undefined, checks: [], ok: false, ms: 1, error: "locator.waitFor: Timeout 60000ms exceeded." }],
  dbChecks: [],
  problems: { console: [], page: [], server: [] },
};

describe("build failures: category", () => {
  it("copies category and reason from this run's failure.json onto the capture step failure", () => {
    const captureDir = mkdtempSync(join(tmpdir(), "aida-failure-category-"));
    dirs.push(captureDir);
    const reason = "suspected app bug: the save request succeeded (POST /api/registrations 200) but the screen didn't change";
    writeFileSync(join(captureDir, "failure.json"), JSON.stringify({ step: "save", category: "app", reason }));
    const failureFile = join(captureDir, "failure.json");
    const failures = collectFailures({ stages: { capture: { status: "failed", skipped: false, ms: 1 } }, captureDir, validation, failureFile })!;
    expect(failures[0]).toMatchObject({ check: "capture:step", category: "app", reason });
    expect(failures[0].files).toContain(failureFile);

    const report = {
      ok: false,
      draft: false,
      walkthroughs: [{ walkthrough: "amend", ok: false, stages: {}, failures }],
      models: { totals: [], totalCostUsd: 0, totalTokens: 0 },
      voice: { charsBilled: 0, costUsd: 0 },
    } as unknown as BuildReport;
    expect(formatReport(report)).toContain(`possible app bug (not a docs problem): ${reason}`);
  });

  it("never lists or reads a failure.json this run didn't write", () => {
    const captureDir = mkdtempSync(join(tmpdir(), "aida-failure-category-"));
    dirs.push(captureDir);
    writeFileSync(join(captureDir, "failure.json"), JSON.stringify({ category: "app", reason: "from an earlier run" }));
    const [f] = collectFailures({ stages: { capture: { status: "failed", skipped: false, ms: 1 } }, captureDir, validation })!;
    expect(f.category).toBeUndefined();
    expect(f.files).not.toContain(join(captureDir, "failure.json"));
  });

  it("a blocked walkthrough names the block, and inherits a provider's possible app bug", () => {
    const captureDir = mkdtempSync(join(tmpdir(), "aida-failure-category-"));
    dirs.push(captureDir);
    const detail = "skipped: needs session-exists, which add-session didn't leave";
    const [f] = collectFailures({ stages: { capture: { status: "failed", skipped: false, ms: 1, detail } }, captureDir, blocked: { appBugIn: ["add-session"] } })!;
    expect(f).toMatchObject({ check: "capture:blocked", problems: [detail], category: "app", reason: "blocked by a possible app bug in add-session" });
  });

  it("classifies a capture that threw from its error text alone", () => {
    const captureDir = mkdtempSync(join(tmpdir(), "aida-failure-category-"));
    dirs.push(captureDir);
    const failures = collectFailures({
      stages: { capture: { status: "failed", skipped: false, ms: 1, detail: "page.goto: net::ERR_CONNECTION_REFUSED at http://127.0.0.1:3000/" } },
      captureDir,
    })!;
    expect(failures[0].category).toBe("environment");
  });
});
