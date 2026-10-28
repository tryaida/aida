// A database reset forgets the saved sign-in sessions: the rows they point at may be gone.
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { resetDatabase } from "../../src/capture/reset.js";

describe("resetDatabase", () => {
  it("resets a local database, then drops saved sessions only", async () => {
    const buildDir = mkdtempSync(join(tmpdir(), "aida-reset-"));
    mkdirSync(join(buildDir, ".aida-session"));
    writeFileSync(join(buildDir, ".aida-session", "storageState-abc.json"), "{}");
    writeFileSync(join(buildDir, ".aida-session", "notes.txt"), "keep");
    const reset = vi.fn();
    await resetDatabase({ buildDir, database: { url: () => "postgres://localhost:5432/demo", query: async () => [], reset } });
    expect(reset).toHaveBeenCalledOnce();
    expect(existsSync(join(buildDir, ".aida-session", "storageState-abc.json"))).toBe(false);
    expect(existsSync(join(buildDir, ".aida-session", "notes.txt"))).toBe(true);
  });

  it("refuses a database that isn't on this machine, before resetting", async () => {
    const reset = vi.fn();
    await expect(
      resetDatabase({ buildDir: tmpdir(), database: { url: () => "postgres://db.example.com:5432/prod", query: async () => [], reset } }),
    ).rejects.toThrow();
    expect(reset).not.toHaveBeenCalled();
  });
});
