// End-to-end `runPublishCommand` tests against a fake config file + fake runner — never shells
// out, never deploys. Exercises `--dry-run`, the build-report/pages gates, and a full apply +
// deploy pass for a host with no gate problems.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runPublishCommand } from "../../src/commands/publish.js";
import { createFakeCommandRunner } from "../../src/publish/runner.js";
import { stageDirFor } from "../../src/publish/staging.js";
import { cleanupTmpDirs, makeHelpRoot, writeBuildReport, writePage } from "./helpers.js";

afterEach(cleanupTmpDirs);

function writeConfig(helpRoot: string, host = "vercel", extra = ""): string {
  const file = join(helpRoot, "aida.config.mjs");
  writeFileSync(
    file,
    `export default {
  app: { baseUrl: "http://localhost:3000" },
  walkthroughsDir: "./walkthroughs",
  outDir: ".",
  buildDir: "./.build",
  helpApp: ".",
  host: ${JSON.stringify(host)},
  ${extra}
};
`,
  );
  mkdirSync(join(helpRoot, "walkthroughs"), { recursive: true });
  return file;
}

describe("runPublishCommand", () => {
  it("--dry-run returns the plan without touching gates, files or the runner", async () => {
    const helpRoot = makeHelpRoot();
    const configPath = writeConfig(helpRoot, "vercel");
    const { runner, calls } = createFakeCommandRunner();

    const result = await runPublishCommand({ configPath, dryRun: true, runner });

    expect(result.dryRun).toBe(true);
    expect(result.ok).toBe(true);
    expect(result.plan?.host).toBe("vercel");
    expect(calls).toHaveLength(0);
  });

  it("refuses when there's no build report yet", async () => {
    const helpRoot = makeHelpRoot();
    const configPath = writeConfig(helpRoot, "vercel");
    const { runner } = createFakeCommandRunner();

    const result = await runPublishCommand({ configPath, runner, isTTY: false });

    expect(result.ok).toBe(false);
    expect(result.gates?.ok).toBe(false);
    expect(result.gates?.reasons.join(" ")).toMatch(/run `aida build` first/);
  });

  it("refuses when a page isn't publishable, even with a passing build report", async () => {
    const helpRoot = makeHelpRoot();
    const configPath = writeConfig(helpRoot, "vercel");
    writeBuildReport(join(helpRoot, ".build"), true);
    writePage(helpRoot, "broken-flow", { passed: false });
    const { runner } = createFakeCommandRunner();

    const result = await runPublishCommand({ configPath, runner, isTTY: false });

    expect(result.ok).toBe(false);
    expect(result.gates?.reasons.join(" ")).toMatch(/broken-flow/);
  });

  it("refuses a production publish with no prior approval in a non-TTY agent session", async () => {
    const helpRoot = makeHelpRoot();
    const configPath = writeConfig(helpRoot, "vercel");
    writeBuildReport(join(helpRoot, ".build"), true);
    const { runner } = createFakeCommandRunner();

    const result = await runPublishCommand({ configPath, runner, prod: true, isTTY: false, env: { CLAUDECODE: "1" } });

    expect(result.ok).toBe(false);
    expect(result.gates?.reasons.join(" ")).toMatch(/ask the person/);
  });

  // Regression test (review finding): an agent must never self-approve, even with
  // `--approve --by person` and even on a TTY — only a non-agent environment may record one.
  it("refuses --approve --by person from an agent env even on a TTY — an agent can never self-approve", async () => {
    const helpRoot = makeHelpRoot();
    const configPath = writeConfig(helpRoot, "vercel");
    writeBuildReport(join(helpRoot, ".build"), true);
    const { runner } = createFakeCommandRunner({ code: 0, stdout: "https://example.vercel.app\n", stderr: "" });

    const result = await runPublishCommand({
      configPath,
      runner,
      prod: true,
      isTTY: true,
      approve: true,
      approveBy: "person",
      env: { CLAUDECODE: "1" },
    });

    expect(result.ok).toBe(false);
    expect(result.gates?.reasons.join(" ")).toMatch(/ask the person/);
  });

  it("a passing preview publish writes host files, applies, and deploys via the injected runner", async () => {
    const helpRoot = makeHelpRoot();
    const configPath = writeConfig(helpRoot, "vercel");
    writeBuildReport(join(helpRoot, ".build"), true);
    const { runner, calls } = createFakeCommandRunner({ code: 0, stdout: "https://example-preview.vercel.app\n", stderr: "" });

    const result = await runPublishCommand({ configPath, runner, isTTY: false });

    expect(result.ok).toBe(true);
    expect(result.apply?.files).toEqual([{ path: "vercel.json", action: "written" }]);
    expect(result.deploy?.url).toBe("https://example-preview.vercel.app");
    expect(calls.some((c) => c.args.includes("deploy"))).toBe(true);
  });

  it("a production publish with --approve --by person records approval and deploys", async () => {
    const helpRoot = makeHelpRoot();
    const configPath = writeConfig(helpRoot, "vercel");
    writeBuildReport(join(helpRoot, ".build"), true);
    const { runner } = createFakeCommandRunner({ code: 0, stdout: "https://example.vercel.app\n", stderr: "" });

    const result = await runPublishCommand({
      configPath,
      runner,
      prod: true,
      isTTY: false,
      approve: true,
      approveBy: "person",
      env: {}, // a person's own non-agent shell — must not be treated as self-approval
    });

    expect(result.ok).toBe(true);
    expect(result.deploy?.summary).toContain("deployed");
  });

  // Regression test (review finding): deploy() must run against the staged copy, not helpRoot —
  // otherwise rewritten blob video URLs never ship and the oversized local video still deploys.
  it("deploys from the staged copy with rewritten video links and the local video dropped", async () => {
    const helpRoot = makeHelpRoot();
    const configPath = writeConfig(helpRoot, "vercel", 'publish: { videoStorage: "s3" },');
    writeBuildReport(join(helpRoot, ".build"), true);
    const sourcePage = writePage(helpRoot, "add-entry", { video: "../../videos/add-entry/add-entry.mp4" });
    const videoAbs = join(helpRoot, "public", "videos", "add-entry.mp4");
    mkdirSync(join(videoAbs, ".."), { recursive: true });
    writeFileSync(videoAbs, Buffer.alloc(1000));

    const { runner, calls } = createFakeCommandRunner({ code: 0, stdout: "https://example.vercel.app\n", stderr: "" });

    const result = await runPublishCommand({ configPath, runner, isTTY: false });

    expect(result.ok).toBe(true);
    expect(result.uploads).toHaveLength(1);

    // The deploy command ran against the stage directory, not helpRoot.
    const stage = stageDirFor(helpRoot);
    const deployCalls = calls.filter((c) => c.args.includes("deploy"));
    expect(deployCalls).toHaveLength(1);
    expect(deployCalls[0].cwd).toBe(stage);

    // The staged page's video link was rewritten to the uploaded URL.
    const stagedPage = join(stage, "content", "docs", "add-entry", "index.mdx");
    expect(readFileSync(stagedPage, "utf8")).toContain(result.uploads![0].url);

    // The oversized local video is gone from the stage (never ships as a static asset)...
    expect(existsSync(join(stage, "public", "videos", "add-entry.mp4"))).toBe(false);
    // ...but the source tree is completely untouched.
    expect(existsSync(videoAbs)).toBe(true);
    expect(readFileSync(sourcePage, "utf8")).toContain("../../videos/add-entry/add-entry.mp4");
    expect(readFileSync(sourcePage, "utf8")).not.toContain(result.uploads![0].url);
  });

  it("errors clearly when neither --to nor config.host is set", async () => {
    const helpRoot = makeHelpRoot();
    const configPath = join(helpRoot, "aida.config.mjs");
    writeFileSync(
      configPath,
      `export default { app: { baseUrl: "http://localhost:3000" }, walkthroughsDir: "./walkthroughs", outDir: ".", helpApp: "." };\n`,
    );
    mkdirSync(join(helpRoot, "walkthroughs"), { recursive: true });

    const result = await runPublishCommand({ configPath });

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/no host given/);
  });
});
