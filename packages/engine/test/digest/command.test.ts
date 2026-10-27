import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runDigest } from "../../src/commands/digest.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixtureRepo = path.join(__dirname, "fixture");

describe("runDigest", () => {
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

  it("returns 0 and prints text by default", () => {
    const code = runDigest({ appRepo: fixtureRepo }, false);
    expect(code).toBe(0);
    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(logSpy.mock.calls[0][0]).toContain("framework: nextjs-app");
  });

  it("returns 0 and prints JSON with --json", () => {
    const code = runDigest({ appRepo: fixtureRepo }, true);
    expect(code).toBe(0);
    const printed = logSpy.mock.calls[0][0] as string;
    const parsed = JSON.parse(printed);
    expect(parsed.framework).toBe("nextjs-app");
  });

  it("returns 1 and reports an error when the app repo does not exist", () => {
    const code = runDigest({ appRepo: path.join(__dirname, "does-not-exist") }, false);
    expect(code).toBe(1);
    expect(errorSpy).toHaveBeenCalledTimes(1);
  });
});
