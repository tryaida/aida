import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rm } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runSuggest } from "../../src/commands/suggest.js";
import { UNANSWERED_LOG_PREFIX } from "../../src/chat/unanswered.js";

const dirs: string[] = [];
afterEach(async () => {
  while (dirs.length) await rm(dirs.pop()!, { recursive: true, force: true });
});

function captureLastJsonLog(fn: () => void): unknown {
  const logs: string[] = [];
  const spy = vi.spyOn(console, "log").mockImplementation((line: string) => {
    logs.push(line);
  });
  try {
    fn();
  } finally {
    spy.mockRestore();
  }
  return JSON.parse(logs[logs.length - 1]);
}

describe("runSuggest --from (review finding unanswered.ts:39 / commands/suggest.ts:12: prod console store had no reader)", () => {
  it("reads unanswered questions out of a host log file via --from", () => {
    const dir = mkdtempSync(join(tmpdir(), "aida-suggest-"));
    dirs.push(dir);
    const logFile = join(dir, "app.log");
    writeFileSync(
      logFile,
      [
        "2026-10-22T00:00:00Z [info] server started",
        `2026-10-22T00:00:01Z ${UNANSWERED_LOG_PREFIX}${JSON.stringify({ question: "how do I add a competitor", at: "2026-10-22T00:00:01Z" })}`,
      ].join("\n"),
    );

    const result = captureLastJsonLog(() => {
      runSuggest({ from: logFile }, true);
    }) as { ok: boolean; count: number; skipped: number };
    expect(result.ok).toBe(true);
    expect(result.count).toBe(1);
    expect(result.skipped).toBe(0);
  });

  it("does not throw and reports a skipped count when the log has a corrupt tagged line (review finding commands/suggest.ts:12: 'one corrupt line throws')", () => {
    const dir = mkdtempSync(join(tmpdir(), "aida-suggest-"));
    dirs.push(dir);
    const logFile = join(dir, "app.log");
    writeFileSync(
      logFile,
      [
        `${UNANSWERED_LOG_PREFIX}${JSON.stringify({ question: "ok one", at: "2026-10-22T00:00:00Z" })}`,
        `${UNANSWERED_LOG_PREFIX}{broken json`,
        `${UNANSWERED_LOG_PREFIX}${JSON.stringify({ question: "ok two", at: "2026-10-22T00:00:01Z" })}`,
      ].join("\n"),
    );

    let result: { count: number; skipped: number } | undefined;
    expect(() => {
      result = captureLastJsonLog(() => {
        runSuggest({ from: logFile }, true);
      }) as { count: number; skipped: number };
    }).not.toThrow();
    expect(result?.count).toBe(2);
    expect(result?.skipped).toBe(1);
  });

  it("falls back to the file store's JSONL (unaffected by --from) when --from isn't given", () => {
    const dir = mkdtempSync(join(tmpdir(), "aida-suggest-"));
    dirs.push(dir);
    writeFileSync(join(dir, "unanswered.jsonl"), `${JSON.stringify({ question: "from the file store", at: "2026-10-22T00:00:00Z" })}\n`);

    const result = captureLastJsonLog(() => {
      runSuggest({ dir }, true);
    }) as { count: number };
    expect(result.count).toBe(1);
  });
});
