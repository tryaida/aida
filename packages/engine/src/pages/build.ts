// Builds one walkthrough's Markdown help page + annotated step screenshots from its capture
// output. Port of the original pipeline's docs.mjs, generalised off its one app and split into
// generated/human-edited blocks (markers.ts) so a rebuild never clobbers a person's edits.
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { displayWalkthrough, libraryPlacement, pathWalkthrough, type Walkthrough, type WalkthroughPath } from "../walkthrough/index.js";
import type { CaptureManifest, ValidationResult } from "../capture/index.js";
import { readPathCaptures, type PathCapture } from "../capture/path-files.js";
import { redactLine } from "../capture/redact.js";
import { appProblems } from "../capture/failure-report.js";
import { pathClipLinks } from "../render/clips.js";
import { annotateFrame, renderPrintFrame } from "./annotate.js";
import { PNG } from "pngjs";
import {
  cropClassFor,
  edgeMap,
  focusCrop,
  grayFrame,
  normaliseCropClasses,
  placeCropClass,
  planStepFigures,
  refineCrop,
  tightenCropClass,
  type EdgeMap,
  type GrayFrame,
  type StepFigurePlan,
} from "./focus.js";
import {
  buildBeforeYouStartBlock,
  buildChapterBlock,
  buildFrontmatterBlock,
  buildHeaderBlock,
  buildLastCheckedBlock,
  buildOtherWaysHeadingBlock,
  buildPathBlock,
  buildPathClipBlock,
  buildPathJoinBlock,
  buildPathStepBlock,
  buildStepBlock,
  buildStepsHeadingBlock,
  chaptersOf,
  pathScreenshotFile,
  screenshotFile,
  stepBlockKey,
  type StepStatus,
} from "./content.js";
import {
  mergeBlocks,
  readSidecar,
  renameLegacyKey,
  sidecarPath,
  stripMarkers,
  writeSidecar,
  type GeneratedBlock,
} from "./markers.js";
import type { BuildPageOptions, BuildPageResult, PageSuggestion, PrintFigure } from "./types.js";

type BoxLike = { x: number; y: number; w: number; h: number };

interface ScreenshotJob {
  stepNumber: number;
  frame: string;
  highlights: BoxLike[];
  callouts: { box: BoxLike; label?: string }[];
  blur: BoxLike[];
  plan: StepFigurePlan;
}

function readJson<T>(file: string): T {
  return JSON.parse(readFileSync(file, "utf8")) as T;
}

function readJsonIfExists<T>(file: string): T | undefined {
  return existsSync(file) ? readJson<T>(file) : undefined;
}

/** Order-insensitive: tries run.json first (new, timestamps-only), then validation.json/manifest.json. */
function resolveLastChecked(captureDir: string, validation: ValidationResult | undefined, manifest: CaptureManifest): string | undefined {
  const run = readJsonIfExists<Record<string, unknown>>(path.join(captureDir, "run.json"));
  const fromRun = run && (typeof run.ranAt === "string" ? run.ranAt : typeof run.capturedAt === "string" ? run.capturedAt : undefined);
  if (fromRun) return fromRun;
  if (validation?.ranAt) return validation.ranAt;
  return manifest.capturedAt;
}

function videoLinks(videoDir: string | undefined, id: string, pageDir: string): { video?: string; srt?: string; vtt?: string } {
  if (!videoDir) return {};
  const base = path.join(videoDir, id);
  const rel = (f: string): string => path.relative(pageDir, path.join(base, f));
  const out: { video?: string; srt?: string; vtt?: string } = {};
  if (existsSync(path.join(base, `${id}.mp4`))) out.video = rel(`${id}.mp4`);
  if (existsSync(path.join(base, `${id}.srt`))) out.srt = rel(`${id}.srt`);
  if (existsSync(path.join(base, `${id}.vtt`))) out.vtt = rel(`${id}.vtt`);
  return out;
}

/**
 * Builds `wf`'s page into `<outDir>/<wf.walkthrough>/`: `index.md` (generated/human-edit
 * markers), `index.plain.md` (markers stripped, for llms.txt), and `screenshots/step-NN.png`.
 * Refuses to mark the page publishable when the capture it's built from didn't fully pass.
 */
