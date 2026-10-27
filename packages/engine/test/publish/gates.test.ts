// docs/build-plan.md M13 "Tests: ... gate refusals (failed build report, no approval in
// non-TTY, agent env)".
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkApproval, checkBuildReport, checkPagesPublishable, isAgentEnv } from "../../src/publish/gates.js";
import { readApproval } from "../../src/publish/approval.js";
import { cleanupTmpDirs, makeHelpRoot, writeBuildReport, writePage } from "./helpers.js";

afterEach(cleanupTmpDirs);

describe("checkBuildReport", () => {
  it("refuses when there's no report.json yet", () => {
    const helpRoot = makeHelpRoot();
    const gate = checkBuildReport(join(helpRoot, ".build"));
    expect(gate.ok).toBe(false);
    expect(gate.reasons[0]).toMatch(/run `aida build` first/);
  });

  it("refuses when the last build report is not ok", () => {
    const helpRoot = makeHelpRoot();
    const buildDir = join(helpRoot, ".build");
    writeBuildReport(buildDir, false);
    const gate = checkBuildReport(buildDir);
    expect(gate.ok).toBe(false);
    expect(gate.reasons[0]).toMatch(/did not pass/);
    expect(gate.reasons[0]).toContain("broken-one");
  });

  it("passes when the last build report is ok", () => {
    const helpRoot = makeHelpRoot();
    const buildDir = join(helpRoot, ".build");
    writeBuildReport(buildDir, true);
    expect(checkBuildReport(buildDir).ok).toBe(true);
  });
});

describe("checkPagesPublishable", () => {
  it("passes when there are no generated pages yet", () => {
    const helpRoot = makeHelpRoot();
    expect(checkPagesPublishable(helpRoot).ok).toBe(true);
  });

  it("passes when every generated page is passed: true", () => {
    const helpRoot = makeHelpRoot();
    writePage(helpRoot, "add-entry", { passed: true });
    const gate = checkPagesPublishable(helpRoot);
    expect(gate.ok).toBe(true);
    expect(gate.checked).toBe(1);
  });

  it("refuses when any generated page is passed: false", () => {
    const helpRoot = makeHelpRoot();
    writePage(helpRoot, "add-entry", { passed: true });
    writePage(helpRoot, "broken-flow", { passed: false });
    const gate = checkPagesPublishable(helpRoot);
    expect(gate.ok).toBe(false);
    expect(gate.reasons[0]).toContain("broken-flow");
  });

  it("ignores a hand-authored page with no walkthrough/passed frontmatter", () => {
    const helpRoot = makeHelpRoot();
    const dir = join(helpRoot, "content", "docs", "about");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "index.mdx"), "---\ntitle: About\n---\n\nHand-written.\n");
    const gate = checkPagesPublishable(helpRoot);
    expect(gate.ok).toBe(true);
    expect(gate.checked).toBe(0);
  });
});

describe("isAgentEnv", () => {
  it("detects Claude Code / Codex via their own env vars", () => {
    expect(isAgentEnv({ CLAUDECODE: "1" })).toBe(true);
    expect(isAgentEnv({ CODEX: "1" })).toBe(true);
    expect(isAgentEnv({})).toBe(false);
  });
});

describe("checkApproval", () => {
  it("always passes for a preview (non-prod) publish", async () => {
    const helpRoot = makeHelpRoot();
    const gate = await checkApproval(helpRoot, { prod: false, host: "vercel", isTTY: false, env: {} });
    expect(gate.ok).toBe(true);
  });

  it("refuses a production publish with no prior approval and no TTY (CI/agent)", async () => {
    const helpRoot = makeHelpRoot();
    const gate = await checkApproval(helpRoot, { prod: true, host: "vercel", isTTY: false, env: {} });
    expect(gate.ok).toBe(false);
    expect(gate.reasons[0]).toMatch(/ask the person|no TTY/);
  });

  it("refuses a production publish from an agent env even with no TTY, naming what to do", async () => {
    const helpRoot = makeHelpRoot();
    const gate = await checkApproval(helpRoot, { prod: true, host: "vercel", isTTY: false, env: { CLAUDECODE: "1" } });
    expect(gate.ok).toBe(false);
    expect(gate.reasons[0]).toMatch(/ask the person/);
  });

  it("rejects --approve without --by person (no self-approval)", async () => {
    const helpRoot = makeHelpRoot();
    const gate = await checkApproval(helpRoot, {
      prod: true,
      host: "vercel",
      isTTY: false,
      env: { CLAUDECODE: "1" },
      approve: true,
    });
    expect(gate.ok).toBe(false);
    expect(gate.reasons[0]).toMatch(/--by person/);
  });

  it("accepts --approve --by person and records it in help/.aida/publish.json", async () => {
    const helpRoot = makeHelpRoot();
    const gate = await checkApproval(helpRoot, {
      prod: true,
      host: "vercel",
      isTTY: false,
      env: {},
      approve: true,
      approveBy: "person",
    });
    expect(gate.ok).toBe(true);
    expect(gate.recorded).toBe(true);
    const saved = readApproval(helpRoot);
    expect(saved?.by).toBe("person");
    expect(saved?.host).toBe("vercel");
  });

  // Regression test (review finding): `--approve --by person` must never let an agent
  // self-approve the first production publish — previously this only warned and still wrote
  // the approval. It must now refuse outright and name the command a person should run.
  it("refuses --approve --by person from an agent env with no TTY — an agent can never self-approve", async () => {
    const helpRoot = makeHelpRoot();
    const gate = await checkApproval(helpRoot, {
      prod: true,
      host: "vercel",
      isTTY: false,
      env: { CLAUDECODE: "1" },
      approve: true,
      approveBy: "person",
    });
    expect(gate.ok).toBe(false);
    expect(gate.recorded).toBeUndefined();
    expect(readApproval(helpRoot)).toBeUndefined();
    expect(gate.reasons[0]).toMatch(/ask the person/);
    expect(gate.reasons[0]).toContain("aida publish --to vercel --prod --approve --by person");
  });

  // Same refusal even with a TTY — an agent must never self-approve, not even "interactively".
  it("refuses --approve --by person from an agent env even with a TTY", async () => {
    const helpRoot = makeHelpRoot();
    const gate = await checkApproval(helpRoot, {
      prod: true,
      host: "vercel",
      isTTY: true,
      env: { CLAUDECODE: "1" },
      approve: true,
      approveBy: "person",
    });
    expect(gate.ok).toBe(false);
    expect(readApproval(helpRoot)).toBeUndefined();
  });

  // And an agent can't fall back to the interactive-confirm path either, TTY or not.
  it("refuses an interactive confirm from an agent env even on a TTY", async () => {
    const helpRoot = makeHelpRoot();
    const confirm = async () => true;
    const gate = await checkApproval(helpRoot, {
      prod: true,
      host: "vercel",
      isTTY: true,
      env: { CLAUDECODE: "1" },
      confirm,
    });
    expect(gate.ok).toBe(false);
    expect(readApproval(helpRoot)).toBeUndefined();
  });

  it("reuses a prior approval on a later production publish without re-prompting", async () => {
    const helpRoot = makeHelpRoot();
    await checkApproval(helpRoot, { prod: true, host: "vercel", isTTY: false, env: {}, approve: true, approveBy: "person" });
    const gate = await checkApproval(helpRoot, { prod: true, host: "vercel", isTTY: false, env: {} });
    expect(gate.ok).toBe(true);
    expect(gate.recorded).toBeUndefined();
  });
});
