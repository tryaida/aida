// `aida demo`'s command layer: option handling, refusals that write nothing, the machine checks
// that stop it before it starts, and what it prints.
import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatDemo, parseDemoPort, runDemoCommand } from "../../src/commands/demo.js";
import { aidaInvocation, liveCount, narrationNotice, whatToExpect, type DemoResult } from "../../src/demo/index.js";
import { playwrightCli, runPreflight, withOwnPlaywright } from "../../src/demo/preflight.js";
import { shellWord } from "../../src/demo/invocation.js";
import type { DoctorProbes } from "../../src/doctor/index.js";

const dirs: string[] = [];
function tmp(): string {
  // Not "aida-*": a cleaner on the dev machine deletes /tmp/aida-* folders mid-run.
  const dir = mkdtempSync(join(tmpdir(), "demo-command-test-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  vi.restoreAllMocks();
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function probes(over: Partial<DoctorProbes> = {}): DoctorProbes {
  return {
    nodeVersion: () => "22.12.0",
    platform: () => "linux",
    commandVersion: async (cmd) => `${cmd} version 7.1`,
    ffmpegStatic: async () => undefined,
    playwright: async () => ({ version: "1.65.0", chromiumRevision: "1254", chromiumPath: "/x/chrome", chromiumInstalled: true }),
    launchChromium: async () => ({ ok: true }),
    freeBytes: () => 50 * 1024 ** 3,
    dirSize: async () => undefined,
    fetchStatus: async () => ({ status: 200 }),
    helpApp: () => ({ exists: false }) as never,
    ...over,
  };
}

function captureOutput(): { out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => void out.push(a.join(" ")));
  vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => void err.push(a.join(" ")));
  return { out, err };
}

describe("parseDemoPort", () => {
  it("takes a port number, 0 for a free one, and nothing else", () => {
    expect(parseDemoPort(undefined)).toEqual({});
    expect(parseDemoPort("4400")).toEqual({ port: 4400 });
    expect(parseDemoPort("0")).toEqual({ port: 0 });
    expect(parseDemoPort(5000)).toEqual({ port: 5000 });
    for (const bad of ["70000", "-1", "abc", "40.5", ""]) expect(parseDemoPort(bad).error, bad).toMatch(/--port must be a port number/);
  });
});

describe("runDemoCommand", () => {
  it("rejects a bad --port before doing anything", async () => {
    const root = tmp();
    const { err } = captureOutput();
    expect(await runDemoCommand({ cwd: root, port: "nope", probes: probes() }, false)).toBe(1);
    expect(err.join("\n")).toMatch(/--port must be a port number/);
    expect(readdirSync(root)).toEqual([]);
  });

  it("refuses a folder that exists and isn't a demo folder, and changes nothing in it", async () => {
    const root = tmp();
    const target = join(root, "my-project");
    mkdirSync(target);
    writeFileSync(join(target, "README.md"), "mine");
    const { out } = captureOutput();
    expect(await runDemoCommand({ cwd: root, dir: "my-project", probes: probes() }, true)).toBe(1);
    const result = JSON.parse(out[out.length - 1]) as DemoResult;
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/isn't a demo folder/);
    expect(readdirSync(target)).toEqual(["README.md"]);
    expect(liveCount()).toBe(0);
  });

  it("stops at the machine checks with their fixes, before writing anything", async () => {
    const root = tmp();
    const { out } = captureOutput();
    const code = await runDemoCommand(
      {
        cwd: root,
        probes: probes({
          playwright: async () => ({ version: "1.65.0", chromiumRevision: "1254", chromiumPath: "/x/chrome", chromiumInstalled: false }),
          commandVersion: async () => undefined,
        }),
      },
      false,
    );
    expect(code).toBe(1);
    const text = out.join("\n");
    expect(text).toMatch(/This machine needs a fix/);
    // aida's own Playwright, not whichever one `npx playwright` would fetch.
    const cli = playwrightCli();
    expect(cli).toMatch(/[\\/]playwright[\\/]cli\.js$/);
    expect(text).toContain(`fix: node ${shellWord(cli!)} install chromium`);
    expect(text).not.toMatch(/npx playwright/);
    expect(text).toMatch(/ffprobe/);
    expect(text).toContain(`or run ${aidaInvocation()} demo --no-video`);
    expect(existsSync(join(root, "aida-demo"))).toBe(false);
    expect(liveCount()).toBe(0);
  });
});

describe("runDemoCommand on a folder with a planted marker", () => {
  // The planted server.mjs would leave this file behind if it ever ran.
  const planted = (proof: string) => `require("node:fs").writeFileSync(${JSON.stringify(proof)}, "ran");\n`;

  it("never runs a server.mjs the marker doesn't record", async () => {
    const root = tmp();
    const target = join(root, "downloaded");
    mkdirSync(target);
    const proof = join(root, "it-ran.txt");
    writeFileSync(join(target, ".aida-demo.json"), '{"aidaDemo":1}');
    writeFileSync(join(target, "server.mjs"), planted(proof));
    const { out } = captureOutput();
    expect(await runDemoCommand({ cwd: root, dir: "downloaded", port: 0, probes: probes() }, true)).toBe(1);
    expect((JSON.parse(out[out.length - 1]) as DemoResult).error).toMatch(/doesn't record the sample app/);
    expect(readdirSync(target).sort()).toEqual([".aida-demo.json", "server.mjs"]);
    expect(existsSync(proof)).toBe(false);
    expect(liveCount()).toBe(0);
  });

  it("never runs a server.mjs whose recorded hash is made up, and names it", async () => {
    const root = tmp();
    const target = join(root, "downloaded");
    mkdirSync(target);
    const proof = join(root, "it-ran.txt");
    writeFileSync(join(target, ".aida-demo.json"), JSON.stringify({ aidaDemo: 1, files: { "server.mjs": "0".repeat(64) } }));
    writeFileSync(join(target, "server.mjs"), planted(proof));
    const { out } = captureOutput();
    expect(await runDemoCommand({ cwd: root, dir: "downloaded", port: 0, probes: probes() }, true)).toBe(1);
    expect((JSON.parse(out[out.length - 1]) as DemoResult).error).toMatch(/^server\.mjs in .* has changed since aida demo wrote it/);
    expect(existsSync(proof)).toBe(false);
    expect(liveCount()).toBe(0);
  });
});

describe("runDemoCommand on .", () => {
  it("refuses the current folder when it has other things in it, and writes nothing", async () => {
    const root = tmp();
    writeFileSync(join(root, "package.json"), "{}");
    const { out } = captureOutput();
    expect(await runDemoCommand({ cwd: root, dir: ".", probes: probes() }, true)).toBe(1);
    expect((JSON.parse(out[out.length - 1]) as DemoResult).error).toMatch(/isn't a demo folder/);
    expect(readdirSync(root)).toEqual(["package.json"]);
  });
});

describe("withOwnPlaywright", () => {
  it("swaps npx playwright for aida's own CLI, and keeps the fix when that can't be found", () => {
    expect(withOwnPlaywright("npx playwright install chromium", "/e/node_modules/playwright/cli.js")).toBe("node /e/node_modules/playwright/cli.js install chromium");
    expect(withOwnPlaywright("sudo npx playwright install-deps chromium", "/a b/playwright/cli.js", "/usr/bin/node")).toBe("sudo /usr/bin/node '/a b/playwright/cli.js' install-deps chromium");
    expect(withOwnPlaywright("npx playwright install chromium", undefined)).toBe("npx playwright install chromium");
  });
});

describe("what the demo says before it starts and before narration", () => {
  it("says roughly how long it takes and what comes first", () => {
    expect(whatToExpect({}).join(" ")).toMatch(/about 5 to 10 minutes: the pages and PDFs first \(about 3 minutes\), then the video/);
    expect(whatToExpect({ video: false }).join(" ")).toMatch(/about 3 minutes; no video/);
    expect(whatToExpect({ full: true }).join(" ")).toMatch(/15 minutes or more/);
    expect(whatToExpect({ site: true }).join(" ")).toMatch(/installs the help site \(about 700 MB/);
  });

  it("warns that progress pauses while narration works, and about the first download", () => {
    expect(narrationNotice(1, false).join(" ")).toMatch(/progress lines pause while it works.*about 90 MB/);
    expect(narrationNotice(1, undefined).join(" ")).toMatch(/about 90 MB/);
    expect(narrationNotice(4, true).join(" ")).toMatch(/a few minutes per video/);
    expect(narrationNotice(4, true).join(" ")).not.toMatch(/90 MB/);
  });

  it("prints that first, before the machine checks", async () => {
    const root = tmp();
    const { out } = captureOutput();
    await runDemoCommand({ cwd: root, probes: probes({ commandVersion: async () => undefined }) }, false);
    expect(out[0]).toMatch(/^aida demo builds a help page/);
    expect(out.findIndex((l) => /about 5 to 10 minutes/.test(l))).toBeLessThan(out.findIndex((l) => /Checking this machine/.test(l)));
  });
});

describe("runPreflight", () => {
  it("goes ahead with a warning when Chromium only starts slowly", async () => {
    const slow = probes({ launchChromium: async () => ({ ok: false, error: "browserType.launch: Timeout 8000ms exceeded." }) });
    const result = await runPreflight({ dir: "/x", video: false, site: false, probes: slow });
    expect(result.ok).toBe(true);
    expect(result.checks.find((c) => c.id === "chromium")?.status).toBe("warn");
    const broken = probes({ launchChromium: async () => ({ ok: false, error: "error while loading shared libraries: libnss3.so" }) });
    expect((await runPreflight({ dir: "/x", video: false, site: false, probes: broken })).ok).toBe(false);
  });

  it("asks for ffmpeg only with videos, and npm and room only with the site", async () => {
    const noFfmpeg = probes({ commandVersion: async (cmd) => (cmd === "npm" ? "10.9.0" : undefined) });
    expect((await runPreflight({ dir: "/x", video: true, site: false, probes: noFfmpeg })).ok).toBe(false);
    expect((await runPreflight({ dir: "/x", video: false, site: false, probes: noFfmpeg })).ok).toBe(true);
    const small = probes({ freeBytes: () => 1.2 * 1024 ** 3 });
    expect((await runPreflight({ dir: "/x", video: false, site: false, probes: small })).ok).toBe(true);
    const site = await runPreflight({ dir: "/x", video: false, site: true, probes: small });
    expect(site.ok).toBe(false);
    expect(site.checks.map((c) => c.id)).toContain("site-disk");
  });
});

describe("formatDemo", () => {
  it("lists every output, the time per stage and the next steps", () => {
    const result: DemoResult = {
      ok: true,
      dir: "/w/aida-demo",
      helpDir: "/w/aida-demo/help",
      config: "/w/aida-demo/help/aida.config.ts",
      draft: true,
      video: true,
      order: [
        { walkthrough: "a", needs: [], leaves: [] },
        { walkthrough: "b", needs: [], leaves: [] },
      ],
      timings: [
        { stage: "capture", ms: 41_000 },
        { stage: "video", ms: 75_000 },
      ],
      totalMs: 130_000,
      outputs: {
        page: "/w/aida-demo/help/pages/mark-a-repair-ready/index.mdx",
        screenshots: "/w/aida-demo/help/pages/mark-a-repair-ready/screenshots",
        pdf: "/w/aida-demo/help/pdf/mark-a-repair-ready.pdf",
        card: "/w/aida-demo/help/pdf/mark-a-repair-ready.card.pdf",
        video: "/w/aida-demo/help/videos/mark-a-repair-ready/mark-a-repair-ready.mp4",
        report: "/w/aida-demo/help/.build/report.json",
      },
      next: ["See the help site: aida demo aida-demo --site"],
    };
    const text = formatDemo(result);
    expect(text).toContain("Done in 2:10.");
    expect(text).toMatch(/PDF guide\s+\/w\/aida-demo\/help\/pdf\/mark-a-repair-ready\.pdf/);
    expect(text).toMatch(/Quick reference card\s+\/w\/aida-demo\/help\/pdf\/mark-a-repair-ready\.card\.pdf/);
    expect(text).toContain("(draft quality)");
    expect(text).toContain("Time: capture 41 s, video 1:15");
    expect(text).toContain("1. See the help site");
  });
});

describe("aidaInvocation", () => {
  it("names the command the way it can be run again", () => {
    expect(aidaInvocation("/r/packages/engine", true)).toBe("npx tsx /r/packages/engine/src/cli.ts");
    expect(aidaInvocation("/home/u/.npm/_npx/abc/node_modules/aida-docs", false)).toBe("npx aida-docs");
    expect(aidaInvocation("/usr/local/lib/node_modules/aida-docs", false)).toBe("aida");
    expect(aidaInvocation("/home/u/app/node_modules/aida-docs", false)).toBe("npx aida-docs");
  });
});