export async function buildPage(written: Walkthrough, captureDir: string, outDir: string, opts: BuildPageOptions = {}): Promise<BuildPageResult> {
  // Every word the page prints with its `{{data}}` filled in (M35).
  const wf = displayWalkthrough(written);
  const id = wf.walkthrough;
  const manifestPath = path.join(captureDir, "manifest.json");
  if (!existsSync(manifestPath)) {
    throw new Error(`no capture manifest at ${manifestPath} — run \`aida capture\` for "${id}" first`);
  }
  const manifest = readJson<CaptureManifest>(manifestPath);
  const validation = readJsonIfExists<ValidationResult>(path.join(captureDir, "validation.json"));

  const pageDir = path.join(outDir, id);
  const screenshotsDir = path.join(pageDir, "screenshots");
  await mkdir(screenshotsDir, { recursive: true });

  const problems: string[] = [];
  if (!validation) {
    problems.push(`no capture validation found at ${path.join(captureDir, "validation.json")} — the page can't be marked publishable until it's captured and validated`);
  } else if (!validation.ok) {
    const failed = validation.steps.filter((s) => !s.ok);
    // Redacted and capped: a step error can carry what the page showed (`Received …`).
    for (const s of failed) problems.push(redactLine(`step "${s.id ?? s.title ?? "?"}" failed: ${s.error ?? "not ok"}`));
    // The app's own only: third-party ones are listed in validation.json but fail nothing.
    const own = appProblems(validation.problems);
    if (own.page.length > 0) problems.push(`${own.page.length} page error(s) during capture`);
    if (own.server.length > 0) problems.push(`${own.server.length} 5xx response(s) during capture`);
    if (validation.dbChecks.some((c) => !c.ok)) problems.push("one or more database checks failed");
  }
  const passed = Boolean(validation?.ok);
  const lastChecked = resolveLastChecked(captureDir, validation, manifest);

  // Per-step status + screenshot annotation. manifest/validation steps are shorter than
  // wf.steps when capture stopped early on a failure — those later steps have no data yet.
  const statuses: StepStatus[] = [];
  const screenshotJobs: ScreenshotJob[] = [];
  // Which frame each step shows and which boxes on it are real (focus.ts) — a highlight drawn
  // before a click that opened another page belongs to that earlier frame, not `doc.image`.
  // Blur declared on any step — main or any path's — rules out every before-click frame here:
  // that frame can show a screen a path blurs, with nothing covering it (M32 privacy rule).
  const blurAnywhere = [...wf.steps, ...(wf.paths ?? []).flatMap((p) => p.steps)].some((s) => (s.blur?.length ?? 0) > 0);
  const plans = new Map(planStepFigures(wf, manifest, { anyBlur: blurAnywhere, frames: frameGrays(captureDir, manifest) }).map((p) => [p.step, p] as const));

  for (let i = 0; i < wf.steps.length; i++) {
    const stepNumber = i + 1;
    const vStep = validation?.steps[i];
    const mStep = manifest.steps[i];
    if (!mStep) {
      statuses.push({ ok: false, problem: "not run — capture stopped before this step" });
      continue;
    }
    const ok = vStep ? vStep.ok : true;
    const status: StepStatus = { ok, screenshot: mStep.doc.image ? screenshotFile(stepNumber) : undefined };
    if (!ok) status.problem = vStep?.error ? redactLine(vStep.error) : "this step did not pass the last capture";
    statuses.push(status);
    const plan = plans.get(stepNumber);
    if (mStep.doc.image && plan) screenshotJobs.push(screenshotJob(wf.steps[i], mStep, stepNumber, plan));
  }

  const printDir = opts.printDir ?? path.join(captureDir, "print");
  const { screenshots, printFigures } = await renderScreenshots(captureDir, manifest, screenshotJobs, screenshotsDir, printDir, opts);
  // Other ways to do this (decision 34): each path's opening steps, from its own capture. After
  // the main figures, whose render clears `printDir`.
  const otherWays = await buildOtherWays(wf, captureDir, screenshotsDir, printDir, validation, opts);
  problems.push(...otherWays.problems);

  // Content blocks, in document order.
  const blocks: GeneratedBlock[] = [
    buildFrontmatterBlock({
      title: wf.title,
      description: wf.summary?.replace(/\s+/g, " ").trim() || undefined,
      for: wf.for,
      walkthrough: id,
      section: libraryPlacement(wf.section, id).displayPath,
      steps: wf.steps.length,
      lastChecked,
      passed,
      links: videoLinks(opts.videoDir, id, pageDir),
    }),
    buildHeaderBlock(wf),
  ];
  const beforeYouStart = buildBeforeYouStartBlock(wf, opts.readers, opts.roles);
  if (beforeYouStart) blocks.push(beforeYouStart);
  blocks.push(buildStepsHeadingBlock());

  // A "Part 1" heading over every step of a single-part guide says nothing the title doesn't
  // (decision 36): parts are headed only when there are two or more.
  const chapters = chaptersOf(wf.steps);
  let lastChapter: string | undefined;
  for (let i = 0; i < wf.steps.length; i++) {
    const step = wf.steps[i];
    if (chapters.length > 1 && step.chapter && step.chapter !== lastChapter) {
      blocks.push(buildChapterBlock(step.chapter, chapters.indexOf(step.chapter)));
      lastChapter = step.chapter;
    }
    blocks.push(buildStepBlock(step, i + 1, statuses[i], wf.data));
  }

  blocks.push(...otherWays.blocks);

  // No "Good to know" block: the only source was `outro.recap`, the video's closing summary,
  // which restates the steps. A person can still add one by hand; it's kept as their edit.
  blocks.push(buildLastCheckedBlock(lastChecked, passed));

  const indexFile = path.join(pageDir, "index.mdx");
  const legacyIndexFile = path.join(pageDir, "index.md");
  const plainFile = path.join(pageDir, "index.plain.md");
  // Migration: a page built before the .md -> .mdx rename reads as its own previous build
  // (preserving human edits) rather than as a brand-new page with no history.
  const existing = existsSync(indexFile)
    ? readFileSync(indexFile, "utf8")
    : existsSync(legacyIndexFile)
      ? readFileSync(legacyIndexFile, "utf8")
      : undefined;
  const sidecarInRaw = existsSync(sidecarPath(indexFile)) ? readSidecar(indexFile) : readSidecar(legacyIndexFile);

  // One-time migration: a page built before step blocks were keyed by `step.id` has them keyed
  // by position (`step-1`, `step-2`, ...) instead. Rename each to its new id-based key (see
  // `stepBlockKey`) before merging, so a step's human edits stay attached to that step through
  // this upgrade instead of being orphaned as a "removed" block and a brand-new one appended.
  let migratedText = existing;
  let sidecarIn = sidecarInRaw;
  if (migratedText !== undefined) {
    for (let i = 0; i < wf.steps.length; i++) {
      const oldKey = `step-${i + 1}`;
      const newKey = stepBlockKey(wf.steps[i], i + 1);
      const renamed = renameLegacyKey(migratedText, sidecarIn, oldKey, newKey);
      migratedText = renamed.text;
      sidecarIn = renamed.sidecar;
    }
  }

  const { text, sidecar, suggestions } = mergeBlocks(migratedText, blocks, sidecarIn);

  writeFileSync(indexFile, text.endsWith("\n") ? text : `${text}\n`);
  writeFileSync(plainFile, stripMarkers(text).replace(/\n{3,}/g, "\n\n"));
  writeSidecar(indexFile, sidecar);
  // Clean up the pre-rename files once migrated onto .mdx, so a page never ends up publishing
  // both an old .md and a new .mdx copy of itself.
  if (existsSync(legacyIndexFile)) rmSync(legacyIndexFile, { force: true });
  if (existsSync(sidecarPath(legacyIndexFile))) rmSync(sidecarPath(legacyIndexFile), { force: true });

  return {
    id,
    outDir: pageDir,
    indexFile,
    plainFile,
    screenshotsDir,
    screenshots,
    passed,
    publishable: passed && problems.length === 0,
    lastChecked,
    problems,
    suggestions: suggestions as PageSuggestion[],
    printFigures,
    ...(otherWays.screenshots.length > 0 ? { pathScreenshots: otherWays.screenshots } : {}),
    ...(Object.keys(otherWays.figures).length > 0 ? { pathFigures: otherWays.figures } : {}),
  };
}

