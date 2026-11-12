// The demo's progress lines: one per output written since the build started, older files ignored.
import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { formatElapsed, outputsToWatch, stageProgress, watchProgress } from "../../src/demo/progress.js";

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function write(file: string, mtime?: number): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, "x");
  if (mtime !== undefined) utimesSync(file, mtime / 1000, mtime / 1000);
}

describe("demo progress", () => {
  it("watches each stage's file per walkthrough, videos only when asked", () => {
    const paths = { buildDir: "/b", outDir: "/o" };
    const without = outputsToWatch(paths, ["a", "b"], { video: false });
    expect(without.map((o) => o.stage)).toEqual(["capture", "capture", "pages", "pages", "pdf", "pdf"]);
    const withVideo = outputsToWatch(paths, ["a"], { video: true });
    expect(withVideo.map((o) => o.file)).toEqual(["/b/a/capture/validation.json", "/b/a/voice/manifest.json", "/o/videos/a/a.mp4", "/o/pages/a/index.mdx", "/o/pdf/a.pdf"]);
  });

  it("reports new outputs once each, and ignores ones from an earlier build", () => {
    const root = mkdtempSync(join(tmpdir(), "demo-progress-test-"));
    dirs.push(root);
    const outputs = outputsToWatch({ buildDir: join(root, "b"), outDir: join(root, "o") }, ["a", "b"], { video: false });
    const since = Date.now();
    write(outputs[1].file, since - 60_000); // b's capture from an earlier run
    const lines: string[] = [];
    const watcher = watchProgress(outputs, (l) => lines.push(l), { since, intervalMs: 60_000, quietMs: 10 * 60_000 });
    write(outputs[0].file);
    watcher.stop();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/captured a \(1 of 2\)$/);
  });

  it("formats elapsed time as m:ss", () => {
    expect(formatElapsed(0)).toBe("0:00");
    expect(formatElapsed(65_400)).toBe("1:05");
  });

  it("says which walkthrough is being narrated as each narration starts, and nothing for other stages", () => {
    const lines: string[] = [];
    let heard = 0;
    let t = 0;
    const onProgress = stageProgress((l) => lines.push(l), { since: 0, narrations: 2, heard: () => (heard += 1), now: () => t });
    onProgress({ walkthrough: "add-job", title: "Add a job", stage: "capture", phase: "start" });
    t = 65_000;
    onProgress({ walkthrough: "add-job", title: "Add a job", stage: "voice", phase: "start" });
    onProgress({ walkthrough: "add-job", title: "Add a job", stage: "voice", phase: "done", status: "ok", ms: 10 });
    onProgress({ walkthrough: "close-job", stage: "voice", phase: "start" });
    onProgress({ walkthrough: "add-job", stage: "render", phase: "start" });
    expect(lines).toEqual(["  1:05  Narrating Add a job (1 of 2)...", "  1:05  Narrating close-job (2 of 2)..."]);
    expect(heard).toBe(5);
  });
});
