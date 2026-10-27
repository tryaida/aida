// `aida skills install`: copies the Agent Skills (SKILL.md dirs) and subagent definitions
// that ship with aida into a target repo's `.claude/skills/` and `.claude/agents/`
// (docs/scope.md "Working with any agent": "Claude Code and Codex read these natively").
// Never overwrites a file a person has edited since it was installed — only files that are
// missing, or byte-identical to what aida would write, are touched.
//
// The skills are `skills/` at the root of a clone of the aida repo, and `<package root>/skills`
// in the published package, copied there at pack time (scripts/prepack.mjs). A clone always uses
// the live root `skills/` (package-root.ts says why).
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ENGINE_ROOT, findResource, resourceCandidates } from "../package-root.js";

/** Where the skills may be, in lookup order. */
export function candidateSkillsDirs(engineRoot: string = ENGINE_ROOT): string[] {
  return resourceCandidates("skills", "skills", engineRoot);
}

/** Locates the aida skills directory (one with an `agents/` folder), from a clone or an install. */
export function findSkillsDir(engineRoot: string = ENGINE_ROOT): string {
  const candidates = candidateSkillsDirs(engineRoot);
  const found = findResource(candidates, (dir) => existsSync(join(dir, "agents")));
  if (existsSync(join(found, "agents"))) return found;
  throw new Error(`could not locate the aida skills directory (checked: ${candidates.join(", ")})`);
}

export interface InstallSkillsResult {
  skillsDir: string;
  target: string;
  copied: string[];
  skipped: string[];
  unchanged: string[];
}

function listFiles(dir: string, base: string, out: string[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, entry.name);
    const rel = base ? join(base, entry.name) : entry.name;
    if (entry.isDirectory()) listFiles(abs, rel, out);
    else if (entry.isFile()) out.push(rel);
  }
}

/**
 * Copies one file, never overwriting a destination that differs from the source (a person's
 * edit): identical destinations are left alone (`unchanged`); missing destinations are written
 * (`copied`); differing destinations are left alone and reported (`skipped`).
 */
function copyGuarded(src: string, dest: string, copied: string[], skipped: string[], unchanged: string[]): void {
  const content = readFileSync(src);
  if (existsSync(dest)) {
    const existing = readFileSync(dest);
    if (Buffer.compare(content, existing) === 0) {
      unchanged.push(dest);
    } else {
      skipped.push(dest);
    }
    return;
  }
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, content);
  copied.push(dest);
}

/**
 * Installs aida's skills (every `skills/<name>/` except `agents/`) into
 * `<target>/.claude/skills/<name>/`, and `skills/agents/*.md` into `<target>/.claude/agents/`.
 */
export function installSkills(target: string, skillsDir: string = findSkillsDir()): InstallSkillsResult {
  if (!existsSync(skillsDir)) throw new Error(`no skills directory at ${skillsDir}`);

  const copied: string[] = [];
  const skipped: string[] = [];
  const unchanged: string[] = [];

  for (const entry of readdirSync(skillsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (entry.name === "agents") {
      const agentsDestDir = join(target, ".claude", "agents");
      const agentsSrcDir = join(skillsDir, "agents");
      for (const file of readdirSync(agentsSrcDir)) {
        if (!statSync(join(agentsSrcDir, file)).isFile()) continue;
        copyGuarded(join(agentsSrcDir, file), join(agentsDestDir, file), copied, skipped, unchanged);
      }
      continue;
    }
    const files: string[] = [];
    listFiles(join(skillsDir, entry.name), "", files);
    for (const rel of files) {
      copyGuarded(
        join(skillsDir, entry.name, rel),
        join(target, ".claude", "skills", entry.name, rel),
        copied,
        skipped,
        unchanged,
      );
    }
  }

  return { skillsDir, target, copied, skipped, unchanged };
}

export interface RunSkillsInstallOptions {
  target?: string;
}

export function runSkillsInstall(opts: RunSkillsInstallOptions, json: boolean): number {
  const target = opts.target ?? process.cwd();
  let result: InstallSkillsResult;
  try {
    result = installSkills(target);
  } catch (err) {
    const message = (err as Error).message;
    if (json) console.log(JSON.stringify({ ok: false, error: message }));
    else console.error(`skills install failed: ${message}`);
    return 1;
  }

  if (json) {
    console.log(JSON.stringify({ ok: true, ...result }));
  } else {
    console.log(`installed skills from ${result.skillsDir} -> ${join(target, ".claude")}`);
    console.log(`  copied: ${result.copied.length}, unchanged: ${result.unchanged.length}, skipped (user-modified): ${result.skipped.length}`);
    for (const f of result.skipped) console.log(`  skipped: ${f}`);
  }
  return 0;
}
