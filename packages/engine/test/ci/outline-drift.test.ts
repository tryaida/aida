// M39: `aida ci` records outline drift (M29) after a capture whose steps all pass, as `aida
// capture` does, and the PR comment lists the cards whose names differ from the screen. The
// capture itself is replaced (runCapture is tested on its own); the outline file is real.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ResolvedConfig } from "../../src/config/types.js";
import type { CaptureManifest, ManifestStep } from "../../src/capture/types.js";
import type { CiResult } from "../../src/ci/types.js";

const dirs: string[] = [];
afterEach(() => {
  vi.doUnmock("../../src/capture/index.js");
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

const WALKTHROUGH = `walkthrough: add-session
title: Add a session
steps:
  - id: open
    actions:
      - do: click
        target: { role: link, name: Sessions }
  - id: add
    actions:
      - do: click
        target: { role: button, name: Add session }
`;

const OUTLINE = `cards:
  - id: add-session
    title: Add a session
    labels: [Sessions, Save session]
    status: written
`;

function step(id: string, seen: string[]): ManifestStep {
  return { id, camera: "full", cameraBox: null, events: [], doc: { image: null, highlights: [] }, impact: { urls: [], requests: [] }, checks: [], seen };
}

function project(): { dir: string; config: ResolvedConfig } {
  const dir = mkdtempSync(join(tmpdir(), "aida-ci-outline-"));
  dirs.push(dir);
  mkdirSync(join(dir, "walkthroughs"));
  writeFileSync(join(dir, "walkthroughs", "add-session.yaml"), WALKTHROUGH);
  writeFileSync(join(dir, "outline.yaml"), OUTLINE);
  const config: ResolvedConfig = {
    app: { baseUrl: "http://127.0.0.1:3000" },
    configDir: dir,
    walkthroughsDir: join(dir, "walkthroughs"),
    outDir: dir,
    buildDir: join(dir, ".build"),
    viewport: { width: 800, height: 600 },
    deviceScaleFactor: 1,
  };
  return { dir, config };
}

async function captureWith(stepsOk: boolean, seen: string[][]) {
  vi.resetModules();
  vi.doMock("../../src/capture/index.js", async (importOriginal) => {
    const real = await importOriginal<typeof import("../../src/capture/index.js")>();
    return {
      ...real,
      runCapture: vi.fn(async () => {
        const manifest: CaptureManifest = {
          workflow: "add-session",
          baseUrl: "http://127.0.0.1:3000",
          viewport: { width: 800, height: 600 },
          deviceScaleFactor: 1,
          steps: [step("open", seen[0] ?? []), step("add", seen[1] ?? [])],
        };
        const steps = [
          { id: "open", title: undefined, checks: [], ok: true, ms: 1 },
          { id: "add", title: undefined, checks: [], ok: stepsOk, ms: 1 },
        ];
        return {
          manifest,
          run: { capturedAt: "2026-10-28T00:00:00Z", durationMs: 1 },
          validation: { workflow: "add-session", ranAt: "2026-10-28T00:00:00Z", baseUrl: "http://127.0.0.1:3000", ok: stepsOk, steps, dbChecks: [], problems: { console: [], page: [], server: [] } },
          framesDir: "",
        };
      }),
    };
  });
  const { captureWalkthroughForCi } = await import("../../src/ci/capture.js");
  return captureWalkthroughForCi;
}

describe("aida ci: outline drift", { timeout: 60_000 }, () => {
  it("records drift on the card after a passing capture and returns it", async () => {
    const { dir, config } = project();
    const capture = await captureWith(true, [["Sessions"], ["Add session"]]);
    const result = await capture(join(dir, "walkthroughs", "add-session.yaml"), config, undefined, { recordDrift: true });
    expect(result.ok).toBe(true);
    expect(result.outline).toEqual({
      card: "add-session",
      drift: [expect.objectContaining({ expected: "Save session", seen: "Add session", step: "add", source: "capture" })],
    });
    const written = readFileSync(join(dir, "outline.yaml"), "utf8");
    expect(written).toContain("status: captured");
    expect(written).toContain("expected: Save session");

    const { outlineDriftSummary } = await import("../../src/ci/run.js");
    expect(outlineDriftSummary(result)).toEqual({ card: "add-session", differences: ['"Save session" (saw "Add session" at step add)'] });
  });

  it("records nothing unless asked: `aida ci --publish` never edits outline.yaml (M39 review)", async () => {
    const { dir, config } = project();
    const capture = await captureWith(true, [["Sessions"], ["Add session"]]);
    const result = await capture(join(dir, "walkthroughs", "add-session.yaml"), config, undefined);
    expect(result.ok).toBe(true);
    expect(result.outline).toBeUndefined();
    expect(readFileSync(join(dir, "outline.yaml"), "utf8")).toBe(OUTLINE);
  });

  it("leaves the card alone when a step failed, and says nothing when the card matches", async () => {
    const { dir, config } = project();
    const failing = await captureWith(false, [["Sessions"], []]);
    const failed = await failing(join(dir, "walkthroughs", "add-session.yaml"), config, undefined, { recordDrift: true });
    expect(failed.outline).toBeUndefined();
    expect(readFileSync(join(dir, "outline.yaml"), "utf8")).toBe(OUTLINE);

    const matching = await captureWith(true, [["Sessions"], ["Save session"]]);
    const ok = await matching(join(dir, "walkthroughs", "add-session.yaml"), config, undefined, { recordDrift: true });
    expect(ok.outline).toEqual({ card: "add-session", drift: [] });
    const { outlineDriftSummary } = await import("../../src/ci/run.js");
    expect(outlineDriftSummary(ok)).toBeUndefined();
  });

  it("the PR comment lists drifted cards briefly", async () => {
    const { buildCommentMarkdown } = await import("../../src/ci/comment.js");
    const result: CiResult = {
      base: "a".repeat(12),
      head: "b".repeat(12),
      affected: ["add-session", "export-list", "invite"],
      all: false,
      results: [
        { walkthrough: "add-session", status: "unchanged", tier: "cosmetic", changedSteps: [], outlineDrift: { card: "add-session", differences: ['"Save session" (saw "Add session" at step add)'] } },
        { walkthrough: "export-list", status: "changed", tier: "cosmetic", changedSteps: [], outlineDrift: { card: "export-list", differences: ['"Export" (not seen on any captured screen)', '"CSV" (not seen on any captured screen)'] } },
        { walkthrough: "invite", status: "unchanged", tier: "cosmetic", changedSteps: [] },
      ],
      newRoutes: [],
      stalePages: [],
      outDir: "/tmp",
    };
    const md = buildCommentMarkdown(result, { urlFor: (p) => p });
    expect(md).toContain("**Outline drift: 2 cards**");
    expect(md).toContain('- `add-session`: "Save session" (saw "Add session" at step add)');
    expect(md).toContain('- `export-list`: "Export" (not seen on any captured screen); "CSV" (not seen on any captured screen)');
    expect(md).not.toContain("`invite`:");
    const one = buildCommentMarkdown({ ...result, results: [result.results[0]] }, { urlFor: (p) => p });
    expect(one).toContain("**Outline drift: 1 card**");
    expect(buildCommentMarkdown({ ...result, results: [result.results[2]] }, { urlFor: (p) => p })).not.toContain("Outline drift");
  });

  it("never lets a screen's text mention, link or format in the PR comment (M39 review)", async () => {
    const { buildCommentMarkdown, commentText } = await import("../../src/ci/comment.js");
    expect(commentText("ping @octocat about #12, see [x](https://evil.example) <img src=x> `code` | a\n## heading")).toBe(
      // One line (no heading), no mention or issue link, no markdown link, HTML or code.
      "ping @\u200boctocat about #\u200b12, see \\[x\\](https:\u200b//evil.example) \\<img src=x\\> \\`code\\` \\| a ## heading",
    );
    const md = buildCommentMarkdown(
      {
        base: "a".repeat(12),
        head: "b".repeat(12),
        affected: ["pay"],
        all: false,
        results: [
          {
            walkthrough: "pay",
            status: "failed",
            tier: "app",
            changedSteps: [],
            failure: { summary: "step \"save\": boom @admin", category: "app", reason: "suspected app bug: the page threw an uncaught error: Error: see [docs](https://evil.example) cc @team #99" },
            outlineDrift: { card: "pay", differences: ['"Pay" (saw "Pay @here [now](https://x.example)" at step save)'] },
          },
        ],
        newRoutes: [],
        stalePages: [],
        outDir: "/tmp",
      },
      { urlFor: (p) => p },
    );
    expect(md).not.toMatch(/@(admin|team|here)/);
    expect(md).not.toMatch(/#99/);
    expect(md).not.toContain("](https://");
    expect(md).not.toContain("https://evil");
    expect(md).toContain("- `pay`: ");
  });
});