/** One step's screenshot job: the planned frame and boxes, with the step's callouts and blur.
 * Callout order and label text come from the walkthrough's own `callouts:` list (so the Studio's
 * reorder/edit actions control it); the box each resolves to comes from this run's manifest,
 * keyed by id — an entry whose target wasn't found this run (manifest has no matching id) is
 * skipped rather than drawn with a stale box. */
function screenshotJob(step: Walkthrough["steps"][number], mStep: CaptureManifest["steps"][number], stepNumber: number, plan: StepFigurePlan): ScreenshotJob {
  const resolvedCallouts = new Map((mStep.doc.callouts ?? []).map((c) => [c.id, c.box] as const));
  const resolvedBlur = new Map((mStep.doc.blur ?? []).map((b) => [b.id, b.box] as const));
  const callouts: { box: BoxLike; label?: string }[] = [];
  for (const c of step.callouts ?? []) {
    const box = resolvedCallouts.get(c.id);
    if (box) callouts.push({ box, label: c.label });
  }
  const blur: BoxLike[] = [];
  for (const b of step.blur ?? []) {
    const box = resolvedBlur.get(b.id);
    if (box) blur.push(box);
  }
  // `plan.frame` is only ever not `doc.image` for a step with no callouts in a walkthrough
  // with no blur entries at all, so these lists are empty whenever the frame differs.
  return { stepNumber, frame: plan.frame, highlights: plan.targets, callouts, blur, plan };
}

