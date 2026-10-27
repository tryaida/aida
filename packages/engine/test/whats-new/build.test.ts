import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildWhatsNew } from "../../src/whats-new/build.js";
import { createFakeCommandRunner } from "../../src/publish/index.js";
import { writeManifest } from "../../src/versions/index.js";

let dir: string | undefined;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

function makeHelpApp(): string {
  dir = mkdtempSync(join(tmpdir(), "aida-whats-new-"));
  mkdirSync(join(dir, "public"), { recursive: true });
  return dir;
}

const GIT_LOG_STDOUT = [
  "a1\x1f2026-02-01T00:00:00+00:00\x1fAdd competitor export (#10)",
  "a2\x1f2026-01-31T00:00:00+00:00\x1fchore: bump deps",
  "a3\x1f2026-01-30T00:00:00+00:00\x1ffix: broken login redirect (#9)",
].join("\n");

describe("buildWhatsNew", () => {
  it("writes a page with noise filtered out and plain-words entries, and reports counts", async () => {
    const helpApp = makeHelpApp();
    const { runner } = createFakeCommandRunner({ code: 0, stdout: GIT_LOG_STDOUT, stderr: "" });

    const result = await buildWhatsNew({ appRepo: "/app", helpApp, runner });

    expect(result.entryCount).toBe(2);
    expect(result.skippedCount).toBe(1);
    const page = readFileSync(result.pageFile, "utf8");
    expect(page).toContain('title: "What\'s new"');
    expect(page).toContain("Add competitor export");
    expect(page).toContain("Broken login redirect");
    expect(page).not.toContain("bump deps");
  });

  it("defaults --since to the last frozen version's gitRef", async () => {
    const helpApp = makeHelpApp();
    writeManifest(join(helpApp, "public"), { latest: "v1.0", versions: [{ name: "v1.0", date: "2026-01-01T00:00:00Z", gitRef: "v1.0.0" }] });
    const { runner, calls } = createFakeCommandRunner({ code: 0, stdout: "", stderr: "" });

    await buildWhatsNew({ appRepo: "/app", helpApp, runner });

    expect(calls[0].args).toContain("v1.0.0..HEAD");
  });

  it("groups entries by walkthrough id via the injected mapper, with unmapped entries under General", async () => {
    const helpApp = makeHelpApp();
    const { runner } = createFakeCommandRunner({ code: 0, stdout: GIT_LOG_STDOUT, stderr: "" });

    const result = await buildWhatsNew({
      appRepo: "/app",
      helpApp,
      runner,
      mapper: (entry) => (entry.subject.includes("login") ? ["add-competitor"] : undefined),
    });

    const page = readFileSync(result.pageFile, "utf8");
    expect(page).toContain("### add-competitor");
    expect(page).toContain("### General");
  });

  it("preserves a human edit outside the generated block on rebuild", async () => {
    const helpApp = makeHelpApp();
    const { runner: runner1 } = createFakeCommandRunner({ code: 0, stdout: GIT_LOG_STDOUT, stderr: "" });
    const first = await buildWhatsNew({ appRepo: "/app", helpApp, runner: runner1 });

    const withHumanEdit = `${readFileSync(first.pageFile, "utf8")}\n\nA person wrote this note.\n`;
    writeFileSync(first.pageFile, withHumanEdit);

    const { runner: runner2 } = createFakeCommandRunner({ code: 0, stdout: GIT_LOG_STDOUT, stderr: "" });
    const second = await buildWhatsNew({ appRepo: "/app", helpApp, runner: runner2 });

    const page = readFileSync(second.pageFile, "utf8");
    expect(page).toContain("A person wrote this note.");
  });

  it("uses gh pr list when fromGithub is set", async () => {
    const helpApp = makeHelpApp();
    const { runner, calls } = createFakeCommandRunner({
      code: 0,
      stdout: JSON.stringify([{ number: 5, title: "feat: add thing", mergedAt: "2026-01-01T00:00:00Z" }]),
      stderr: "",
    });

    const result = await buildWhatsNew({ appRepo: "/app", helpApp, runner, fromGithub: true });

    expect(calls[0].cmd).toBe("gh");
    expect(result.entryCount).toBe(1);
  });
});
