// Builds one walkthrough's Markdown help page + annotated step screenshots from its capture
// output. Port of the original pipeline's docs.mjs, generalised off its one app and split into
// generated/human-edited blocks (markers.ts) so a rebuild never clobbers a person's edits.
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { libraryPlacement, type Walkthrough } from "../walkthrough/index.js";
import type { CaptureManifest, ValidationResult } from "../capture/index.js";
import { redactLine } from "../capture/redact.js";
import { annotateFrame } from "./annotate.js";
import {
  buildBeforeYouStartBlock,
  buildChapterBlock,
  buildFrontmatterBlock,
  buildGoodToKnowBlock,
  buildHeaderBlock,
  buildLastCheckedBlock,
  buildStepBlock,
  buildStepsHeadingBlock,
  chaptersOf,
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
import type { BuildPageOptions, BuildPageResult, PageSuggestion } from "./types.js";

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
export async function buildPage(wf: Walkthrough, captureDir: string, outDir: string, opts: BuildPageOptions = {}): Promise<BuildPageResult> {
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
    if (validation.problems.page.length > 0) problems.push(`${validation.problems.page.length} page error(s) during capture`);
    if (validation.problems.server.length > 0) problems.push(`${validation.problems.server.length} 5xx response(s) during capture`);
    if (validation.dbChecks.some((c) => !c.ok)) problems.push("one or more database checks failed");
  }
  const passed = Boolean(validation?.ok);
  const lastChecked = resolveLastChecked(captureDir, validation, manifest);

  // Per-step status + screenshot annotation. manifest/validation steps are shorter than
  // wf.steps when capture stopped early on a failure — those later steps have no data yet.
  const statuses: StepStatus[] = [];
  const screenshotJobs: {
    stepNumber: number;
    frame: string;
    highlights: { x: number; y: number; w: number; h: number }[];
    callouts: { box: { x: number; y: number; w: number; h: number }; label?: string }[];
    blur: { x: number; y: number; w: number; h: number }[];
  }[] = [];

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
    if (mStep.doc.image) {
      // Callout order and label text come from the walkthrough's own `callouts:` list (so the
      // Studio's reorder/edit actions control it); the box each resolves to comes from this
      // run's manifest, keyed by id — an entry whose target wasn't found this run (manifest has
      // no matching id) is skipped rather than drawn with a stale box.
      const resolvedCallouts = new Map((mStep.doc.callouts ?? []).map((c) => [c.id, c.box] as const));
      const resolvedBlur = new Map((mStep.doc.blur ?? []).map((b) => [b.id, b.box] as const));
      const callouts: { box: { x: number; y: number; w: number; h: number }; label?: string }[] = [];
      for (const c of wf.steps[i].callouts ?? []) {
        const box = resolvedCallouts.get(c.id);
        if (box) callouts.push({ box, label: c.label });
      }
      const blur: { x: number; y: number; w: number; h: number }[] = [];
      for (const b of wf.steps[i].blur ?? []) {
        const box = resolvedBlur.get(b.id);
        if (box) blur.push(box);
      }
      screenshotJobs.push({ stepNumber, frame: mStep.doc.image, highlights: mStep.doc.highlights, callouts, blur });
    }
  }

  const screenshots = await renderScreenshots(captureDir, manifest, screenshotJobs, screenshotsDir, opts);

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

  const chapters = chaptersOf(wf.steps);
  let lastChapter: string | undefined;
  for (let i = 0; i < wf.steps.length; i++) {
    const step = wf.steps[i];
    if (step.chapter && step.chapter !== lastChapter) {
      blocks.push(buildChapterBlock(step.chapter, chapters.indexOf(step.chapter)));
      lastChapter = step.chapter;
    }
    blocks.push(buildStepBlock(step, i + 1, statuses[i]));
  }

  const goodToKnow = buildGoodToKnowBlock(wf);
  if (goodToKnow) blocks.push(goodToKnow);
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
  };
}

async function renderScreenshots(
  captureDir: string,
  manifest: CaptureManifest,
  jobs: {
    stepNumber: number;
    frame: string;
    highlights: { x: number; y: number; w: number; h: number }[];
    callouts: { box: { x: number; y: number; w: number; h: number }; label?: string }[];
    blur: { x: number; y: number; w: number; h: number }[];
  }[],
  screenshotsDir: string,
  opts: BuildPageOptions,
): Promise<string[]> {
  // Remove screenshots from a previous build for steps that no longer exist/capture.
  await mkdir(screenshotsDir, { recursive: true });
  const wanted = new Set(jobs.map((j) => path.basename(screenshotFile(j.stepNumber))));
  for (const existingFile of await readdir(screenshotsDir).catch(() => [] as string[])) {
    if (!wanted.has(existingFile)) {
      await rm(path.join(screenshotsDir, existingFile), { force: true });
    }
  }
  if (jobs.length === 0) return [];

  const { chromium } = await import("playwright");
  const browser = await chromium.launch();
  const written: string[] = [];
  try {
    const page = await browser.newPage();
    for (const job of jobs) {
      const framePath = path.join(captureDir, "frames", job.frame);
      const outPath = path.join(screenshotsDir, path.basename(screenshotFile(job.stepNumber)));
      await annotateFrame(page, framePath, manifest.viewport, job.highlights, job.stepNumber, outPath, {
        width: opts.screenshotWidth,
        callouts: job.callouts,
        blur: job.blur,
      });
      written.push(outPath);
    }
  } finally {
    await browser.close();
  }
  return written;
}
