// `aida skills install` layouts: `.claude/` for Claude Code, `.agents/skills/` for Codex, Gemini CLI
// and the other agents that read the shared folder.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { installSkills, runSkillsInstall } from "../../src/commands/skills.js";

const created: string[] = [];
function tmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "aida-skills-install-test-"));
  created.push(dir);
  return dir;
}
afterEach(() => {
  vi.restoreAllMocks();
  while (created.length > 0) rmSync(created.pop()!, { recursive: true, force: true });
});

function write(file: string, content: string): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
}

/** A skills folder shaped like the real one: an entry skill, a reference folder, agent files. */
function skillsSource(): string {
  const dir = tmpDir();
  write(join(dir, "aida", "SKILL.md"), "entry skill");
  write(join(dir, "references", "tokens.md"), "tokens");
  write(join(dir, "agents", "writer.md"), "writer agent");
  write(join(dir, "AGENTS.md"), "top-level note");
  return dir;
}

describe("installSkills", () => {
  it("claude: skills under .claude/skills, subagents under .claude/agents", () => {
    const target = tmpDir();
    const r = installSkills(target, skillsSource(), "claude");
    expect(r.copied).toHaveLength(3);
    expect(readFileSync(join(target, ".claude", "skills", "aida", "SKILL.md"), "utf8")).toBe("entry skill");
    expect(readFileSync(join(target, ".claude", "agents", "writer.md"), "utf8")).toBe("writer agent");
    expect(existsSync(join(target, ".agents"))).toBe(false);
  });

  it("agents: the whole tree under .agents/skills, agent files kept as references, nothing in .claude", () => {
    const target = tmpDir();
    const r = installSkills(target, skillsSource(), "agents");
    expect(r.copied).toHaveLength(3);
    expect(readFileSync(join(target, ".agents", "skills", "aida", "SKILL.md"), "utf8")).toBe("entry skill");
    expect(readFileSync(join(target, ".agents", "skills", "references", "tokens.md"), "utf8")).toBe("tokens");
    expect(readFileSync(join(target, ".agents", "skills", "agents", "writer.md"), "utf8")).toBe("writer agent");
    expect(existsSync(join(target, ".claude"))).toBe(false);
    expect(existsSync(join(target, ".agents", "skills", "AGENTS.md"))).toBe(false);
  });

  it("never overwrites a file a person edited", () => {
    const target = tmpDir();
    const src = skillsSource();
    installSkills(target, src, "agents");
    writeFileSync(join(target, ".agents", "skills", "aida", "SKILL.md"), "mine");
    const again = installSkills(target, src, "agents");
    expect(again.skipped).toEqual([join(target, ".agents", "skills", "aida", "SKILL.md")]);
    expect(again.unchanged).toHaveLength(2);
    expect(readFileSync(join(target, ".agents", "skills", "aida", "SKILL.md"), "utf8")).toBe("mine");
  });
});

describe("runSkillsInstall --agent", () => {
  it("maps agent names to a layout and refuses an unknown one", () => {
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((m: string) => void logs.push(m));
    vi.spyOn(console, "error").mockImplementation((m: string) => void logs.push(m));

    const codex = tmpDir();
    expect(runSkillsInstall({ target: codex, agent: "Codex" }, true)).toBe(0);
    expect(JSON.parse(logs.pop()!)).toMatchObject({ ok: true, layout: "agents" });
    expect(existsSync(join(codex, ".agents", "skills", "aida", "SKILL.md"))).toBe(true);

    const claude = tmpDir();
    expect(runSkillsInstall({ target: claude }, true)).toBe(0);
    expect(JSON.parse(logs.pop()!)).toMatchObject({ ok: true, layout: "claude" });
    expect(existsSync(join(claude, ".claude", "agents"))).toBe(true);

    expect(runSkillsInstall({ target: tmpDir(), agent: "windsurf-pro" }, false)).toBe(1);
    expect(logs.pop()).toMatch(/unknown --agent "windsurf-pro".*other/);
  });
});
