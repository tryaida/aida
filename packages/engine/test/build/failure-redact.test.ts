// report.json gets step errors through the same one-line redaction as failure.json (M28 review).
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { collectFailures } from "../../src/build/failures.js";
import type { ValidationResult } from "../../src/capture/types.js";

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe("build failures: redaction", () => {
  it("redacts raw step and database errors before they reach report.json", () => {
    const captureDir = mkdtempSync(join(tmpdir(), "aida-failure-redact-"));
    dirs.push(captureDir);
    const validation: ValidationResult = {
      workflow: "w",
      ranAt: "2026-01-01T00:00:00.000Z",
      baseUrl: "http://127.0.0.1:3000",
      ok: false,
      steps: [
        {
          id: "accept",
          title: undefined,
          checks: [],
          ok: false,
          ms: 1,
          error: "page.waitForURL: Timeout exceeded at http://127.0.0.1:3000/invite/Zx9kQ2mT7vB4nR8pL3wY?t=secret with sk_live_abcdefghij1234567890\ncall log",
        },
      ],
      dbChecks: [{ name: "row", ok: false, error: "connect failed: postgresql://owner:hunter2@db.local/app" }],
      problems: { console: [], page: [], server: [] },
    };
    const failures = collectFailures({ stages: { capture: { status: "failed", skipped: false, ms: 1 } }, captureDir, validation })!;
    const text = JSON.stringify(failures);
    expect(text).not.toMatch(/Zx9kQ2mT7vB4nR8pL3wY|t=secret|sk_live_|hunter2|call log/);
    expect(text).toContain("/invite/[token]");
  });
});
