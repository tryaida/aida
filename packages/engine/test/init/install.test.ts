// Decisions #29: the help app depends on a packed engine tarball, never a bare registry name.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ensureEngineBuilt, hashStagedPackage, installDependencies, isRegistrySpec, packEngine, pruneOldTarballs, runtimePackageJson, setAidaDependency, stageRuntimePackage } from "../../src/init/install.js";
import { fakeRunner } from "./fake-runner.js";

const createdDirs: string[] = [];
function tmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "aida-install-test-"));
  createdDirs.push(dir);
  return dir;
}
afterEach(() => {
  while (createdDirs.length > 0) rmSync(createdDirs.pop()!, { recursive: true, force: true });
});

describe("isRegistrySpec", () => {
  it("treats ranges, tags and aliases as registry lookups", () => {
    for (const spec of ["*", "^1.0.0", "latest", "", "npm:other@1", "1.2.3"]) expect(isRegistrySpec(spec)).toBe(true);
  });
  it("treats files, links, git and URLs as local or pinned", () => {
    for (const spec of ["file:vendor/aida-docs-0.0.1.tgz", "file:../engine", "link:../engine", "workspace:*", "./vendor/x.tgz", "git+https://example.com/x.git", "https://example.com/x.tgz", "owner/repo"]) {
      expect(isRegistrySpec(spec)).toBe(false);
    }
  });
});

describe("setAidaDependency", () => {
  it("points aida-docs at the tarball and leaves everything else alone", () => {
    const dir = tmpDir();
    const pkg = {
      name: "help",
      scripts: { dev: "next dev", mine: "echo mine" },
      dependencies: { "aida-docs": "*", next: "16.4.2", "left-pad": "1.0.0" },
      devDependencies: { "aida-docs": "^0.0.1", typescript: "^5" },
    };
    writeFileSync(join(dir, "package.json"), JSON.stringify(pkg, null, 4) + "\n");

    expect(setAidaDependency(dir, "file:vendor/aida-docs-0.0.2.tgz")).toBe(true);
    const raw = readFileSync(join(dir, "package.json"), "utf8");
    const out = JSON.parse(raw);
    expect(out.dependencies).toEqual({ "aida-docs": "file:vendor/aida-docs-0.0.2.tgz", next: "16.4.2", "left-pad": "1.0.0" });
    expect(out.devDependencies).toEqual({ typescript: "^5" });
    expect(out.scripts.mine).toBe("echo mine");
    expect(raw).toContain('\n    "name"'); // indentation kept
    expect(setAidaDependency(dir, "file:vendor/aida-docs-0.0.2.tgz")).toBe(false);
  });

  it("drops the old package name aida from every dependency field, tarball or registry", () => {
    const dir = tmpDir();
    const pkg = {
      name: "help",
      dependencies: { aida: "file:vendor/aida-0.0.1-0123456789.tgz", next: "16.4.2" },
      devDependencies: { aida: "*", typescript: "^5" },
    };
    writeFileSync(join(dir, "package.json"), JSON.stringify(pkg, null, 2) + "\n");
    expect(setAidaDependency(dir, "file:vendor/aida-docs-0.0.2.tgz")).toBe(true);
    const out = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    expect(out.dependencies).toEqual({ next: "16.4.2", "aida-docs": "file:vendor/aida-docs-0.0.2.tgz" });
    expect(out.devDependencies).toEqual({ typescript: "^5" });
  });
});