interface OtherWays {
  blocks: GeneratedBlock[];
  problems: string[];
  screenshots: string[];
  figures: Record<string, PrintFigure[]>;
}

/** Why a path's capture can't be shown as verified, or undefined when it passed. */
function pathCaptureProblem(capture: PathCapture | undefined): string | undefined {
  if (!capture?.manifest || !capture.validation) return "this way hasn't been captured yet";
  if (capture.validation.ok) return undefined;
  const failed = capture.validation.steps.find((s) => !s.ok);
  if (failed) return redactLine(`step "${failed.id ?? failed.title ?? "?"}" failed: ${failed.error ?? "not ok"}`);
  const notCaptured = (capture.validation as { notCaptured?: unknown }).notCaptured;
  return typeof notCaptured === "string" ? redactLine(`not captured: ${notCaptured}`) : "this way didn't pass its last capture";
}

/**
 * "Other ways to do this": per path, its title, `when` sentence, the writer's note when capture
 * flagged a difference, its opening steps with screenshots and print figures (the same focus and
 * blur handling as main steps, from the path's own capture), and where it joins the main steps
 * (nothing more for a path that runs to its own end).
 * A path that didn't pass its capture is marked not verified and stops the page publishing.
 */
async function buildOtherWays(
  wf: Walkthrough,
  captureDir: string,
  screenshotsDir: string,
  printDir: string,
  validation: ValidationResult | undefined,
  opts: BuildPageOptions,
): Promise<OtherWays> {
  const out: OtherWays = { blocks: [], problems: [], screenshots: [], figures: {} };
  const pathShotsDir = path.join(screenshotsDir, "paths");
  await rm(pathShotsDir, { recursive: true, force: true });
  const paths: WalkthroughPath[] = wf.paths ?? [];
  if (paths.length === 0) return out;
  const captures = new Map(readPathCaptures(captureDir, wf).map((c) => [c.pathId, c] as const));
  const flagged = new Set((validation?.pathDiffs ?? []).map((d) => d.path));
  // Blur on any step, main or any path's, means no path figure swaps to an earlier frame (focus.ts).
  const blurAnywhere = [...wf.steps, ...paths.flatMap((p) => p.steps)].some((s) => (s.blur?.length ?? 0) > 0);
  const clips = new Map(pathClipLinks(opts.videoDir, wf).map((c) => [c.pathId, c] as const));

  out.blocks.push(buildOtherWaysHeadingBlock());
  for (const p of paths) {
    const run = pathWalkthrough(wf, p);
    const capture = captures.get(p.id);
    const problem = pathCaptureProblem(capture);
    if (problem) out.problems.push(`path "${p.id}": ${problem}`);
    out.blocks.push(buildPathBlock(p, { showNote: flagged.has(p.id), problem }));
    // Its narrated clip (M35), when render made one: only for a path whose capture passed.
    const clip = problem ? undefined : clips.get(p.id);
    if (clip) out.blocks.push(buildPathClipBlock(p, clip));

    const manifest = capture?.manifest;
    const jobs: ScreenshotJob[] = [];
    const statuses: StepStatus[] = [];
    const plans = manifest
      ? new Map(planStepFigures(run.walkthrough, manifest, { anyBlur: blurAnywhere, frames: capture ? frameGrays(capture.dir, manifest) : undefined }).map((pl) => [pl.step, pl] as const))
      : new Map<number, StepFigurePlan>();
    for (let i = 0; i < p.steps.length; i++) {
      const n = i + 1;
      const mStep = manifest?.steps[i];
      const vStep = capture?.validation?.steps[i];
      if (!mStep) {
        statuses.push({ ok: false, problem: problem ?? "not run — capture stopped before this step" });
        continue;
      }
      const ok = vStep ? vStep.ok : true;
      statuses.push({
        ok,
        screenshot: mStep.doc.image ? pathScreenshotFile(p.id, n) : undefined,
        ...(ok ? {} : { problem: vStep?.error ? redactLine(vStep.error) : "this step did not pass the last capture" }),
      });
      const plan = plans.get(n);
      if (mStep.doc.image && plan) jobs.push(screenshotJob(p.steps[i], mStep, n, plan));
    }
    p.steps.forEach((step, i) => out.blocks.push(buildPathStepBlock(p.id, step, i + 1, statuses[i], wf.data)));
    // A path that runs to its own end shows all its steps and no "continue from" (decision 37).
    if (!run.alone) out.blocks.push(buildPathJoinBlock(p.id, wf.steps[run.joinIndex]!, run.joinIndex + 1));

    if (manifest && capture && jobs.length > 0) {
      const rendered = await renderScreenshots(capture.dir, manifest, jobs, pathShotsDir, path.join(printDir, "paths", p.id), opts, {
        fileName: (n) => path.basename(pathScreenshotFile(p.id, n)),
        clean: false,
      });
      out.screenshots.push(...rendered.screenshots);
      out.figures[p.id] = rendered.printFigures;
    }
  }
  return out;
}

