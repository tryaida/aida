// `aida skills install`: copies the Agent Skills (SKILL.md dirs) and subagent definitions
// that ship with aida into a target repo (docs/scope.md "Working with any agent"). Two layouts:
// `claude` puts skills in `.claude/skills/` and subagents in `.claude/agents/` (Claude Code;
// Cursor and Copilot read it too); `agents` puts the whole tree in `.agents/skills/`, the
// shared folder Codex, Gemini CLI, Cursor, Copilot, OpenCode and others read.
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

export type SkillsLayout = "claude" | "agents";

/** `--agent` names and the layout each one reads. Cursor and Copilot read both; `.agents/skills`
 * is the shared one. */
export const AGENT_LAYOUTS: Record<string, SkillsLayout> = {
  claude: "claude",
  "claude-code": "claude",
  codex: "agents",
  gemini: "agents",
  cursor: "agents",
  copilot: "agents",
  opencode: "agents",
  agents: "agents",
  other: "agents",
};

/** The folder a layout installs into, relative to the target repo. */
export function layoutDir(layout: SkillsLayout): string {
  return layout === "claude" ? ".claude" : join(".agents", "skills");
}

/**
 * Installs aida's skills. `claude`: every `skills/<name>/` except `agents/` into
 * `<target>/.claude/skills/<name>/`, and `skills/agents/*.md` into `<target>/.claude/agents/`.
 * `agents`: every `skills/<name>/` (`agents/` included, as reference files the skills point to)
 * into `<target>/.agents/skills/<name>/`.
 */
export function installSkills(target: string, skillsDir: string = findSkillsDir(), layout: SkillsLayout = "claude"): InstallSkillsResult {
  if (!existsSync(skillsDir)) throw new Error(`no skills directory at ${skillsDir}`);

  const copied: string[] = [];
  const skipped: string[] = [];
  const unchanged: string[] = [];

  for (const entry of readdirSync(skillsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (entry.name === "agents" && layout === "claude") {
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
        layout === "claude" ? join(target, ".claude", "skills", entry.name, rel) : join(target, ".agents", "skills", entry.name, rel),
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
  /** Which coding agent the repo uses (AGENT_LAYOUTS); default `claude`. */
  agent?: string;
}

export function runSkillsInstall(opts: RunSkillsInstallOptions, json: boolean): number {
  const target = opts.target ?? process.cwd();
  const agent = (opts.agent ?? "claude").toLowerCase();
  const layout = AGENT_LAYOUTS[agent];
  if (!layout) {
    const message = `unknown --agent "${opts.agent}"; use one of ${Object.keys(AGENT_LAYOUTS).join(", ")} (any agent that reads .agents/skills: other)`;
    if (json) console.log(JSON.stringify({ ok: false, error: message }));
    else console.error(`skills install failed: ${message}`);
    return 1;
  }
  let result: InstallSkillsResult;
  try {
    result = installSkills(target, undefined, layout);
  } catch (err) {
    const message = (err as Error).message;
    if (json) console.log(JSON.stringify({ ok: false, error: message }));
    else console.error(`skills install failed: ${message}`);
    return 1;
  }

  if (json) {
    console.log(JSON.stringify({ ok: true, layout, ...result }));
  } else {
    console.log(`installed skills from ${result.skillsDir} -> ${join(target, layoutDir(layout))}`);
    console.log(`  copied: ${result.copied.length}, unchanged: ${result.unchanged.length}, skipped (user-modified): ${result.skipped.length}`);
    for (const f of result.skipped) console.log(`  skipped: ${f}`);
  }
  return 0;
}
