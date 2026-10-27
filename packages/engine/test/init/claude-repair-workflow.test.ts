// `aida init --ci --claude` (build-plan.md M19 item 2; decisions #22): optional, opt-in Claude
// Code repair workflow. The base aida.yml stays keyless either way — these checks make sure
// this second workflow authenticates with the OAuth token (never an API key), never triggers on
// pull_request_target, and gates on write access before running Claude.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writeClaudeRepairWorkflow } from "../../src/init/ci.js";

const createdDirs: string[] = [];
function tmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "aida-claude-repair-test-"));
  createdDirs.push(dir);
  return dir;
}
afterEach(() => {
  while (createdDirs.length > 0) rmSync(createdDirs.pop()!, { recursive: true, force: true });
});

describe("writeClaudeRepairWorkflow", () => {
  it("writes .github/workflows/aida-repair.yml authenticated with the OAuth token, never an API key", () => {
    const appRepo = tmpDir();
    const result = writeClaudeRepairWorkflow({ appRepo });

    expect(result.written).toBe(true);
    expect(result.file).toBe(join(appRepo, ".github", "workflows", "aida-repair.yml"));
    const content = readFileSync(result.file, "utf8");
    expect(content).toContain("claude_code_oauth_token: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}");
    expect(content).not.toContain("anthropic_api_key");
    expect(content).not.toContain("ANTHROPIC_API_KEY");
  });

  it("never triggers on pull_request_target", () => {
    const appRepo = tmpDir();
    const result = writeClaudeRepairWorkflow({ appRepo });
    const content = readFileSync(result.file, "utf8");
    const onBlock = content.slice(content.indexOf("\non:"), content.indexOf("\npermissions:"));
    expect(onBlock).not.toContain("pull_request_target");
    expect(onBlock).toContain("issue_comment");
    expect(onBlock).toContain("pull_request:");
  });

  it("gates the claude job on the commenter/labeller having write access", () => {
    const appRepo = tmpDir();
    const result = writeClaudeRepairWorkflow({ appRepo });
    const content = readFileSync(result.file, "utf8");
    expect(content).toContain("check-access");
    expect(content).toContain("needs.check-access.outputs.has-access == 'true'");
    expect(content).toContain("collaborators/$ACTOR/permission");
  });

  it("triggers on the @claude phrase and the docs:repair label by default, both configurable", () => {
    const appRepo = tmpDir();
    const result = writeClaudeRepairWorkflow({ appRepo, triggerPhrase: "@aida", labelTrigger: "needs-docs" });
    const content = readFileSync(result.file, "utf8");
    expect(content).toContain("@aida");
    expect(content).toContain("needs-docs");
    expect(content).not.toContain("'@claude'");
  });

  it("never overwrites an existing workflow file", () => {
    const appRepo = tmpDir();
    const dir = join(appRepo, ".github", "workflows");
    const file = join(dir, "aida-repair.yml");
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, "# hand-edited\n");

    const result = writeClaudeRepairWorkflow({ appRepo });
    expect(result.written).toBe(false);
    expect(existsSync(file)).toBe(true);
    expect(readFileSync(file, "utf8")).toBe("# hand-edited\n");
  });
});

describe("aida-repair.yml fork safety", () => {
  it("refuses to run Claude when the PR head is a fork", () => {
    const { file } = writeClaudeRepairWorkflow({ appRepo: tmpDir() });
    const yml = readFileSync(file, "utf8");
    expect(yml).toContain(".head.repo.full_name");
    expect(yml).toContain("refusing to run on fork code");
    expect(yml).not.toMatch(/^\s*pull_request_target:/m);
  });
});