interface ScreenshotNaming {
  /** File name in `screenshotsDir` for a step number. */
  fileName: (stepNumber: number) => string;
  /** Remove files in `screenshotsDir` no job wrote (default true; false when the caller cleared
   * the dir itself because several renders share it). */
  clean?: boolean;
}

const MAIN_NAMING: ScreenshotNaming = { fileName: (n) => path.basename(screenshotFile(n)) };

function readEdges(pngFile: string): EdgeMap {
  const png = PNG.sync.read(readFileSync(pngFile));
  return edgeMap(png.data, png.width, png.height);
}

/** Reads capture frames as grey levels at one pixel per CSS px, for `planStepFigures` to tell a
 * target still on screen after its click from one a dialog now covers. Cached per frame;
 * undefined when a frame can't be read (then the step is planned as before M36). */
export function frameGrays(captureDir: string, manifest: Pick<CaptureManifest, "deviceScaleFactor">): (frame: string) => GrayFrame | undefined {
  const cache = new Map<string, GrayFrame | undefined>();
  return (frame) => {
    if (cache.has(frame)) return cache.get(frame);
    let out: GrayFrame | undefined;
    try {
      const png = PNG.sync.read(readFileSync(path.join(captureDir, "frames", frame)));
      out = grayFrame(png.data, png.width, png.height, Math.max(manifest.deviceScaleFactor ?? 1, 1));
    } catch {
      out = undefined;
    }
    // Keep the last few only: a frame is compared with its neighbours, not across the guide.
    if (cache.size > 6) cache.delete(cache.keys().next().value!);
    cache.set(frame, out);
    return out;
  };
}

