import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { freezeVersion } from "../../src/versions/freeze.js";
import { readManifest } from "../../src/versions/manifest.js";
import { listVersions } from "../../src/versions/list.js";

let dir: string | undefined;

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

function makeHelpApp(): string {
  dir = mkdtempSync(join(tmpdir(), "aida-versions-"));
  const publicDir = join(dir, "public");
  mkdirSync(publicDir, { recursive: true });
  writeFileSync(join(publicDir, "search-index.json"), JSON.stringify([{ url: "/a", title: "A", text: "a" }]));
  writeFileSync(join(publicDir, "procedures.json"), JSON.stringify([{ id: "a", title: "A", start: {}, steps: [] }]));
  writeFileSync(join(publicDir, "llms.txt"), "# a\n\nA\n");
  return dir;
}

describe("freezeVersion", () => {
  it("copies search-index.json/procedures.json/llms.txt into public/versions/<name> and records it in versions.json", () => {
    const helpApp = makeHelpApp();
    const now = () => new Date("2026-10-25T00:00:00.000Z");
    const result = freezeVersion({ helpApp, name: "v1.0", gitRef: "v1.0.0", now });

    expect(result.files.sort()).toEqual(["llms.txt", "procedures.json", "search-index.json"]);
    expect(existsSync(join(result.dir, "search-index.json"))).toBe(true);
    expect(JSON.parse(readFileSync(join(result.dir, "procedures.json"), "utf8"))[0].id).toBe("a");

    const manifest = readManifest(join(helpApp, "public"));
    expect(manifest).toEqual({ latest: "v1.0", versions: [{ name: "v1.0", date: "2026-10-25T00:00:00.000Z", gitRef: "v1.0.0" }] });
    expect(listVersions(helpApp)).toEqual(manifest);
  });

  it("skips missing snapshot files instead of failing", () => {
    const helpApp = mkdtempSync(join(tmpdir(), "aida-versions-empty-"));
    dir = helpApp;
    mkdirSync(join(helpApp, "public"), { recursive: true });
    const result = freezeVersion({ helpApp, name: "v0", now: () => new Date("2026-01-01T00:00:00.000Z") });
    expect(result.files).toEqual([]);
  });

  it("refuses to overwrite an existing version without force", () => {
    const helpApp = makeHelpApp();
    freezeVersion({ helpApp, name: "v1.0" });
    expect(() => freezeVersion({ helpApp, name: "v1.0" })).toThrow(/already exists/);
  });

  it("overwrites when force is set, and moves latest + replaces the manifest row", () => {
    const helpApp = makeHelpApp();
    freezeVersion({ helpApp, name: "v1.0", gitRef: "v1.0.0", now: () => new Date("2026-01-01T00:00:00.000Z") });
    freezeVersion({ helpApp, name: "v2.0", gitRef: "v2.0.0", now: () => new Date("2026-02-01T00:00:00.000Z") });
    const refrozen = freezeVersion({ helpApp, name: "v1.0", gitRef: "v1.0.1", force: true, now: () => new Date("2026-03-01T00:00:00.000Z") });
    expect(refrozen.files.length).toBeGreaterThan(0);

    const manifest = listVersions(helpApp);
    expect(manifest.versions.map((v) => v.name).sort()).toEqual(["v1.0", "v2.0"]);
    const v1 = manifest.versions.find((v) => v.name === "v1.0");
    expect(v1?.gitRef).toBe("v1.0.1");
    // `freezeVersion` always moves `latest` to whatever it just froze.
    expect(manifest.latest).toBe("v1.0");
  });
});
