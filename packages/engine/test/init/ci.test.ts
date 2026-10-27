import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writeCiWorkflow } from "../../src/init/ci.js";

const createdDirs: string[] = [];
function tmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "aida-init-ci-test-"));
  createdDirs.push(dir);
  return dir;
}
afterEach(() => {
  while (createdDirs.length > 0) rmSync(createdDirs.pop()!, { recursive: true, force: true });
});

describe("writeCiWorkflow", () => {
  it("writes .github/workflows/aida.yml with the configured action, config path and app url", () => {
    const appRepo = tmpDir();
    const result = writeCiWorkflow({ appRepo, configPath: "help/aida.config.ts", waitOnUrl: "http://localhost:3100", uses: "tryaida/aida@main" });

    expect(result.written).toBe(true);
    expect(result.file).toBe(join(appRepo, ".github", "workflows", "aida.yml"));
    const content = readFileSync(result.file, "utf8");
    expect(content).toContain("uses: tryaida/aida@main");
    expect(content).toContain("config: help/aida.config.ts");
    expect(content).toContain("pr-number:");
    expect(content).toContain("http://localhost:3100");
    expect(content).toContain("on:");
    expect(content).toContain("pull_request");
    expect(content).toContain("permissions:");
    expect(content).toContain("contents: write");
    expect(content).toContain("pull-requests: write");
  });

  it("never overwrites an existing workflow file", () => {
    const appRepo = tmpDir();
    mkdirSync(join(appRepo, ".github", "workflows"), { recursive: true });
    const existing = join(appRepo, ".github", "workflows", "aida.yml");
    writeFileSync(existing, "# hand-edited\n");

    const result = writeCiWorkflow({ appRepo });
    expect(result.written).toBe(false);
    expect(readFileSync(existing, "utf8")).toBe("# hand-edited\n");
  });

  it("adds a postgres service block when requested", () => {
    const appRepo = tmpDir();
    const result = writeCiWorkflow({ appRepo, postgres: true });
    const content = readFileSync(result.file, "utf8");
    expect(content).toContain("services:");
    expect(content).toContain("postgres:16");
  });

  it("includes a prune job for closed PRs", () => {
    const appRepo = tmpDir();
    const result = writeCiWorkflow({ appRepo });
    const content = readFileSync(result.file, "utf8");
    expect(content).toContain("aida-prune-previews");
    expect(content).toContain("aida-previews");
  });

  it("never uses pull_request_target as a trigger, triggers only on pull_request, and skips the prune job for forks", () => {
    const appRepo = tmpDir();
    const result = writeCiWorkflow({ appRepo });
    const content = readFileSync(result.file, "utf8");
    const onBlock = content.slice(content.indexOf("\non:"), content.indexOf("\npermissions:"));
    expect(onBlock).toContain("pull_request:");
    expect(onBlock).not.toContain("pull_request_target");
    expect(content).toContain("is-fork");
    expect(content).toContain("github.event.pull_request.head.repo.full_name != github.repository");
    expect(content).toContain("github.event.pull_request.head.repo.full_name == github.repository");
  });

  it("declares no top-level permissions and pins every action to a major version", () => {
    const appRepo = tmpDir();
    const result = writeCiWorkflow({ appRepo });
    const content = readFileSync(result.file, "utf8");
    expect(content).toContain("permissions: {}");
    const usesLines = content.split("\n").filter((l) => l.trimStart().startsWith("uses:"));
    expect(usesLines.length).toBeGreaterThan(0);
    for (const line of usesLines) {
      expect(line).toMatch(/@(v\d+|main)\b/);
    }
  });

  it("adds an aida-publish job on push to main that doesn't run for PRs", () => {
    const appRepo = tmpDir();
    const result = writeCiWorkflow({ appRepo });
    const content = readFileSync(result.file, "utf8");
    expect(content).toContain("push:");
    expect(content).toContain("branches: [main]");
    expect(content).toContain("aida-publish:");
    expect(content).toContain("github.event_name == 'push'");
    expect(content).toContain("ci --publish");
    // The PR-check and prune jobs must stay scoped to pull_request — a push event has no
    // github.event.pull_request/.action at all, so "if" guards need the event_name check too.
    expect(content).toContain("github.event_name == 'pull_request' && github.event.action != 'closed'");
    expect(content).toContain("github.event_name == 'pull_request' && github.event.action == 'closed'");
  });

  it("checks out a separate docs repo with AIDA_DOCS_TOKEN when --docs-repo is set, and points config there", () => {
    const appRepo = tmpDir();
    const result = writeCiWorkflow({ appRepo, docsRepo: "acme/aida-docs" });
    const content = readFileSync(result.file, "utf8");
    expect(content).toContain("repository: acme/aida-docs");
    expect(content).toContain("path: .aida-docs");
    expect(content).toContain("secrets.AIDA_DOCS_TOKEN");
    expect(content).toContain("config: .aida-docs/help/aida.config.ts");
  });
});

describe("generated workflow: nothing fetched by bare name", () => {
  it("waits for the app with an inline Node loop, never npx wait-on", () => {
    const appRepo = tmpDir();
    const content = readFileSync(writeCiWorkflow({ appRepo, waitOnUrl: "http://localhost:3100" }).file, "utf8");
    expect(content).not.toMatch(/wait-on/);
    expect(content).not.toMatch(/npx --yes/);
    expect(content.match(/AIDA_WAIT_URL: "http:\/\/localhost:3100"/g)?.length).toBe(2);
    expect(content).toContain("await fetch(url)");
  });

  it("installs the help app's packages in the publish job (the action does it for the PR job), on Node 22", () => {
    const appRepo = tmpDir();
    const content = readFileSync(writeCiWorkflow({ appRepo, configPath: "help/aida.config.ts" }).file, "utf8");
    const publish = content.slice(content.indexOf("aida-publish:"));
    const install = publish.indexOf("node .aida-src/packages/engine/dist/init/help-install.js help/aida.config.ts");
    expect(install).toBeGreaterThan(publish.indexOf("npm run build --workspace packages/engine"));
    expect(install).toBeLessThan(publish.indexOf("ci --publish"));
    expect(content).not.toContain("node-version: 20");
    expect(content).toContain("node-version: 22");
  });
});

describe("generated workflow git identity", () => {
  it("sets the committer identity on every git commit (runners have none)", async () => {
    const { mkdtempSync, readFileSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { writeCiWorkflow } = await import("../../src/init/ci.js");
    const dir = mkdtempSync(join(tmpdir(), "aida-ci-ident-"));
    try {
      const { file } = writeCiWorkflow({ appRepo: dir } as Parameters<typeof writeCiWorkflow>[0]);
      const commits = readFileSync(file, "utf8").split("\n").filter((l) => /\bgit\b.*\bcommit\b/.test(l));
      expect(commits.length).toBeGreaterThan(0);
      for (const line of commits) expect(line).toContain("user.name=aida-ci");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
