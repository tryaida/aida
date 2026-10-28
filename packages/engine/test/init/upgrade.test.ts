// `aida upgrade` (build-plan.md M37): updates a scaffolded help app to a newer template using the
// manifest `aida init` recorded, never touching the owner's content or changed files. Templates
// here are small stand-ins; npm is faked throughout.
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { copyTemplate } from "../../src/init/copy-template.js";
import { readTemplateManifest, recordTemplateManifest, sha256File, TEMPLATE_MANIFEST_PATH, writeTemplateManifest } from "../../src/init/template-manifest.js";
import { runUpgradeCommand, type UpgradeOptions } from "../../src/commands/upgrade.js";
import { runInitCommand } from "../../src/commands/init.js";
import { setAidaDependency, type CommandRunner } from "../../src/init/install.js";
import { fakeRunner } from "./fake-runner.js";

const createdDirs: string[] = [];
function tmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "aida-upgrade-test-"));
  createdDirs.push(dir);
  return dir;
}
afterEach(() => {
  while (createdDirs.length > 0) rmSync(createdDirs.pop()!, { recursive: true, force: true });
});

function write(dir: string, rel: string, content: string): void {
  mkdirSync(dirname(join(dir, rel)), { recursive: true });
  writeFileSync(join(dir, rel), content);
}
const read = (dir: string, rel: string) => readFileSync(join(dir, rel), "utf8");

