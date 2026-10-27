import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runVersionFreeze, runVersionList } from "../../src/commands/version.js";

let dir: string | undefined;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

function makeHelpApp(): string {
  dir = mkdtempSync(join(tmpdir(), "aida-version-cmd-"));
  mkdirSync(join(dir, "public"), { recursive: true });
  writeFileSync(join(dir, "public", "search-index.json"), "[]");
  return dir;
}

describe("runVersionFreeze / runVersionList", () => {
  it("freezes a version and reports it as JSON", () => {
    const helpApp = makeHelpApp();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const code = runVersionFreeze({ helpApp, name: "v1.0" }, true);
    expect(code).toBe(0);
    const printed = JSON.parse(logSpy.mock.calls[0][0] as string);
    expect(printed.ok).toBe(true);
    expect(printed.name).toBe("v1.0");
    logSpy.mockRestore();
  });

  it("lists frozen versions after freezing two", () => {
    const helpApp = makeHelpApp();
    runVersionFreeze({ helpApp, name: "v1.0" }, true);
    runVersionFreeze({ helpApp, name: "v2.0" }, true);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const code = runVersionList({ helpApp }, true);
    expect(code).toBe(0);
    const printed = JSON.parse(logSpy.mock.calls[0][0] as string);
    expect(printed.versions.map((v: { name: string }) => v.name).sort()).toEqual(["v1.0", "v2.0"]);
    logSpy.mockRestore();
  });

  it("returns non-zero with a clear error when a version already exists", () => {
    const helpApp = makeHelpApp();
    runVersionFreeze({ helpApp, name: "v1.0" }, true);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const code = runVersionFreeze({ helpApp, name: "v1.0" }, true);
    expect(code).toBe(1);
    const printed = JSON.parse(logSpy.mock.calls.at(-1)?.[0] as string);
    expect(printed.ok).toBe(false);
    expect(printed.error).toMatch(/already exists/);
    logSpy.mockRestore();
  });

  it("reports no frozen versions yet in plain mode", () => {
    const helpApp = makeHelpApp();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    runVersionList({ helpApp }, false);
    expect(logSpy).toHaveBeenCalledWith("no frozen versions yet");
    logSpy.mockRestore();
  });
});
