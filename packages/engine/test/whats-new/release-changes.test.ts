// Which steps a release changed (M48): the screenshot diff against the base ref, steps matched by
// id through the walkthrough at that ref, a minimum share of changed pixels, new and renamed
// guides, and the impact-map fallback when screenshots can't be compared.
import { join } from "node:path";
import { PNG } from "pngjs";
import { afterEach, describe, expect, it } from "vitest";
import type { BaselineSource } from "../../src/ci/baseline.js";
import { detectReleaseChanges, type BaseWalkthroughLookup } from "../../src/whats-new/changes.js";
import { cleanupTmpDirs, solidPng, tmpDir } from "../ci/helpers.js";
import { idsOf, makeFixture, type GuideSpec } from "./release-fixture.js";

afterEach(() => cleanupTmpDirs());

const RED: [number, number, number] = [220, 30, 30];
const GREY: [number, number, number] = [200, 200, 200];
const BLUE: [number, number, number] = [30, 30, 220];

const guidesOf = (f: { config: { walkthroughsDir: string } }, specs: GuideSpec[]) =>
  specs.map((g) => ({ id: g.id, stepIds: idsOf(g), file: join(f.config.walkthroughsDir, `${g.id}.yaml`) }));

describe("detectReleaseChanges", () => {
  const APP: GuideSpec[] = [
    { id: "add-entry", title: "Add an entry", steps: 4, base: { 1: GREY, 2: GREY, 3: GREY, 4: GREY }, now: { 3: RED, 4: RED }, noVideo: true },
    { id: "pay-invoice", title: "Pay an invoice", steps: 2, base: null, noVideo: true },
    { id: "export-report", title: "Export a report", steps: 2, base: { 1: GREY, 2: GREY }, noVideo: true },
  ];

  it("picks the changed steps by screenshot, every step of a new guide, and nothing for an unchanged one", async () => {
    const f = await makeFixture(APP);
    const result = await detectReleaseChanges({
      guides: guidesOf(f, APP),
      publicDir: join(f.config.helpApp!, "public"),
      base: f.baseSha,
      tolerance: 0,
      diffDir: join(f.root, "diff"),
    });
    expect(result.screenshotsCompared).toBe(true);
    expect(result.changes).toEqual([
      { id: "add-entry", rule: "screenshots", steps: [3, 4], reason: `steps 3 and 4 look different since ${f.baseSha}` },
      { id: "pay-invoice", rule: "new", steps: [1, 2], newKind: "guide", reason: `new since ${f.baseSha}` },
    ]);
    expect(result.undecided).toEqual([]);
  });

  it("matches steps by id, so a step inserted in the middle doesn't make every later step look changed", async () => {
    // At the base commit: a, b, c (grey, blue, red). Now: a, new, b, c — b and c moved down one.
    const spec: GuideSpec = {
      id: "add-entry",
      title: "Add an entry",
      steps: 4,
      stepIds: ["a", "new", "b", "c"],
      baseStepIds: ["a", "b", "c"],
      base: { 1: GREY, 2: BLUE, 3: RED },
      noVideo: true,
    };
    const f = await makeFixture([spec]);
    const result = await detectReleaseChanges({ guides: guidesOf(f, [spec]), publicDir: join(f.config.helpApp!, "public"), base: f.baseSha, tolerance: 0, diffDir: join(f.root, "diff") });
    expect(result.changes).toEqual([{ id: "add-entry", rule: "screenshots", steps: [2], reason: `step 2 looks different since ${f.baseSha}` }]);

    // Without the walkthrough at the base ref, it can only go by position, and says so.
    const blind = await detectReleaseChanges({
      guides: guidesOf(f, [spec]),
      publicDir: join(f.config.helpApp!, "public"),
      base: f.baseSha,
      tolerance: 0,
      diffDir: join(f.root, "diff"),
      baseWalkthroughs: () => undefined,
    });
    expect(blind.changes).toEqual([
      {
        id: "add-entry",
        rule: "screenshots",
        steps: [2, 3, 4],
        byPosition: `its walkthrough at ${f.baseSha} can't be read`,
        reason: `steps 2, 3 and 4 look different since ${f.baseSha} (matched by position: its walkthrough at ${f.baseSha} can't be read)`,
      },
    ]);
  });

  it("counts a step as changed only past the share of pixels capture treats as a real change", async () => {
    const shot = (changedPixels: number) => {
      const png = new PNG({ width: 100, height: 100 });
      for (let i = 0; i < png.data.length; i += 4) {
        const v = i / 4 < changedPixels ? 20 : 200;
        png.data.set([v, v, v, 255], i);
      }
      return PNG.sync.write(png);
    };
    // Published now: step 1 differs from the base by 5 pixels in 10,000 (anti-aliasing noise),
    // step 2 by 300 (a real change).
    const dir = tmpDir("m48-threshold-");
    const { mkdirSync, writeFileSync } = await import("node:fs");
    mkdirSync(join(dir, "screenshots", "add-entry"), { recursive: true });
    writeFileSync(join(dir, "screenshots", "add-entry", "step-01.png"), shot(5));
    writeFileSync(join(dir, "screenshots", "add-entry", "step-02.png"), shot(300));
    const source: BaselineSource = { getScreenshot: () => shot(0), listWalkthroughIds: () => ["add-entry"] };
    const run = (threshold?: number) =>
      detectReleaseChanges({
        guides: [{ id: "add-entry", stepIds: ["one", "two"] }],
        publicDir: dir,
        base: "v2.3",
        tolerance: 8,
        threshold,
        diffDir: join(dir, "diff"),
        source,
        baseWalkthroughs: () => ({ id: "add-entry", title: "Add an entry", stepIds: ["one", "two"] }),
      });
    expect((await run()).changes.map((c) => c.steps)).toEqual([[2]]);
    // A stricter project setting still counts both; nothing identical ever counts.
    expect((await run(0.0001)).changes.map((c) => c.steps)).toEqual([[1, 2]]);
    expect((await run(0)).changes.map((c) => c.steps)).toEqual([[1, 2]]);
  });

  it("says what's true of a guide with no screenshots at the base ref: new, renamed or just newly published", async () => {
    const dir = tmpDir("m48-renamed-");
    const { mkdirSync, writeFileSync } = await import("node:fs");
    for (const id of ["brand-new", "renamed", "was-unpublished"]) {
      mkdirSync(join(dir, "screenshots", id), { recursive: true });
      writeFileSync(join(dir, "screenshots", id, "step-01.png"), solidPng(8, 8, GREY));
      writeFileSync(join(dir, "screenshots", id, "step-02.png"), solidPng(8, 8, id === "renamed" ? RED : GREY));
    }
    // At the base ref the renamed guide was "old-name", published, with the same first step.
    const source: BaselineSource = {
      getScreenshot: (id) => (id === "old-name" ? solidPng(8, 8, GREY) : undefined),
      listWalkthroughIds: () => ["old-name"],
    };
    const lookup: BaseWalkthroughLookup = ({ id }) =>
      id === "brand-new" ? null : id === "renamed" ? { id: "old-name", title: "Old name", stepIds: ["one", "two"] } : { id, title: "Was unpublished", stepIds: ["one", "two"] };
    const result = await detectReleaseChanges({
      guides: ["brand-new", "renamed", "was-unpublished"].map((id) => ({ id, stepIds: ["one", "two"] })),
      publicDir: dir,
      base: "v2.3",
      tolerance: 0,
      diffDir: join(dir, "diff"),
      source,
      baseWalkthroughs: lookup,
    });
    expect(result.changes).toEqual([
      { id: "brand-new", rule: "new", steps: [1, 2], newKind: "guide", reason: "new since v2.3" },
      {
        id: "renamed",
        rule: "screenshots",
        steps: [2],
        renamedFrom: { id: "old-name", title: "Old name" },
        reason: "step 2 looks different since v2.3; renamed from old-name",
      },
      { id: "was-unpublished", rule: "new", steps: [1, 2], newKind: "published", reason: "not on the help site at v2.3" },
    ]);
  });

  it("falls back to the impact map, guide by guide, when the base ref isn't in the help app's history", async () => {
    const f = await makeFixture(APP);
    const result = await detectReleaseChanges({
      guides: guidesOf(f, [APP[0], APP[2]]),
      publicDir: join(f.config.helpApp!, "public"),
      base: "v9.9.9",
      tolerance: 0,
      diffDir: join(f.root, "diff"),
      affected: async () => ({ ids: ["export-report"] }),
    });
    expect(result.screenshotsCompared).toBe(false);
    expect(result.changes).toHaveLength(1);
    expect(result.changes[0]).toMatchObject({ id: "export-report", rule: "impact", steps: [1, 2] });
    expect(result.changes[0].reason).toMatch(/can't be read; the impact map says/);
  });

  it("calls a guide undecided, not unchanged, when neither screenshots nor the impact map can tell", async () => {
    const f = await makeFixture(APP);
    const result = await detectReleaseChanges({
      guides: guidesOf(f, [APP[0]]),
      publicDir: join(f.config.helpApp!, "public"),
      base: "v9.9.9",
      tolerance: 0,
      diffDir: join(f.root, "diff"),
      affected: async () => {
        throw new Error("no git");
      },
    });
    expect(result.changes).toEqual([]);
    expect(result.undecided).toEqual([{ id: "add-entry", reason: "screenshots at v9.9.9 can't be read, and the impact map couldn't run" }]);
  });

  it("never hands git a ref that reads as an option", async () => {
    const f = await makeFixture([APP[2]]);
    const out = join(f.root, "injected");
    const result = await detectReleaseChanges({
      guides: guidesOf(f, [APP[2]]),
      publicDir: join(f.config.helpApp!, "public"),
      base: `--output=${out}`,
      tolerance: 0,
      diffDir: join(f.root, "diff"),
    });
    expect(result.screenshotsCompared).toBe(false);
    const { existsSync } = await import("node:fs");
    expect(existsSync(out)).toBe(false);
  });

  it("finds nothing when no screenshot changed", async () => {
    const spec: GuideSpec = { id: "export-report", title: "Export a report", steps: 2, base: { 1: GREY, 2: GREY }, noVideo: true };
    const f = await makeFixture([spec]);
    const result = await detectReleaseChanges({
      guides: guidesOf(f, [spec]),
      publicDir: join(f.config.helpApp!, "public"),
      base: f.baseSha,
      tolerance: 0,
      diffDir: join(f.root, "diff"),
    });
    expect(result.changes).toEqual([]);
    expect(result.undecided).toEqual([]);
  });
});