async function renderScreenshots(
  captureDir: string,
  manifest: CaptureManifest,
  jobs: ScreenshotJob[],
  screenshotsDir: string,
  printDir: string,
  opts: BuildPageOptions,
  naming: ScreenshotNaming = MAIN_NAMING,
): Promise<{ screenshots: string[]; printFigures: PrintFigure[] }> {
  // Remove screenshots from a previous build for steps that no longer exist/capture. Files only:
  // `screenshots/paths/` holds the other ways' screenshots (buildOtherWays).
  await mkdir(screenshotsDir, { recursive: true });
  if (naming.clean !== false) {
    const wanted = new Set(jobs.map((j) => naming.fileName(j.stepNumber)));
    for (const existing of await readdir(screenshotsDir, { withFileTypes: true }).catch(() => [])) {
      if (existing.isFile() && !wanted.has(existing.name)) {
        await rm(path.join(screenshotsDir, existing.name), { force: true });
      }
    }
  }
  await rm(printDir, { recursive: true, force: true });
  if (jobs.length === 0) return { screenshots: [], printFigures: [] };
  await mkdir(printDir, { recursive: true });

  const { chromium } = await import("playwright");
  const browser = await chromium.launch();
  const written: string[] = [];
  const printFigures: PrintFigure[] = [];
  try {
    const page = await browser.newPage();
    // Print images render at the capture's own device scale (capped at 2), so a focus crop
    // printed larger than it was on screen stays sharp.
    const scale = Math.min(Math.max(manifest.deviceScaleFactor ?? 1, 1), 2);
    const printPage = await browser.newPage({ deviceScaleFactor: scale });
    // Pass 1: the site screenshot, the clean full screen, and each step's focus crop as a size
    // class (focus.ts) — planned from its targets, refined against the clean screen.
    const measured: { job: ScreenshotJob; framePath: string; full: string; cls?: number }[] = [];
    for (const job of jobs) {
      const framePath = path.join(captureDir, "frames", job.frame);
      const outPath = path.join(screenshotsDir, naming.fileName(job.stepNumber));
      await annotateFrame(page, framePath, manifest.viewport, job.highlights, job.stepNumber, outPath, {
        width: opts.screenshotWidth,
        callouts: job.callouts,
        blur: job.blur,
      });
      written.push(outPath);

      const nn = String(job.stepNumber).padStart(2, "0");
      const full = path.join(printDir, `step-${nn}.full.png`);
      await renderPrintFrame(printPage, framePath, manifest.viewport, job.blur, { full });
      const planned = focusCrop(job.plan.targets, manifest.viewport, job.plan.points);
      let cls: number | undefined;
      if (planned) {
        // Refined against the clean full screen just written (blur burned in): how much
        // context the target needs, which picks its size class.
        let refined = planned;
        let edges: EdgeMap | undefined;
        try {
          edges = readEdges(full);
          refined = refineCrop(edges, planned, job.plan.targets, job.plan.points);
        } catch {
          // Unreadable: the planned crop stands.
        }
        cls = cropClassFor(refined, job.plan.targets, job.plan.points, manifest.viewport);
        // A smaller class when what the bigger one adds is blank space.
        if (cls !== undefined && edges) cls = tightenCropClass(edges, cls, job.plan.targets, job.plan.points, manifest.viewport);
      }
      measured.push({ job, framePath, full, cls });
    }

    // Pass 2: one or two neighbouring sizes across the guide (M36), each crop centred on its own
    // step's target and nudged onto clean edges, cut from the same blurred render.
    // Only crops the guide prints as crops count: a new screen prints in full (its crop is for
    // the card, whose cells are one size anyway).
    const printed = normaliseCropClasses(measured.map((m) => (m.job.plan.newScreen ? undefined : m.cls)));
    const classes = measured.map((m, i) => (m.job.plan.newScreen ? m.cls : printed[i]));
    for (let i = 0; i < measured.length; i++) {
      const { job, framePath, full } = measured[i];
      const cls = classes[i];
      const nn = String(job.stepNumber).padStart(2, "0");
      const cropPath = path.join(printDir, `step-${nn}.crop.png`);
      let edges: EdgeMap | undefined;
      try {
        if (cls !== undefined) edges = readEdges(full);
      } catch {
        // Unreadable: centred on the target, no edge nudge.
      }
      const box = cls !== undefined ? placeCropClass(edges, cls, job.plan.targets, job.plan.points, manifest.viewport) : undefined;
      const cropBox = box ? await renderPrintFrame(printPage, framePath, manifest.viewport, job.blur, { crop: { box, path: cropPath } }) : undefined;
      printFigures.push({
        step: job.stepNumber,
        full,
        ...(cropBox ? { crop: cropPath, cropBox } : {}),
        viewport: { width: manifest.viewport.width, height: manifest.viewport.height },
        targets: job.highlights,
        callouts: job.callouts,
        newScreen: job.plan.newScreen,
      });
    }
  } finally {
    await browser.close();
  }
  return { screenshots: written, printFigures };
}
