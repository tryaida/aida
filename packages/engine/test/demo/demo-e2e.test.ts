// `aida demo` end to end (AIDA_TEST_SLOW=1, `npm run test:slow`): the real sample app, the real
// safety gate and build pipeline, draft video, into a temp folder. No help-site install (--site
// is ~700 MB). A second run reuses the first one's caches and keeps an edited walkthrough.
import { afterAll, describe, expect, it } from "vitest";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, statfsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { liveCount, runDemo, stopAll, type DemoResult } from "../../src/demo/index.js";

const SLOW = process.env.AIDA_TEST_SLOW === "1";

// Two builds and their caches take a few hundred MB, and the demo's own disk check wants 1 GB
// free: a small tmpfs /tmp can't hold that, so fall back to the package's (git-ignored) .vitest.
function roomyTmp(): string {
  const free = (dir: string) => {
    const st = statfsSync(dir);
    return st.bavail * st.bsize;
  };
  if (free(tmpdir()) > 3 * 1024 ** 3) return tmpdir();
  const local = join(import.meta.dirname, "..", "..", ".vitest");
  mkdirSync(local, { recursive: true });
  return local;
}

describe.skipIf(!SLOW)("aida demo end to end", { timeout: 30 * 60_000 }, () => {
  // Not "aida-*": a cleaner on the dev machine deletes /tmp/aida-* folders mid-run.
  const root = SLOW ? mkdtempSync(join(roomyTmp(), "demo-e2e-")) : "";
  const dir = join(root, "aida-demo");
  afterAll(async () => {
    await stopAll();
    if (root) rmSync(root, { recursive: true, force: true });
  });

  it("builds every output from the sample app and stops it", async () => {
    const lines: string[] = [];
    const { result, running } = await runDemo({ dir, port: 0, log: (l) => lines.push(l) });
    expect(result.error, [...lines, ...(result.failures ?? [])].join("\n")).toBeUndefined();
    expect(result.ok).toBe(true);
    expect(running).toEqual([]);
    expect(liveCount()).toBe(0);
    expect(result.app?.running).toBe(false);
    const o = result.outputs!;
    // Where the outputs must be, worked out here rather than taken from the result, so a missing
    // one can't pass as "not reported".
    const id = "mark-a-repair-ready";
    const help = join(dir, "help");
    const pdf = join(help, "pdf", `${id}.pdf`);
    const card = join(help, "pdf", `${id}.card.pdf`);
    const video = join(help, "videos", id, `${id}.mp4`);
    expect([o.pdf, o.card, o.video]).toEqual([pdf, card, video]);
    for (const file of [join(help, "pages", id, "index.mdx"), pdf, card, join(help, "pdf", "manual.pdf"), video, join(help, "videos", id, `${id}.vtt`), o.proof!]) {
      expect(existsSync(file), file).toBe(true);
      expect(statSync(file).size, file).toBeGreaterThan(100);
    }
    for (const file of [pdf, card]) expect(readFileSync(file).subarray(0, 5).toString("latin1"), file).toBe("%PDF-");
    const seconds = Number(spawnSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", video], { encoding: "utf8" }).stdout.trim());
    expect(seconds).toBeGreaterThan(10);
    // The help app's aida-docs installs from here: this checkout, from source.
    const spec = JSON.parse(readFileSync(join(help, "package.json"), "utf8")).dependencies["aida-docs"] as string;
    expect(spec.startsWith("file:") && existsSync(join(spec.slice(5), "package.json"))).toBe(true);
    // A filter link is "Waiting", its count only a description: no alt text names "Waiting 3".
    expect(readFileSync(join(help, "pages", id, "index.mdx"), "utf8")).not.toMatch(/Waiting \d/);
    expect(lines.slice(0, 2).join(" ")).toMatch(/about 5 to 10 minutes/);
    expect(lines.some((l) => /Narration runs a voice model/.test(l))).toBe(true);
    expect(result.order!.map((w) => w.walkthrough).indexOf("take-in-a-repair")).toBeLessThan(
      result.order!.map((w) => w.walkthrough).indexOf("mark-a-repair-ready"),
    );
    const report = JSON.parse(readFileSync(o.report, "utf8"));
    expect(report.ok).toBe(true);
    expect(report.walkthroughs.every((w: { stages: { capture: { status: string } } }) => w.stages.capture.status === "ok")).toBe(true);
    expect(lines.some((l) => /captured mark-a-repair-ready/.test(l))).toBe(true);
    // The help site's page is staged into the help app, in its library section.
    expect(existsSync(join(dir, "help", "content", "docs", "how-do-i", "repair-jobs", "mark-a-repair-ready"))).toBe(true);
  });

  it("runs again into the same folder, reusing the narration and keeping an edited walkthrough", async () => {
    const edited = join(dir, "help", "walkthroughs", "change-shop-settings.yaml");
    appendFileSync(edited, "# my note\n");
    // The way a person runs it again: a new process (the config's baseUrl is read when the config
    // first loads in a process, and this second run's app is on another port).
    const tsx = join(import.meta.dirname, "..", "..", "..", "..", "node_modules", ".bin", "tsx");
    const command = join(import.meta.dirname, "..", "..", "src", "commands", "demo.ts");
    const code = `import(${JSON.stringify(command)}).then(async (m) => { process.exitCode = await m.runDemoCommand({ dir: ${JSON.stringify(dir)}, port: "0" }, true); });`;
    const run = spawnSync(tsx, ["--eval", code], { encoding: "utf8", timeout: 25 * 60_000 });
    const result = JSON.parse(run.stdout.trim().split("\n").pop()!) as DemoResult;
    expect(run.status, run.stderr.slice(-2000)).toBe(0);
    const why = [result.error, ...(result.failures ?? []), ...(result.checks ?? []).filter((c) => c.status === "fail").map((c) => `${c.label}: ${c.detail}`)];
    expect(result.ok, why.join("\n")).toBe(true);
    expect(result.folder?.state).toBe("demo");
    expect(result.folder?.files.kept).toContain("help/walkthroughs/change-shop-settings.yaml");
    expect(readFileSync(edited, "utf8")).toContain("# my note");
    const voice = JSON.parse(readFileSync(join(dir, "help", ".build", "mark-a-repair-ready", "voice", "manifest.json"), "utf8"));
    expect(voice.summary.synthesized).toBe(0);
    expect(liveCount()).toBe(0);
  });
});
