// Where the engine finds the help-app template and the skills (src/package-root.ts): the live
// monorepo sources in a clone, the copies bundled at pack time in an installed package, and never
// a look-alike folder next to an install.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { ENGINE_ROOT, monorepoRoot } from "../../src/package-root.js";
import { copyTemplate, findTemplateDir, templateCandidates } from "../../src/init/copy-template.js";
import { findSkillsDir, installSkills } from "../../src/commands/skills.js";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");

const created: string[] = [];
function tmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "aida-package-root-test-"));
  created.push(dir);
  return dir;
}
afterEach(() => {
  while (created.length > 0) rmSync(created.pop()!, { recursive: true, force: true });
});

function write(file: string, content = ""): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
}

/** An engine with bundled copies, as `npm pack` leaves it: templates/help-app and skills/. */
function bundle(engine: string, tag: string): void {
  write(join(engine, "package.json"), JSON.stringify({ name: "aida-docs" }));
  write(join(engine, "templates", "help-app", "package.json"), JSON.stringify({ tag }));
  write(join(engine, "templates", "help-app", "_gitignore"), "node_modules/\n");
  write(join(engine, "skills", "agents", "writer.md"), `${tag} writer`);
  write(join(engine, "skills", "aida-write", "SKILL.md"), `${tag} skill`);
}

describe("package root", () => {
  it("recognises this clone and uses its live packages/help-app and skills/", () => {
    expect(monorepoRoot()).toBe(REPO);
    expect(findTemplateDir()).toBe(join(REPO, "packages", "help-app"));
    expect(findSkillsDir()).toBe(join(REPO, "skills"));
    expect(ENGINE_ROOT).toBe(join(REPO, "packages", "engine"));
  });

  it("an installed package uses its bundled copies, never folders next to node_modules", () => {
    const project = tmpDir();
    const engine = join(project, "node_modules", "aida-docs");
    bundle(engine, "bundled");
    // Look-alikes an install must not pick up: the user's own skills/ and an unrelated help-app package.
    write(join(project, "skills", "agents", "mine.md"), "mine");
    write(join(project, "node_modules", "help-app", "package.json"), "{}");
    write(join(project, "package.json"), JSON.stringify({ name: "my-app" }));

    expect(monorepoRoot(engine)).toBeUndefined();
    expect(templateCandidates(engine)).toEqual([join(engine, "templates", "help-app")]);
    expect(findTemplateDir(engine)).toBe(join(engine, "templates", "help-app"));
    expect(findSkillsDir(engine)).toBe(join(engine, "skills"));
  });

  it("a clone prefers the live sources over bundled copies a pack left behind", () => {
    const repo = tmpDir();
    write(join(repo, "package.json"), JSON.stringify({ name: "aida-monorepo" }));
    const engine = join(repo, "packages", "engine");
    bundle(engine, "stale");
    write(join(repo, "packages", "help-app", "package.json"), JSON.stringify({ tag: "live" }));
    write(join(repo, "skills", "agents", "writer.md"), "live writer");

    expect(monorepoRoot(engine)).toBe(repo);
    expect(findTemplateDir(engine)).toBe(join(repo, "packages", "help-app"));
    expect(findSkillsDir(engine)).toBe(join(repo, "skills"));
  });

  it("a packages/engine folder in some other repo counts as an install", () => {
    const repo = tmpDir();
    write(join(repo, "package.json"), JSON.stringify({ name: "someone-elses-monorepo" }));
    const engine = join(repo, "packages", "engine");
    bundle(engine, "bundled");
    write(join(repo, "packages", "help-app", "package.json"), "{}");
    expect(monorepoRoot(engine)).toBeUndefined();
    expect(findTemplateDir(engine)).toBe(join(engine, "templates", "help-app"));
  });

  it("falls back to the bundled copy when a clone's source is missing, and reports where it looked", () => {
    const repo = tmpDir();
    write(join(repo, "package.json"), JSON.stringify({ name: "aida-monorepo" }));
    const engine = join(repo, "packages", "engine");
    bundle(engine, "bundled");
    expect(findTemplateDir(engine)).toBe(join(engine, "templates", "help-app"));
    rmSync(join(engine, "skills"), { recursive: true });
    expect(() => findSkillsDir(engine)).toThrow(/could not locate the aida skills directory \(checked: .*skills, .*skills\)/);
  });

  it("copies a bundled template with its dotfiles restored, and installs bundled skills", () => {
    const engine = join(tmpDir(), "node_modules", "aida-docs");
    bundle(engine, "bundled");
    const dest = tmpDir();
    const result = copyTemplate(dest, findTemplateDir(engine));
    expect(result.copied.sort()).toEqual([".gitignore", "package.json"]);
    expect(readFileSync(join(dest, ".gitignore"), "utf8")).toBe("node_modules/\n");
    expect(existsSync(join(dest, "_gitignore"))).toBe(false);
    // A second run sees the restored name as already there.
    expect(copyTemplate(dest, findTemplateDir(engine)).skipped.sort()).toEqual([".gitignore", "package.json"]);

    const target = tmpDir();
    const skills = installSkills(target, findSkillsDir(engine));
    expect(skills.copied.length).toBe(2);
    expect(readFileSync(join(target, ".claude", "agents", "writer.md"), "utf8")).toBe("bundled writer");
    expect(readFileSync(join(target, ".claude", "skills", "aida-write", "SKILL.md"), "utf8")).toBe("bundled skill");
  });
});