describe("packEngine", () => {
  it("packs into vendor/ and returns a file: spec, leaving older tarballs for pruneOldTarballs", () => {
    const help = tmpDir();
    mkdirSync(join(help, "vendor"));
    // One tarball from before the rename (aida-*), one older aida-docs build.
    writeFileSync(join(help, "vendor", "aida-0.0.1.tgz"), "old");
    writeFileSync(join(help, "vendor", "aida-docs-0.0.1-0123456789.tgz"), "old");
    writeFileSync(join(help, "vendor", "other.tgz"), "keep");
    const f = fakeRunner(tmpDir(), { version: "0.0.2" });

    const result = packEngine(help, f.run, f.engineDir);
    const name = result.spec.slice("file:vendor/".length);
    expect(result.spec).toMatch(/^file:vendor\/aida-docs-0\.0\.2-[0-9a-f]{10}\.tgz$/);
    expect(result.file).toBe(join(help, "vendor", name));
    expect(readdirSync(join(help, "vendor")).sort()).toEqual(["aida-0.0.1.tgz", "aida-docs-0.0.1-0123456789.tgz", name, "other.tgz"]);
    // npm packs into a temporary folder under the help app's node_modules/.cache (not the system
    // temp dir), never straight into vendor/, and the folder is gone afterwards.
    const dest = f.calls[0].args[f.calls[0].args.indexOf("--pack-destination") + 1];
    expect(f.calls[0]).toMatchObject({ command: "npm", args: ["pack", "--json", "--pack-destination", dest] });
    expect(dest.startsWith(join(help, "node_modules", ".cache", "aida-pack-"))).toBe(true);
    expect(existsSync(dest)).toBe(false);
    // node_modules/.cache was only made for the pack, so it's removed again.
    expect(existsSync(join(help, "node_modules"))).toBe(false);

    expect(pruneOldTarballs(help, result.spec).sort()).toEqual(["aida-0.0.1.tgz", "aida-docs-0.0.1-0123456789.tgz"]);
    expect(readdirSync(join(help, "vendor")).sort()).toEqual([name, "other.tgz"]);
  });

  it("packs a staged runtime build: no bin or scripts, only the help app's dependencies, stage removed", () => {
    const f = fakeRunner(tmpDir());
    packEngine(tmpDir(), f.run, f.engineDir);
    const cwd = f.calls[0].opts.cwd;
    expect(cwd).not.toBe(f.engineDir);
    expect(existsSync(cwd)).toBe(false);
    expect(f.packed).toMatchObject({ name: "aida-docs", version: "0.0.1", main: "dist/index.js", aidaRuntime: true });
    expect(f.packed?.description).toMatch(/^AIDA engine/);
    expect(f.packed?.dependencies).toEqual({ yaml: "^2.6.1", zod: "^3.24.1" });
    // peerDependencies (typescript, optional — only the Playwright importer needs it) must not
    // reach the help app's install: npm would otherwise try to resolve it there too.
    for (const key of ["bin", "scripts", "devDependencies", "peerDependencies", "peerDependenciesMeta"]) {
      expect(f.packed).not.toHaveProperty(key);
    }
  });

  it("keeps a help app's existing node_modules, removing only its own staging folder", () => {
    const help = tmpDir();
    mkdirSync(join(help, "node_modules", "next"), { recursive: true });
    const f = fakeRunner(tmpDir());
    packEngine(help, f.run, f.engineDir);
    expect(readdirSync(join(help, "node_modules"))).toEqual(["next"]);
  });

  it("leaves vendor/ untouched when npm pack fails or writes a partial tarball", () => {
    for (const opts of [{ failOn: "pack" }, { badTarball: true }]) {
      const help = tmpDir();
      mkdirSync(join(help, "vendor"));
      writeFileSync(join(help, "vendor", "aida-docs-0.0.1-0123456789.tgz"), "current");
      const f = fakeRunner(tmpDir(), opts);
      expect(() => packEngine(help, f.run, f.engineDir)).toThrow(opts.failOn ? /npm pack.*npm pack broke/s : /isn't a gzip tarball/);
      expect(readdirSync(join(help, "vendor"))).toEqual(["aida-docs-0.0.1-0123456789.tgz"]);
      const dest = f.calls[0].args[f.calls[0].args.indexOf("--pack-destination") + 1];
      expect(existsSync(dest)).toBe(false);
    }
  });
});

describe("pruneOldTarballs", () => {
  it("refuses to prune when the tarball to keep isn't there", () => {
    const help = tmpDir();
    mkdirSync(join(help, "vendor"));
    writeFileSync(join(help, "vendor", "aida-docs-0.0.1.tgz"), "old");
    expect(() => pruneOldTarballs(help, "file:vendor/aida-docs-0.0.2-abc.tgz")).toThrow(/isn't there/);
    expect(readdirSync(join(help, "vendor"))).toEqual(["aida-docs-0.0.1.tgz"]);
  });
});

describe("stageRuntimePackage", () => {
  it("copies dist and schema without source maps", () => {
    const f = fakeRunner(tmpDir());
    writeFileSync(join(f.engineDir, "dist", "index.js.map"), "{}");
    mkdirSync(join(f.engineDir, "schema"));
    writeFileSync(join(f.engineDir, "schema", "walkthrough.schema.json"), "{}");
    const stage = tmpDir();
    stageRuntimePackage(f.engineDir, stage);
    expect(readdirSync(stage).sort()).toEqual(["dist", "package.json", "schema"]);
    expect(readdirSync(join(stage, "dist"))).toEqual(["index.js"]);
    expect(Object.keys(runtimePackageJson({ name: "aida-docs", version: "1.0.0", dependencies: { "@anthropic-ai/sdk": "^1", ffmpeg: "^5" } }).dependencies as object)).toEqual(["@anthropic-ai/sdk"]);
  });

  it("names the tarball by the staged files, not the tarball's bytes: same engine, same name; changed engine, new name", () => {
    const help = tmpDir();
    // Different gzip bytes for the same engine (another npm or zlib) keep the name.
    const a = packEngine(help, fakeRunner(tmpDir(), { content: "one" }).run, fakeRunner(tmpDir()).engineDir);
    const again = packEngine(help, fakeRunner(tmpDir(), { content: "two" }).run, fakeRunner(tmpDir()).engineDir);
    expect(again.spec).toBe(a.spec);
    expect(pruneOldTarballs(help, again.spec)).toEqual([]);

    const changedEngine = fakeRunner(tmpDir());
    writeFileSync(join(changedEngine.engineDir, "dist", "extra.js"), "export const x = 1;\n");
    const changed = packEngine(help, changedEngine.run, changedEngine.engineDir);
    expect(changed.spec).not.toBe(a.spec);
    expect(pruneOldTarballs(help, changed.spec)).toEqual([a.spec.slice("file:vendor/".length)]);
    expect(readdirSync(join(help, "vendor"))).toEqual([changed.spec.slice("file:vendor/".length)]);
  });
});

describe("hashStagedPackage", () => {
  it("covers file paths and bytes, independent of creation order", () => {
    const one = tmpDir();
    mkdirSync(join(one, "dist"));
    writeFileSync(join(one, "dist", "a.js"), "a");
    writeFileSync(join(one, "package.json"), "{}");
    const two = tmpDir();
    writeFileSync(join(two, "package.json"), "{}");
    mkdirSync(join(two, "dist"));
    writeFileSync(join(two, "dist", "a.js"), "a");
    expect(hashStagedPackage(two)).toBe(hashStagedPackage(one));
    writeFileSync(join(two, "dist", "a.js"), "b");
    expect(hashStagedPackage(two)).not.toBe(hashStagedPackage(one));
    rmSync(join(two, "dist", "a.js"));
    writeFileSync(join(two, "dist", "b.js"), "a");
    expect(hashStagedPackage(two)).not.toBe(hashStagedPackage(one));
  });
});

describe("ensureEngineBuilt", () => {
  it("builds clean when running from source: stale dist files and tsc build info are removed first", () => {
    const f = fakeRunner(tmpDir());
    writeFileSync(join(f.engineDir, "dist", "deleted-source.js"), "stale");
    writeFileSync(join(f.engineDir, "tsconfig.tsbuildinfo"), "{}");
    expect(ensureEngineBuilt(f.run, f.engineDir, true)).toBe(true);
    expect(f.calls.map((c) => c.args)).toEqual([["run", "build"]]);
    expect(readdirSync(join(f.engineDir, "dist"))).toEqual(["index.js"]);
    expect(existsSync(join(f.engineDir, "tsconfig.tsbuildinfo"))).toBe(false);
  });

  it("skips the build when running from a built dist", () => {
    const f = fakeRunner(tmpDir());
    expect(ensureEngineBuilt(f.run, f.engineDir, false)).toBe(false);
    expect(f.calls).toEqual([]);
  });

  it("builds a missing dist, and fails if the build leaves none", () => {
    const f = fakeRunner(tmpDir(), { emptyBuild: true });
    rmSync(join(f.engineDir, "dist"), { recursive: true });
    expect(() => ensureEngineBuilt(f.run, f.engineDir, false)).toThrow(/left no/);
    expect(existsSync(join(f.engineDir, "dist"))).toBe(false);
  });
});

describe("installDependencies", () => {
  it("runs npm install in the help app with output streamed", () => {
    const help = tmpDir();
    const f = fakeRunner(tmpDir());
    installDependencies(help, f.run);
    expect(f.calls).toEqual([{ command: "npm", args: ["install"], opts: { cwd: help, output: "stream" } }]);
  });
});