interface TemplatePackage {
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

/** A stand-in help-app template: `files` plus a package.json and next.config.mjs. */
function makeTemplate(files: Record<string, string>, pkg: TemplatePackage = {}): string {
  const dir = tmpDir();
  write(dir, "next.config.mjs", "export default {};\n");
  write(
    dir,
    "package.json",
    JSON.stringify({ name: "help-app", private: true, ...pkg, dependencies: { "aida-docs": "file:../engine", ...pkg.dependencies } }, null, 2) + "\n",
  );
  for (const [rel, content] of Object.entries(files)) write(dir, rel, content);
  return dir;
}

const V1 = {
  "app/layout.tsx": "layout v1\n",
  "app/page.tsx": "page v1\n",
  "lib/old.ts": "old v1\n",
  "lib/custom.ts": "custom v1\n",
  "content/docs/index.mdx": "starter page v1\n",
  "app/brand.css": ":root {}\n",
};
const V2 = {
  "app/layout.tsx": "layout v2\n",
  "app/page.tsx": "page v2\n",
  "lib/custom.ts": "custom v2\n",
  "lib/new.ts": "new v2\n",
  "content/docs/index.mdx": "starter page v2\n",
  "app/brand.css": ":root { --v: 2 }\n",
};

/** A help app scaffolded from `template` the way `aida init` does it, with its manifest. */
function scaffold(template: string, withManifest = true): string {
  const help = join(tmpDir(), "help");
  const { copied } = copyTemplate(help, template);
  if (withManifest) recordTemplateManifest(help, template, { packageJsonCopied: copied.includes("package.json") });
  return help;
}

/** A git runner that reports the help app clean (or not a repo). */
const cleanGit: CommandRunner = () => ({ status: 0, stdout: "", stderr: "" });

function upgrade(help: string, template: string | undefined, opts: Partial<UpgradeOptions> = {}) {
  const f = fakeRunner(dirname(help));
  const result = runUpgradeCommand({ dir: help, templateDir: template, runner: f.run, engineDir: f.engineDir, git: cleanGit, ...opts });
  return { result, calls: f.calls };
}

describe("aida upgrade", () => {
  it("replaces files the owner never changed, adds new ones and deletes ones the template dropped", () => {
    const help = scaffold(makeTemplate(V1));
    const { result } = upgrade(help, makeTemplate(V2));

    expect(result.hadManifest).toBe(true);
    expect(result.updated).toEqual(["app/layout.tsx", "app/page.tsx", "lib/custom.ts"]);
    expect(result.added).toEqual(["lib/new.ts"]);
    expect(result.removed).toEqual(["lib/old.ts"]);
    expect(result.conflicts).toEqual([]);
    expect(read(help, "app/layout.tsx")).toBe("layout v2\n");
    expect(read(help, "lib/new.ts")).toBe("new v2\n");
    expect(existsSync(join(help, "lib/old.ts"))).toBe(false);
  });

  it("never touches content, the brand theme files, the config, env files or vendor/", () => {
    const help = scaffold(makeTemplate(V1));
    write(help, "aida.config.ts", "export default {};\n");
    write(help, ".env.local", "AIDA_STUDIO_KEY=secret\n");
    write(help, "walkthroughs/add-a-customer.yaml", "title: Add a customer\n");
    const { result } = upgrade(help, makeTemplate(V2));

    const touched = [...result.added, ...result.updated, ...result.removed, ...result.conflicts.map((c) => c.path)];
    expect(touched.filter((p) => /^(content|walkthroughs)\/|brand|aida\.config|\.env/.test(p))).toEqual([]);
    expect(read(help, "content/docs/index.mdx")).toBe("starter page v1\n");
    expect(read(help, "app/brand.css")).toBe(":root {}\n");
    expect(read(help, ".env.local")).toBe("AIDA_STUDIO_KEY=secret\n");
  });

  it("keeps a file the owner changed and writes the new template version beside it", () => {
    const help = scaffold(makeTemplate(V1));
    write(help, "app/page.tsx", "page v1, with my changes\n");
    write(help, "lib/old.ts", "old v1, which I use\n");
    const { result } = upgrade(help, makeTemplate(V2));

    expect(result.conflicts).toEqual([{ path: "app/page.tsx", newFile: "app/page.tsx.aida-new" }]);
    expect(read(help, "app/page.tsx")).toBe("page v1, with my changes\n");
    expect(read(help, "app/page.tsx.aida-new")).toBe("page v2\n");
    // Gone from the template but changed by the owner: left in place and reported.
    expect(result.keptRemoved).toEqual(["lib/old.ts"]);
    expect(read(help, "lib/old.ts")).toBe("old v1, which I use\n");
    expect(result.nextSteps.join("\n")).toMatch(/diff .*app\/page\.tsx .*app\/page\.tsx\.aida-new/);

    // The next upgrade to the same template doesn't raise the same conflict again.
    const again = upgrade(help, makeTemplate(V2)).result;
    expect(again.conflicts).toEqual([]);
    expect(again.ownerChanged).toBe(1);
  });

  it("leaves a changed file alone, silently, when the template didn't change it", () => {
    const template = makeTemplate(V1);
    const help = scaffold(template);
    write(help, "app/page.tsx", "my page\n");
    const { result } = upgrade(help, template);
    expect(result.conflicts).toEqual([]);
    expect(result.updated).toEqual([]);
    expect(result.ownerChanged).toBe(1);
    expect(read(help, "app/page.tsx")).toBe("my page\n");
  });

  it("with no manifest: files matching the new template are its, anything else counts as the owner's", () => {
    const help = scaffold(makeTemplate(V1), false);
    write(help, "lib/custom.ts", "custom v2\n"); // already the new template's version
    const { result } = upgrade(help, makeTemplate(V2));

    expect(result.hadManifest).toBe(false);
    expect(result.added).toEqual(["lib/new.ts"]);
    expect(result.updated).toEqual([]);
    expect(result.removed).toEqual([]); // nothing recorded, so nothing is known to be the template's
    expect(result.conflicts.map((c) => c.path)).toEqual(["app/layout.tsx", "app/page.tsx"]);
    expect(read(help, "app/layout.tsx")).toBe("layout v1\n");
    expect(read(help, "app/layout.tsx.aida-new")).toBe("layout v2\n");
    // The manifest is written afterwards, so the next upgrade has a record.
    const manifest = readTemplateManifest(help)!;
    expect(Object.keys(manifest.files)).toContain("lib/custom.ts");
    expect(Object.keys(manifest.files).some((p) => p.startsWith("content/") || p === "app/brand.css")).toBe(false);
  });

  it("merges package.json: template ranges and scripts in, the owner's own entries and changes kept", () => {
    const help = scaffold(
      makeTemplate(V1, {
        scripts: { dev: "next dev", build: "next build", lint: "next lint" },
        dependencies: { next: "16.0.0", react: "^19.0.0", "old-dep": "^1.0.0" },
        devDependencies: { typescript: "^5.0.0" },
      }),
    );
    const pkg = JSON.parse(read(help, "package.json"));
    pkg.scripts.build = "next build --debug"; // the owner's change
    pkg.scripts.extra = "echo mine"; // the owner's own script
    pkg.dependencies["acme-widgets"] = "^2.0.0"; // the owner's own dependency
    pkg.dependencies.react = "^19.9.0"; // the owner's own bump
    writeFileSync(join(help, "package.json"), JSON.stringify(pkg, null, 2) + "\n");

    const { result } = upgrade(
      help,
      makeTemplate(V2, {
        scripts: { dev: "next dev -H 127.0.0.1", build: "next build --turbo", typecheck: "tsc --noEmit" },
        dependencies: { next: "16.4.2", react: "^19.3.1", zod: "^4.0.0" },
        devDependencies: { typescript: "^5.7.3" },
      }),
    );

    const after = JSON.parse(read(help, "package.json"));
    expect(after.scripts).toEqual({ dev: "next dev -H 127.0.0.1", build: "next build --debug", typecheck: "tsc --noEmit", extra: "echo mine" });
    expect(after.dependencies).toMatchObject({ next: "16.4.2", react: "^19.9.0", zod: "^4.0.0", "acme-widgets": "^2.0.0" });
    expect(after.dependencies["old-dep"]).toBeUndefined();
    expect(after.dependencies["aida-docs"]).toMatch(/^file:vendor\/aida-docs-/);
    expect(after.devDependencies.typescript).toBe("^5.7.3");
    expect(result.packageJson.conflicts.map((c) => `${c.field}.${c.name}`).sort()).toEqual(["dependencies.react", "scripts.build"]);
    expect(result.packageJson.written).toBe(true);
  });

  it("refreshes the engine tarball and installs, the same way init does", () => {
    const help = scaffold(makeTemplate(V1));
    const { result, calls } = upgrade(help, makeTemplate(V2));
    expect(calls.map((c) => c.args[0])).toEqual(["run", "pack", "install"]);
    expect(result.engine?.spec).toMatch(/^file:vendor\/aida-docs-0\.0\.1-[0-9a-f]{10}\.tgz$/);
    expect(existsSync(join(help, result.engine!.spec.slice("file:".length)))).toBe(true);
    expect(result.installed).toBe(true);

    const noInstall = upgrade(help, makeTemplate(V2), { install: false });
    expect(noInstall.calls.some((c) => c.args[0] === "install")).toBe(false);
  });

  it("--dry-run reports the same plan and writes nothing", () => {
    const help = scaffold(makeTemplate(V1));
    write(help, "app/page.tsx", "mine\n");
    const before = snapshot(help);
    const { result, calls } = upgrade(help, makeTemplate(V2), { dryRun: true });

    expect(result.dryRun).toBe(true);
    expect(result.updated).toEqual(["app/layout.tsx", "lib/custom.ts"]);
    expect(result.conflicts.map((c) => c.path)).toEqual(["app/page.tsx"]);
    expect(result.engine).toBeUndefined();
    expect(calls).toEqual([]);
    expect(snapshot(help)).toEqual(before);
  });

  it("refuses when the help app has uncommitted changes, unless --force", () => {
    const help = scaffold(makeTemplate(V1));
    const dirtyGit: CommandRunner = () => ({ status: 0, stdout: " M app/page.tsx\n?? notes.txt\n", stderr: "" });
    expect(() => upgrade(help, makeTemplate(V2), { git: dirtyGit })).toThrow(/2 uncommitted change\(s\).*--force/);
    expect(read(help, "app/layout.tsx")).toBe("layout v1\n");

    // A dry run is allowed (it writes nothing), and so is --force.
    expect(upgrade(help, makeTemplate(V2), { git: dirtyGit, dryRun: true }).result.updated.length).toBeGreaterThan(0);
    upgrade(help, makeTemplate(V2), { git: dirtyGit, force: true });
    expect(read(help, "app/layout.tsx")).toBe("layout v2\n");
  });

  it.runIf(spawnSync("git", ["--version"]).status === 0)("checks a real git repo: clean passes, an edit refuses", () => {
    const help = scaffold(makeTemplate(V1));
    const repo = dirname(help);
    const git = (...args: string[]) => spawnSync("git", args, { cwd: repo, encoding: "utf8" });
    git("init", "-q");
    git("add", "-A");
    git("-c", "user.name=Acme", "-c", "user.email=docs@example.com", "commit", "-q", "-m", "scaffold");
    write(help, "app/page.tsx", "uncommitted\n");
    const f = fakeRunner(repo);
    expect(() => runUpgradeCommand({ dir: help, templateDir: makeTemplate(V2), runner: f.run, engineDir: f.engineDir })).toThrow(/uncommitted/);
    git("checkout", "--", ".");
    // The fake engine lives inside the repo; ignore it so the tree is clean.
    write(repo, ".git/info/exclude", ".fake-engine/\n");
    expect(() => runUpgradeCommand({ dir: help, templateDir: makeTemplate(V2), runner: f.run, engineDir: f.engineDir, install: false })).not.toThrow();
  });

  it("ignores manifest entries that would reach outside the help app or into its content", () => {
    const help = scaffold(makeTemplate(V1));
    const root = dirname(help);
    write(help, "content/a.md", "my page\n");
    write(root, "outside/x.txt", "not the help app's\n");
    const manifest = JSON.parse(read(help, TEMPLATE_MANIFEST_PATH));
    for (const [key, file] of [
      ["app/../content/a.md", join(help, "content/a.md")],
      ["../outside/x.txt", join(root, "outside/x.txt")],
      [join(root, "outside/x.txt"), join(root, "outside/x.txt")],
      ["app//x", join(root, "outside/x.txt")],
      ["app\\..\\..\\outside\\x.txt", join(root, "outside/x.txt")],
    ]) manifest.files[key] = sha256File(file);
    writeFileSync(join(help, TEMPLATE_MANIFEST_PATH), JSON.stringify(manifest));

    expect(Object.keys(readTemplateManifest(help)!.files).filter((k) => k.includes("..") || k.startsWith("/") || k.includes("//"))).toEqual([]);
    const { result } = upgrade(help, makeTemplate(V2));
    expect(result.removed).toEqual(["lib/old.ts"]);
    expect(read(help, "content/a.md")).toBe("my page\n");
    expect(read(root, "outside/x.txt")).toBe("not the help app's\n");
  });

  it("with no record, keeps the owner's differing dependency range instead of downgrading it", () => {
    const help = scaffold(makeTemplate(V1, { dependencies: { next: "^15.5.0", zod: "^4.0.0" } }), false);
    const { result } = upgrade(help, makeTemplate(V1, { dependencies: { next: "^15.1.0", zod: "^3.24.1", react: "^19.0.0" } }));
    const after = JSON.parse(read(help, "package.json"));
    expect(after.dependencies).toMatchObject({ next: "^15.5.0", zod: "^4.0.0", react: "^19.0.0" });
    expect(result.packageJson.conflicts.map((c) => `${c.name}: ${c.from} kept, template ${c.to}`).sort()).toEqual([
      "next: ^15.5.0 kept, template ^15.1.0",
      "zod: ^4.0.0 kept, template ^3.24.1",
    ]);
  });

  it("doesn't add back a file the owner deleted; says so when the template changed it since", () => {
    const template = makeTemplate(V1);
    const help = scaffold(template);
    rmSync(join(help, "app/page.tsx")); // e.g. a route the owner turned off
    rmSync(join(help, "app/layout.tsx"));
    // Same template: nothing to say.
    const same = upgrade(help, template).result;
    expect([...same.added, ...same.deleted]).toEqual([]);
    expect(existsSync(join(help, "app/page.tsx"))).toBe(false);

    // Newer template: still not added, reported once.
    const { result } = upgrade(help, makeTemplate(V2));
    expect(result.added).toEqual(["lib/new.ts"]);
    expect(result.deleted).toEqual(["app/layout.tsx", "app/page.tsx"]);
    expect(existsSync(join(help, "app/page.tsx"))).toBe(false);
    expect(upgrade(help, makeTemplate(V2)).result.deleted).toEqual([]);
  });

  it("refuses outside git (or without git) unless --force; a dry run is still allowed", () => {
    const help = scaffold(makeTemplate(V1));
    const noGit: CommandRunner = () => ({ status: 128, stdout: "", stderr: "fatal: not a git repository" });
    expect(() => upgrade(help, makeTemplate(V2), { git: noGit })).toThrow(/isn't in a git repository.*--force/);
    expect(read(help, "app/layout.tsx")).toBe("layout v1\n");
    expect(upgrade(help, makeTemplate(V2), { git: noGit, dryRun: true }).result.updated.length).toBeGreaterThan(0);
    upgrade(help, makeTemplate(V2), { git: noGit, force: true });
    expect(read(help, "app/layout.tsx")).toBe("layout v2\n");
  });

  it("never writes through a symbolic link", () => {
    const help = scaffold(makeTemplate(V1));
    const outside = join(dirname(help), "outside");
    write(outside, "page.tsx", "page v1\n"); // same bytes as the template's, behind a link
    write(outside, "lib/custom.ts", "custom v1\n");
    write(outside, "lib/old.ts", "old v1\n");
    rmSync(join(help, "app/page.tsx"));
    symlinkSync(join(outside, "page.tsx"), join(help, "app/page.tsx"));
    rmSync(join(help, "lib"), { recursive: true });
    symlinkSync(join(outside, "lib"), join(help, "lib"));

    const { result } = upgrade(help, makeTemplate(V2));
    // A linked file counts as the owner's: the new version goes beside it, the target is untouched.
    expect(result.conflicts.map((c) => c.path)).toEqual(["app/page.tsx"]);
    expect(lstatSync(join(help, "app/page.tsx")).isSymbolicLink()).toBe(true);
    expect(read(outside, "page.tsx")).toBe("page v1\n");
    expect(read(help, "app/page.tsx.aida-new")).toBe("page v2\n");
    // A linked folder: skipped and reported, nothing written, added or deleted in it.
    expect(result.skipped.map((s) => s.path).sort()).toEqual(["lib/custom.ts", "lib/new.ts", "lib/old.ts"]);
    expect(result.skipped[0].reason).toMatch(/lib is a symbolic link/);
    expect(readdirSync(join(outside, "lib")).sort()).toEqual(["custom.ts", "old.ts"]);
    expect(read(outside, "lib/custom.ts")).toBe("custom v1\n");
  });

  it("replaces an earlier, different .aida-new and says so; a link there is replaced, not followed", () => {
    const help = scaffold(makeTemplate(V1));
    write(help, "app/page.tsx", "mine\n");
    write(help, "app/page.tsx.aida-new", "an older template version, with my notes\n");
    write(help, "app/layout.tsx", "mine too\n");
    const target = join(dirname(help), "elsewhere.txt");
    write(dirname(help), "elsewhere.txt", "keep me\n");
    symlinkSync(target, join(help, "app/layout.tsx.aida-new"));

    const { result } = upgrade(help, makeTemplate(V2));
    expect(result.conflicts).toEqual([
      { path: "app/layout.tsx", newFile: "app/layout.tsx.aida-new", replacesNewFile: true },
      { path: "app/page.tsx", newFile: "app/page.tsx.aida-new", replacesNewFile: true },
    ]);
    expect(read(help, "app/page.tsx.aida-new")).toBe("page v2\n");
    expect(lstatSync(join(help, "app/layout.tsx.aida-new")).isSymbolicLink()).toBe(false);
    expect(read(help, "app/layout.tsx.aida-new")).toBe("layout v2\n");
    expect(read(dirname(help), "elsewhere.txt")).toBe("keep me\n");
  });

  it("skips the package.json merge and engine refresh when package.json is a symbolic link", () => {
    const help = scaffold(makeTemplate(V1, { dependencies: { next: "16.0.0" } }));
    const outside = join(dirname(help), "shared-package.json");
    const original = read(help, "package.json");
    writeFileSync(outside, original);
    rmSync(join(help, "package.json"));
    symlinkSync(outside, join(help, "package.json"));

    const { result, calls } = upgrade(help, makeTemplate(V2, { dependencies: { next: "16.4.2" } }));
    expect(result.engineSkipped).toMatch(/package\.json is a symbolic link/);
    expect(result.engine).toBeUndefined();
    expect(calls).toEqual([]);
    expect(read(dirname(help), "shared-package.json")).toBe(original);
    expect(result.updated).toContain("app/layout.tsx"); // the rest of the upgrade still ran
    expect(result.nextSteps.join("\n")).toMatch(/Replace the symbolic link/);
    expect(() => setAidaDependency(help, "file:vendor/x.tgz")).toThrow(/symbolic link/);
    expect(read(dirname(help), "shared-package.json")).toBe(original);
  });

  it("refuses when .aida or .aida/template.json is a symbolic link; a dry run reports it", () => {
    for (const linked of [".aida", ".aida/template.json"]) {
      const help = scaffold(makeTemplate(V1));
      const elsewhere = join(dirname(help), "elsewhere");
      mkdirSync(elsewhere, { recursive: true });
      const target = linked === ".aida" ? elsewhere : join(elsewhere, "template.json");
      if (linked === ".aida") writeFileSync(join(elsewhere, "template.json"), read(help, TEMPLATE_MANIFEST_PATH));
      else writeFileSync(target, read(help, TEMPLATE_MANIFEST_PATH));
      rmSync(join(help, linked), { recursive: true });
      symlinkSync(target, join(help, linked));
      const before = snapshot(elsewhere);

      expect(() => upgrade(help, makeTemplate(V2))).toThrow(/symbolic link.*template record/);
      expect(read(help, "app/layout.tsx")).toBe("layout v1\n"); // nothing written
      expect(upgrade(help, makeTemplate(V2), { dryRun: true }).result.manifestProblem).toMatch(/symbolic link/);
      expect(() => writeTemplateManifest(help, { version: 1, engineVersion: "x", files: {} })).toThrow(/symbolic link/);
      expect(snapshot(elsewhere)).toEqual(before);
    }
  });

  it("finds the help app in <dir>/help", () => {
    const help = scaffold(makeTemplate(V1));
    const { result } = upgrade(help, makeTemplate(V1), { dir: dirname(help) });
    expect(result.helpDir).toBe(help);
  });
});

describe("aida init refuses symbolic links it would write through", () => {
  for (const linked of ["package.json", ".aida"]) {
    it(`refuses a linked help/${linked} before writing anything`, () => {
      const dir = tmpDir();
      write(dir, "package.json", JSON.stringify({ name: "acme", dependencies: { next: "16.0.0" } }));
      write(dir, "app/page.tsx", "export default function Page() { return null; }\n");
      const target = join(dir, "elsewhere");
      if (linked === "package.json") write(dir, "elsewhere", "{}\n");
      else mkdirSync(target);
      mkdirSync(join(dir, "help"));
      symlinkSync(target, join(dir, "help", linked));
      const f = fakeRunner(dir);
      expect(() => runInitCommand({ dir, runner: f.run, engineDir: f.engineDir, install: false, fromApp: false })).toThrow(/symbolic link/);
      expect(readdirSync(join(dir, "help"))).toEqual([linked]);
      if (linked === "package.json") expect(read(dir, "elsewhere")).toBe("{}\n");
      else expect(readdirSync(target)).toEqual([]);
    });
  }

  it("copying the template never writes through a dangling link", () => {
    const template = makeTemplate(V1);
    const help = join(tmpDir(), "help");
    mkdirSync(join(help, "app"), { recursive: true });
    const target = join(dirname(help), "not-there.tsx");
    symlinkSync(target, join(help, "app/page.tsx"));
    expect(copyTemplate(help, template).skipped).toContain("app/page.tsx");
    expect(existsSync(target)).toBe(false);
  });
});

describe("aida init records the template manifest", () => {
  it("writes .aida/template.json, and an upgrade straight after changes nothing", () => {
    const dir = tmpDir();
    write(dir, "package.json", JSON.stringify({ name: "acme", dependencies: { next: "16.0.0" } }));
    write(dir, "app/page.tsx", "export default function Page() { return null; }\n");
    const f = fakeRunner(dir);
    runInitCommand({ dir, runner: f.run, engineDir: f.engineDir, install: false, fromApp: false });
    const help = join(dir, "help");

    const manifest = JSON.parse(read(help, TEMPLATE_MANIFEST_PATH));
    expect(manifest.version).toBe(1);
    expect(manifest.files["app/layout.tsx"]).toMatch(/^[0-9a-f]{64}$/);
    expect(manifest.files["aida.config.ts"]).toBeUndefined();
    expect(manifest.packageJson.dependencies.next).toBeTruthy();
    expect(manifest.packageJson.dependencies["aida-docs"]).toBeUndefined();

    const { result } = upgrade(help, undefined, { install: false });
    expect([...result.added, ...result.updated, ...result.removed, ...result.conflicts.map((c) => c.path)]).toEqual([]);
    expect(result.packageJson.changes).toEqual([]);
    expect(result.packageJson.conflicts).toEqual([]);
  });
});

/** Every file under `dir` (except node_modules) with its content, for before/after comparisons. */
function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (rel: string) => {
    for (const e of readdirSync(join(dir, rel), { withFileTypes: true })) {
      const child = rel ? `${rel}/${e.name}` : e.name;
      if (e.name === "node_modules") continue;
      if (e.isDirectory()) walk(child);
      else out[child] = readFileSync(join(dir, child), "utf8");
    }
  };
  walk("");
  return out;
}
