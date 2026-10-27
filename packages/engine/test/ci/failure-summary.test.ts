// Security review: the failure summary goes into the PR comment and report.json, so its message
// is redacted, then capped, whatever produced it (a failure report, a page build error, a problem).
import { describe, expect, it } from "vitest";
import { failureSummaryFor } from "../../src/ci/run.js";

describe("failureSummaryFor", () => {
  it("redacts and caps the message", () => {
    const raw = `Error at https://app.test/x?token=abc for sophie.harrington@gmail.com with Bearer abcdefghijklmnop1234567890 ${"z".repeat(500)}\nsecond line`;
    const { summary } = failureSummaryFor("register", "aida.config.mjs", raw, "save");
    expect(summary.startsWith('step "save": Error at https://app.test/x for [REDACTED EMAIL] with [REDACTED SECRET]')).toBe(true);
    expect(summary).not.toContain("second line");
    expect(summary.length).toBeLessThanOrEqual(240);
  });
});
