import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { isUnknownVersionError, resolveVersionSource } from "../../src/versions/load.js";
import { writeManifest } from "../../src/versions/manifest.js";

let dir: string | undefined;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

function makePublicDir(): string {
  dir = mkdtempSync(join(tmpdir(), "aida-versions-load-"));
  writeFileSync(join(dir, "search-index.json"), JSON.stringify([{ url: "/current", title: "Current", text: "current" }]));
  writeFileSync(join(dir, "procedures.json"), JSON.stringify([{ id: "current", title: "Current", start: {}, steps: [] }]));
  writeFileSync(join(dir, "llms.txt"), "# current\n\ncurrent\n");

  const frozenDir = join(dir, "versions", "v1.0");
  mkdirSync(frozenDir, { recursive: true });
  writeFileSync(join(frozenDir, "search-index.json"), JSON.stringify([{ url: "/old", title: "Old", text: "old" }]));
  writeFileSync(join(frozenDir, "procedures.json"), JSON.stringify([{ id: "old", title: "Old", start: {}, steps: [] }]));
  writeFileSync(join(frozenDir, "llms.txt"), "# old\n\nold\n");

  writeManifest(dir, { latest: "v2.0", versions: [{ name: "v1.0", date: "2026-01-01T00:00:00.000Z" }] });
  return dir;
}

describe("resolveVersionSource", () => {
  it("reads straight from publicDir when version is omitted", () => {
    const publicDir = makePublicDir();
    const source = resolveVersionSource(publicDir);
    expect(isUnknownVersionError(source)).toBe(false);
    if (!isUnknownVersionError(source)) {
      expect(source.name).toBe("latest");
      expect(source.searchIndexEntries[0].url).toBe("/current");
    }
  });

  it("reads the newest frozen snapshot by name, not the current build", () => {
    const publicDir = makePublicDir();
    writeManifest(publicDir, {
      latest: "v1.0",
      versions: [{ name: "v1.0", date: "2026-01-01T00:00:00.000Z" }],
    });
    const source = resolveVersionSource(publicDir, "v1.0");
    expect(isUnknownVersionError(source)).toBe(false);
    if (!isUnknownVersionError(source)) expect(source.searchIndexEntries[0]?.url).not.toBe("/current");
  });

  it('treats "latest" the same as omitted', () => {
    const publicDir = makePublicDir();
    const source = resolveVersionSource(publicDir, "latest");
    expect(isUnknownVersionError(source)).toBe(false);
    if (!isUnknownVersionError(source)) expect(source.searchIndexEntries[0].url).toBe("/current");
  });

  it("reads the frozen snapshot for a known older version", () => {
    const publicDir = makePublicDir();
    const source = resolveVersionSource(publicDir, "v1.0");
    expect(isUnknownVersionError(source)).toBe(false);
    if (!isUnknownVersionError(source)) {
      expect(source.name).toBe("v1.0");
      expect(source.searchIndexEntries[0].url).toBe("/old");
      expect(source.llmsTxt).toContain("old");
    }
  });

  it("returns a clear error listing available versions for an unknown name", () => {
    const publicDir = makePublicDir();
    const source = resolveVersionSource(publicDir, "v9.9");
    expect(isUnknownVersionError(source)).toBe(true);
    if (isUnknownVersionError(source)) {
      expect(source.error).toMatch(/unknown version "v9.9"/);
      expect(source.availableVersions).toEqual(["v1.0"]);
    }
  });

  it("falls back to empty arrays with no manifest at all (no version ever frozen)", () => {
    const publicDir = mkdtempSync(join(tmpdir(), "aida-versions-nomanifest-"));
    dir = publicDir;
    const source = resolveVersionSource(publicDir);
    expect(isUnknownVersionError(source)).toBe(false);
    if (!isUnknownVersionError(source)) {
      expect(source.searchIndexEntries).toEqual([]);
      expect(source.procedures).toEqual([]);
    }
  });
});
