// `aida build`'s per-walkthrough, per-stage pipeline: capture -> voice -> render -> pages,
// then index, then qa (docs/scope.md "Pipeline"). See build-plan.md M6.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";
import type { ResolvedConfig } from "../config/index.js";
import { loadWalkthroughFile, newRunId } from "../walkthrough/index.js";
import type { Device, Walkthrough } from "../walkthrough/index.js";
import { captureDirFor, devicesFor, stepsFor } from "../devices/index.js";
import * as captureModule from "../capture/index.js";
import { capturePaths, comparePathRuns, readPathCaptures, markPathsNotCaptured, prunePathDirs, recordPathDiffs, runCapture, runLevelFailure, withFrameStabilization } from "../capture/index.js";
import { markNotCaptured, notCapturedReason } from "../capture/not-captured.js";
import { planSecondaryCapture, usableDeviceCapture } from "../capture/secondary.js";
import { AppDatabaseRefusedError, runCaptureSafetyChecks } from "../safety/index.js";
import { planRunFromFiles } from "../states/index.js";
import type { PlannedRun, PlannedWalkthrough } from "../states/index.js";
import type { CaptureManifest, FrameDiffSummary, ValidationResult } from "../capture/index.js";
import { resolveCaptureSettings } from "../config/types.js";
import { buildVoiceManifest } from "../commands/voice.js";
import { defaultConcurrency, loadNarrationBeats, render } from "../render/index.js";
import { pathClipFiles, pathClipLinks } from "../render/clips.js";
import { resolveArtifactBrand } from "../render/brand.js";
import type { RenderResult } from "../render/index.js";
import { buildPage } from "../pages/index.js";
import type { BuildPageResult } from "../pages/index.js";
import { runQa } from "../qa/index.js";
import {
  buildManualPdf,
  buildWalkthroughPdf,
  deletePdfOutput,
  launchBrowser,
  pdfInputFromPage,
  pdfPublicLinks,
  resolvePdfBrand,
  setPdfFrontmatter,
} from "../pdf/index.js";
import type { PdfBuildResult } from "../pdf/index.js";
import type { Browser } from "playwright";
import { resolveChatConfig } from "../chat/index.js";
import { briefForBuild, briefPath, loadBrief } from "../brief/consumers.js";
import { outlinePath, readOutline } from "../outline/file.js";
import { cpSync, rmSync } from "node:fs";
import { runIndexStage } from "./index-stage.js";
import { writeHelpAppTheme } from "../theme/index.js";
import type { IndexStageResult } from "./index-stage.js";
import { manifestHash, readHashCache, sha256, stableStringify, writeHashCache } from "./hash.js";
import { buildModelsSection } from "./report.js";
import { collectFailures, textCheckFailures } from "./failures.js";
import { checkWalkthroughText, type WalkthroughTextProblem } from "../qa/walkthrough-text.js";
import type { QaReport } from "../qa/index.js";
import { mapLimit } from "./pool.js";
import type { BuildOptions, BuildStageName, DeviceBuildResult, StageResult, WalkthroughBuildResult } from "./types.js";
import { ALL_STAGES } from "./types.js";
import { voiceCostUsd } from "../usage/prices.js";
import { resetDatabase } from "../capture/reset.js";
import { recordCaptureDrift } from "../outline/index.js";

function ok(detail?: string): StageResult {
  return { status: "ok", skipped: false, ms: 0, detail };
}
function skipped(detail: string, ms = 0): StageResult {
  return { status: "skipped", skipped: true, ms, detail };
}
function failed(detail: string, ms = 0): StageResult {
  return { status: "failed", skipped: false, ms, detail };
}
function notSelected(): StageResult {
  return { status: "not-selected", skipped: false, ms: 0 };
}
function timed(result: StageResult, ms: number): StageResult {
  return { ...result, ms };
}

function findWalkthroughFiles(dir: string, ids: string[]): string[] {
  const all = readdirSync(dir)
    .filter((f) => /\.(ya?ml)$/i.test(f))
    .map((f) => join(dir, f))
    .sort();
  if (ids.length === 0) return all;
  return ids.map((id) => {
    if (existsSync(id)) return id;
    const match = all.find((f) => f.endsWith(`/${id}.yaml`) || f.endsWith(`/${id}.yml`));
    if (!match) throw new Error(`no walkthrough found for "${id}" in ${dir}`);
    return match;
  });
}

/** Keys the reused sign-in session file by baseUrl + persona (mirrors commands/capture.ts). */
function storageStateKey(baseUrl: string, walkthrough: Walkthrough): string {
  const persona = walkthrough.start?.persona ?? null; // normalised at load: always an object
  const hash = createHash("sha256").update(JSON.stringify({ baseUrl, persona })).digest("hex").slice(0, 16);
  return hash;
}

function firstLine(message: string): string {
  return message.split("\n")[0] ?? message;
}

function readJson<T>(file: string): T {
  return JSON.parse(readFileSync(file, "utf8")) as T;
}
function readJsonIfExists<T>(file: string): T | undefined {
  return existsSync(file) ? readJson<T>(file) : undefined;
}

interface WalkthroughPipelineState {
  /** The walkthrough's YAML file, named in report.json. */
  file: string;
  wf: Walkthrough;
  /** The *primary* device's capture dir (decision 40) — unchanged `<buildDir>/<id>/capture` for
   * a desktop-primary walkthrough, so every stage that reads `state.captureDir` (pages, render,
   * pdf) keeps working exactly as before without knowing devices exist. */
  captureDir: string;
  /** Devices this walkthrough captures on this run, primary first (`devicesFor()`); `["desktop"]`
   * for a walkthrough that doesn't opt into phone capture. */
  devices: Device[];
  /** Capture outcome of every device *other than* the primary (whose outcome is `stages.capture`/
   * `manifest`/`validation`), keyed by device. Never affects `ok` — see `runCaptureStage`. */
  deviceResults: Partial<Record<Device, DeviceBuildResult>>;
  voiceDir: string;
  videoDir: string;
  pagesDir: string;
  stages: Partial<Record<BuildStageName, StageResult>>;
  manifest?: CaptureManifest;
  validation?: ValidationResult;
  frameDiff?: FrameDiffSummary;
  voiceReport?: { charsBilled: number; cached: number; synthesized: number; costUsd: number };
  renderResult?: RenderResult;
  /** A secondary phone device's own render (M43c) — set only when `devices` names phone as
   * something other than the primary and its capture passed. */
  phoneRenderResult?: RenderResult;
  pageResult?: BuildPageResult;
  pdfResult?: PdfBuildResult;
  qaProblems?: number;
  qaReports?: QaReport[];
  qaFile?: string;
  /** This run's `failure.json` (or, under `--skip-capture`, the reused capture's): report.json
   * never lists or reads an older one. */
  failureFile?: string;
  /** Not captured: a provider failed or no order works for it (decision 28). */
  blocked?: { appBugIn: string[] };
  /** `aida validate`'s text problems (caption and chapter-title line length; M26). Fail this
   * walkthrough's voice, render, pages, pdf and qa, but not its capture. */
  textProblems: WalkthroughTextProblem[];
}

function selectedStages(opts: BuildOptions): Set<BuildStageName> {
  return new Set(opts.only && opts.only.length > 0 ? opts.only : ALL_STAGES);
}

/** True when this run's own capture validation failed, or its voice stage failed — in either
 * case render/pages must not run, or they'd ship a stale video / build a page off a failed
 * capture (review finding pipeline.ts:306). Checked against the actual validation result (not
 * just the capture stage's status label) so a replayed `--skip-capture` of a previously-failed
 * capture is caught too. Also true when the capture stage itself failed with no validation this
 * run (it threw, or was skipped because a provider didn't leave its state): the capture dir then
 * still holds an older capture, possibly part-overwritten, and nothing may be rebuilt from it
 * (decision 11). Its last published page stays as it was; the index stage leaves it untouched. */
function captureOrVoiceFailed(state: WalkthroughPipelineState): boolean {
  if (state.validation && !state.validation.ok) return true;
  if (state.stages.capture?.status === "failed") return true;
  if (state.stages.voice?.status === "failed") return true;
  return false;
}

/** True when this state's page is actually fit to publish once every stage this run ran against
 * it is accounted for — not just the pages stage's own `publishable` flag (which predates QA).
 * QA runs *after* the pdf stage (see the pdf/qa ordering below), so a page that fails QA this run
 * must still end up excluded from the index stage and have any PDF already rendered for it this
 * run cleaned up (review finding index-stage.ts:152: "a page failing QA this run is filtered out
 * before staging, so its old content/docs/<id> ... stay live" — the same rule applies to PDFs). */
function finalPublishable(state: WalkthroughPipelineState): boolean {
  if (!state.pageResult?.publishable) return false;
  if (state.stages.pages?.status === "failed") return false;
  if (state.stages.qa?.status === "failed") return false;
  return true;
}

/** One device's capture outcome, returned rather than written straight onto `state` — so the
 * caller (`runCaptureStage`) can decide whether a device's outcome is this walkthrough's own
 * (the primary device: `stages.capture`) or a non-fatal side note (every other device). */
interface DeviceCaptureOutcome {
  stage: StageResult;
  manifest?: CaptureManifest;
  validation?: ValidationResult;
  frameDiff?: FrameDiffSummary;
  failureFile?: string;
  blocked?: { appBugIn: string[] };
  category?: import("../capture/types.js").FailureCategory;
}

/** True when the plan (decision 28) resets before this walkthrough's primary run — it moves a
 * chain member's reset to the start of its chain — and resets aren't off. */
function slotResetsBefore(
  wf: Walkthrough,
  config: ResolvedConfig,
  opts: BuildOptions,
  planned: { run: PlannedRun; item: PlannedWalkthrough<Walkthrough> } | undefined,
): boolean {
  if (opts.noReset) return false;
  return planned ? planned.item.resetBefore : Boolean(config.database && (wf.validate?.database?.length || wf.paths?.length));
}

/**
 * Captures one device into `captureDir` (decision 40, M43a). `includePaths` is true only for the
 * primary device: other walkthroughs' paths (decision 34) aren't captured a second time per
 * device — a later milestone can extend that; for now every device replays the same main steps.
 * `main` says whether to reset the database right before this device's main capture and which
 * run id it uses (`runCaptureStage` decides both: capture/secondary.ts). Records the capture-run
 * tracker (dependants/outline-drift) only for the primary, which is what the rest of this run
 * actually depends on.
 */
async function runCaptureForDevice(
  wf: Walkthrough,
  config: ResolvedConfig,
  captureDir: string,
  device: Device,
  opts: BuildOptions,
  planned: { run: PlannedRun; item: PlannedWalkthrough<Walkthrough> } | undefined,
  includePaths: boolean,
  main: { reset: boolean; runId: string | undefined },
): Promise<DeviceCaptureOutcome> {
  const started = Date.now();
  const manifestFile = join(captureDir, "manifest.json");
  const validationFile = join(captureDir, "validation.json");
  const failureFile = join(captureDir, "failure.json");

  if (opts.skipCapture) {
    const manifest = readJsonIfExists<CaptureManifest>(manifestFile);
    const validation = readJsonIfExists<ValidationResult>(validationFile);
    const priorFailureFile = existsSync(failureFile) ? failureFile : undefined;
    if (!manifest) {
      return { stage: failed(`--skip-capture given but no prior capture at ${manifestFile}`, Date.now() - started) };
    }
    if (validation && !validation.ok) {
      // The last capture didn't pass (or never happened: blocked, or it threw): nothing is rebuilt
      // from it.
      const reason = notCapturedReason(validation) ?? "it didn't pass";
      return {
        stage: failed(`--skip-capture: the last capture can't be reused (${reason}); capture it again`, Date.now() - started),
        manifest,
        validation,
        failureFile: priorFailureFile,
      };
    }
    return { stage: skipped("--skip-capture", Date.now() - started), manifest, validation, failureFile: priorFailureFile };
  }

  // A provider earlier in the run failed, or no order works for it: don't capture a screen built
  // on missing data, and don't leave an older capture looking current.
  const blocked = planned?.run.tracker.blocked(planned.item);
  if (blocked) {
    if (includePaths) planned!.run.tracker.record(wf.walkthrough, false, { appBugIn: blocked.appBugIn });
    markNotCaptured(captureDir, { walkthrough: wf.walkthrough, reason: blocked.reason });
    if (includePaths) markPathsNotCaptured(captureDir, wf, blocked.reason);
    return { stage: failed(blocked.reason, Date.now() - started), blocked: { appBugIn: blocked.appBugIn } };
  }

  mkdirSync(captureDir, { recursive: true });
  const baseUrl = wf.start?.baseUrl ?? config.app.baseUrl;
  const storageStatePath = join(config.buildDir, ".aida-session", `storageState-${storageStateKey(baseUrl, wf)}.json`);

  try {
    const needsDbReset = slotResetsBefore(wf, config, opts, planned);

    // Other ways in first (decision 34; capture/paths.ts), as `aida capture` runs them: reset →
    // path → … → reset → main, so dependants see the main run's data. Paths run once, for the
    // primary device only.
    let pathRun: Awaited<ReturnType<typeof capturePaths>> | undefined;
    if (includePaths) {
      if ((wf.paths ?? []).length === 0) prunePathDirs(captureDir, wf);
      else {
        pathRun = await capturePaths({
          walkthrough: wf,
          config,
          captureDir,
          storageStatePath,
          personaFor: planned?.run.personaFor,
          canReset: needsDbReset,
          cannotResetReason: opts.noReset ? "--no-reset was given" : (planned?.item.resetNote ?? "the capture plan doesn't reset before this walkthrough"),
          device,
        });
      }
    }

    if (main.reset && config.database) {
      await resetDatabase(config);
    }

    const captureSettings = resolveCaptureSettings(config.capture);
    const stabilizeOpts = { threshold: captureSettings.frameDiffThreshold, tolerance: captureSettings.frameDiffTolerance };
    const { result, frameDiff } = await withFrameStabilization(captureDir, stabilizeOpts, () =>
      runCapture({
        walkthrough: wf,
        config,
        outDir: captureDir,
        storageStatePath,
        runId: main.runId,
        personaFor: planned?.run.personaFor,
        device,
      }),
    );
    // Dependants wait on the main run only, which ran last — and only the primary device's run is
    // "the main run" other walkthroughs/outline drift care about.
    if (includePaths) planned?.run.tracker.record(wf.walkthrough, result.validation.ok, { category: result.failure?.category });
    // The runner rewrites or removes failure.json on every run, so whatever is there is this run's.
    const outFailureFile = existsSync(failureFile) ? failureFile : undefined;
    writeFileSync(manifestFile, `${JSON.stringify(result.manifest, null, 2)}\n`);
    writeFileSync(join(captureDir, "run.json"), `${JSON.stringify(result.run, null, 2)}\n`);
    writeFileSync(validationFile, `${JSON.stringify(result.validation, null, 2)}\n`);
    let pathNote = "";
    let pathManifests: CaptureManifest[] = [];
    if (pathRun) {
      const { pathDiffs, pathChecks } = comparePathRuns(result, pathRun);
      recordPathDiffs(captureDir, pathDiffs, pathChecks);
      pathManifests = Object.values(pathRun.manifests);
      const ran = pathRun.paths.filter((p) => p.skipped === undefined);
      const failedPaths = ran.filter((p) => !p.ok).map((p) => p.path);
      const skippedNote = pathRun.paths.find((p) => p.skipped !== undefined)?.skipped;
      pathNote = skippedNote
        ? `; paths not captured: ${skippedNote}`
        : `; paths ${ran.length - failedPaths.length}/${ran.length} passed${failedPaths.length > 0 ? ` (failed: ${failedPaths.join(", ")})` : ""}${pathDiffs.map((d) => `; warning: ${d.message}`).join("")}`;
    }
    // Outline drift (M29): quiet without an outline file; never fails the capture. Recorded from
    // the primary device's capture only — the card tracks one screen, not one per device.
    if (includePaths) {
      const outlineLine = recordCaptureDrift({ config, walkthrough: wf, manifest: result.manifest, validation: result.validation, pathManifests });
      if (outlineLine) console.warn(`aida build: ${outlineLine}`);
    }
    const passed = result.validation.steps.filter((s) => s.ok).length;
    const frameDiffDetail = `, ${frameDiff.kept} kept / ${frameDiff.changed} changed frames${(result.warnings ?? []).map((w) => `; warning: ${w}`).join("")}${pathNote}`;
    const stage = result.validation.ok
      ? ok(`${passed}/${result.validation.steps.length} steps passed${frameDiffDetail}`)
      : failed(`${passed}/${result.validation.steps.length} steps passed${frameDiffDetail}`);
    stage.ms = Date.now() - started;
    return { stage, manifest: result.manifest, validation: result.validation, frameDiff, failureFile: outFailureFile, category: result.failure?.category };
  } catch (err) {
    // Classified like `aida capture` does (decision 30), written as this run's failure.json, and
    // validation.json says it wasn't captured: `--skip-capture` never reuses the older capture.
    const failure = runLevelFailure(err);
    if (includePaths) planned?.run.tracker.record(wf.walkthrough, false, { category: failure.category });
    markNotCaptured(captureDir, { walkthrough: wf.walkthrough, reason: failure.error, failure, baseUrl });
    return { stage: failed(failure.error, Date.now() - started), failureFile, category: failure.category };
  }
}

/**
 * Captures every device this walkthrough is captured on (decision 40, M43a): every secondary
 * device first, then the primary — `state.devices[0]`, into `state.captureDir` — so the primary's
 * main run, which dependants and outline drift read, is the last to touch the data. Resets
 * bracket the secondaries the way they bracket paths (decision 34): reset → phone → reset →
 * primary; a walkthrough that changes data with no reset allowed here doesn't capture its
 * secondaries (capture/secondary.ts `planSecondaryCapture`). A secondary's outcome is never this
 * walkthrough's own: it's recorded in `state.deviceResults` and logged as a warning, never written
 * to `state.stages.capture`/`ok`. No device is captured once the walkthrough is blocked (no data
 * in this run to capture any device from).
 */
async function runCaptureStage(
  wf: Walkthrough,
  config: ResolvedConfig,
  state: WalkthroughPipelineState,
  opts: BuildOptions,
  planned?: { run: PlannedRun; item: PlannedWalkthrough<Walkthrough> },
): Promise<void> {
  const [primary, ...secondary] = state.devices;
  const resetBefore = slotResetsBefore(wf, config, opts, planned);
  const blocked = opts.skipCapture ? undefined : planned?.run.tracker.blocked(planned.item);
  let secondaryReset = false;
  for (const device of secondary) {
    const dir = captureDirFor(config.buildDir, wf.walkthrough, device);
    let outcome: DeviceCaptureOutcome;
    if (blocked) {
      markNotCaptured(dir, { walkthrough: wf.walkthrough, reason: blocked.reason });
      outcome = { stage: failed(blocked.reason) };
    } else if (opts.skipCapture) {
      outcome = await runCaptureForDevice(wf, config, dir, device, opts, planned, false, { reset: false, runId: undefined });
    } else {
      const plan = planSecondaryCapture(wf, config, {
        resetBefore,
        resetAllowed: !opts.noReset && Boolean(planned?.item.resetAllowed),
        cannotResetReason: opts.noReset ? "--no-reset was given" : planned?.item.resetNote,
      });
      if (!plan.capture) {
        markNotCaptured(dir, { walkthrough: wf.walkthrough, reason: plan.reason });
        outcome = { stage: failed(plan.reason) };
      } else {
        // Bracketed by resets, it starts from reset data and gets its own run id (as paths do), so
        // nothing it makes collides with the primary's; unbracketed (read-only), it shares the
        // run's id to find what providers made with it.
        secondaryReset = secondaryReset || plan.reset;
        outcome = await runCaptureForDevice(wf, config, dir, device, opts, planned, false, {
          reset: plan.reset,
          runId: plan.reset ? newRunId() : planned?.run.runId,
        });
      }
    }
    const isFailed = outcome.stage.status === "failed";
    state.deviceResults[device] = { ok: !isFailed, ...(isFailed ? { failure: outcome.stage.detail, category: outcome.category } : {}) };
    if (isFailed && !blocked) {
      console.warn(`aida build: ${wf.walkthrough}: ${device} capture failed (non-fatal — the ${primary} page still builds): ${outcome.stage.detail}`);
    }
  }

  const primaryOutcome = await runCaptureForDevice(wf, config, state.captureDir, primary, opts, planned, true, {
    reset: resetBefore || secondaryReset,
    runId: planned?.run.runId,
  });
  state.stages.capture = primaryOutcome.stage;
  if (primaryOutcome.manifest) state.manifest = primaryOutcome.manifest;
  if (primaryOutcome.validation) state.validation = primaryOutcome.validation;
  if (primaryOutcome.frameDiff) state.frameDiff = primaryOutcome.frameDiff;
  if (primaryOutcome.failureFile) state.failureFile = primaryOutcome.failureFile;
  if (primaryOutcome.blocked) state.blocked = primaryOutcome.blocked;
}

/** `wf.voice?.provider`, falling back to `config.voice?.provider`, falling back to kokoro —
 * mirrors `commands/voice.ts`'s own provider resolution so cost accounting matches what voice
 * actually billed against. */
function voiceProviderFor(wf: Walkthrough, config: ResolvedConfig): string {
  return wf.voice?.provider ?? config.voice?.provider ?? "kokoro";
}

async function runVoiceStage(wf: Walkthrough, config: ResolvedConfig, state: WalkthroughPipelineState): Promise<void> {
  const started = Date.now();
  try {
    const result = await buildVoiceManifest(wf, config, state.voiceDir);
    const costUsd = voiceCostUsd(voiceProviderFor(wf, config), result.report.summary.charsBilled, config.voice?.pricePerChar);
    state.voiceReport = { ...result.report.summary, costUsd };
    state.stages.voice = result.skipped
      ? skipped("all lines cached, nothing billed", Date.now() - started)
      : ok(`${result.report.summary.synthesized} synthesized, ${result.report.summary.cached} cached, $${costUsd.toFixed(4)}`);
    state.stages.voice.ms = Date.now() - started;
  } catch (err) {
    state.stages.voice = failed(firstLine((err as Error).message ?? String(err)), Date.now() - started);
  }
}

/** `wf`'s steps restricted to the ones `device` actually captured (`stepsFor`, decision 40) — a
 * step named only on another device isn't in this device's own capture manifest, so rendering
 * its video from the unfiltered walkthrough would throw "capture is missing step". A no-op for
 * every walkthrough that doesn't use per-step `devices:` (today's default: every step keeps). */
function walkthroughForDevice(wf: Walkthrough, device: Device): Walkthrough {
  return { ...wf, steps: stepsFor(wf, device) };
}

/** Each of `device`'s steps' whole-walkthrough number, and the whole walkthrough's step count —
 * so the video's chips and transcript number steps as the page, PDF and procedures do, even when
 * a device-only step is left out of this device's video. */
function stepNumberingFor(wf: Walkthrough, device: Device): { numbers: number[]; total: number } {
  return { numbers: stepsFor(wf, device).map((s) => wf.steps.indexOf(s) + 1), total: wf.steps.length };
}

/** True once the phone capture at `phoneCaptureDir` passed (`usableDeviceCapture`) — read
 * straight off disk (not `state.deviceResults`) so a render-only run (`--only render`, after an
 * earlier run's `--only capture`) still finds it, the same way `captureOrVoiceFailed`'s
 * primary-device check reads `state.validation` regardless of which stages this run selected. */
function phoneCaptureOk(phoneCaptureDir: string): boolean {
  return usableDeviceCapture(phoneCaptureDir) !== undefined;
}

/** Removes a walkthrough's phone render (`<id>.phone.*`, `timeline.phone.json`, `.compose.phone/`,
 * `segments/{draft,full}.phone/`) from `<videoDir>/<id>/` — when phone is no longer a secondary
 * device, its capture didn't pass or its render failed — so no stale phone video is staged. */
export function removePhoneRender(videoDir: string, id: string): void {
  const dir = join(videoDir, id);
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir)) {
    if (name.startsWith(`${id}.phone.`) || name === "timeline.phone.json" || name === ".compose.phone") {
      rmSync(join(dir, name), { recursive: true, force: true });
    }
  }
  for (const quality of ["draft", "full"]) rmSync(join(dir, "segments", `${quality}.phone`), { recursive: true, force: true });
}

/**
 * Renders a secondary phone device's own video (M43c, decision 40) next to the primary device's:
 * `<id>.phone.mp4` + `.phone.srt`/`.phone.vtt`/`.phone.chapters.vtt`/`.phone.transcript.md`.
 * Never fatal — a phone capture that didn't pass, or a render failure, is recorded on
 * `state.deviceResults.phone` (same non-fatal pattern as M43a's capture outcome) and logged, but
 * the primary device's page/video still ship. Path clips are primary-device only (decision 34's
 * paths are captured on it alone — `runCaptureForDevice`'s `includePaths`), so this never asks
 * for them.
 */
async function runPhoneRenderStage(
  wf: Walkthrough,
  config: ResolvedConfig,
  state: WalkthroughPipelineState,
  draft: boolean,
  concurrency: number | undefined,
  narration: Awaited<ReturnType<typeof loadNarrationBeats>>,
): Promise<void> {
  const phoneCaptureDir = captureDirFor(config.buildDir, wf.walkthrough, "phone");
  if (!phoneCaptureOk(phoneCaptureDir)) {
    if (!state.deviceResults.phone) {
      state.deviceResults.phone = { ok: false, failure: "phone capture hasn't passed — not rendering a video from it" };
    }
    removePhoneRender(state.videoDir, wf.walkthrough);
    return;
  }
  try {
    const result = await render(walkthroughForDevice(wf, "phone"), {
      outDir: state.videoDir,
      captureDir: phoneCaptureDir,
      narration,
      draft,
      brand: resolveArtifactBrand(config),
      concurrency,
      lang: config.lang,
      device: "phone",
      fileSuffix: ".phone",
      pathClips: false,
      stepNumbering: stepNumberingFor(wf, "phone"),
    });
    state.phoneRenderResult = result;
  } catch (err) {
    const message = firstLine((err as Error).message ?? String(err));
    removePhoneRender(state.videoDir, wf.walkthrough);
    state.deviceResults.phone = { ...(state.deviceResults.phone ?? { ok: true }), render: { ok: false, failure: message } };
    console.warn(`aida build: ${wf.walkthrough}: phone render failed (non-fatal — the ${state.devices[0]} video still builds): ${message}`);
  }
}

async function runRenderStage(
  wf: Walkthrough,
  config: ResolvedConfig,
  state: WalkthroughPipelineState,
  draft: boolean,
  concurrency?: number,
): Promise<void> {
  const started = Date.now();
  try {
    const narration = loadNarrationBeats(state.voiceDir);
    const primary = state.devices[0];
    const result = await render(walkthroughForDevice(wf, primary), {
      outDir: state.videoDir,
      captureDir: state.captureDir,
      narration,
      draft,
      brand: resolveArtifactBrand(config),
      concurrency,
      lang: config.lang,
      device: primary,
      stepNumbering: stepNumberingFor(wf, primary),
    });
    state.renderResult = result;
    const clips = result.clips?.filter((c) => c.mp4) ?? [];
    const clipNote = clips.length > 0 ? ` + ${clips.length} path clip${clips.length === 1 ? "" : "s"}` : "";
    // A secondary phone device's own video (decision 40, M43c) — never for a phone-primary
    // walkthrough (there `devices[0]` is already phone, handled above) and never fatal to this
    // walkthrough's own render stage. Otherwise any older phone render goes.
    if (state.devices.slice(1).includes("phone")) {
      await runPhoneRenderStage(wf, config, state, draft, concurrency, narration);
    } else {
      removePhoneRender(state.videoDir, wf.walkthrough);
    }
    const phoneNote = state.phoneRenderResult ? ` + phone ${state.phoneRenderResult.durationSec.toFixed(1)}s` : "";
    state.stages.render =
      result.skipped && clips.every((c) => c.skipped) && (!state.phoneRenderResult || state.phoneRenderResult.skipped)
        ? skipped(`unchanged (${result.durationSec.toFixed(1)}s${clipNote}${phoneNote})`, Date.now() - started)
        : ok(`${result.durationSec.toFixed(1)}s, ${result.frames} frames${clipNote}${phoneNote}`);
    state.stages.render.ms = Date.now() - started;
  } catch (err) {
    state.stages.render = failed(firstLine((err as Error).message ?? String(err)), Date.now() - started);
  }
}

/** Content hash for the pages stage's skip decision — capture manifest + the walkthrough's own text. */
/** `buildPage()` reads `step.doc` and `step.events` off each manifest step, and `step.impact.urls`
 * (which steps moved to another page — pages/focus.ts picks each print figure's frame from it),
 * but never `impact.requests` (CI-impact-map-only). Requests are dropped before hashing so the dev
 * server's own request-timing nondeterminism (chunk-loading order, HMR) never forces an
 * unnecessary page rebuild. */
function stripImpact(manifest: CaptureManifest): CaptureManifest {
  return { ...manifest, steps: manifest.steps.map((s) => ({ ...s, impact: { urls: s.impact?.urls ?? [], requests: [] } })) };
}

/** Bumped when what `buildPage()` writes changes shape, so pages cached by an older engine
 * rebuild (M32: print figures in `BuildPageResult.printFigures`, no recap "Good to know";
 * M43b: `<DeviceShots>`-wrapped steps and secondary-device screenshots, decision 40; then only a
 * passing secondary capture's shots, frontmatter `devices` from what was produced). */
export const PAGES_LAYOUT_VERSION = "m43b-device-shots-2";

/** Stable summary of a capture's validation result — ok + per-step ok only, so volatile fields
 * (`ranAt`, per-step `ms`, error text) never affect the hash, but a pass->fail (or fail->pass)
 * flip always does. */
function stableValidationSummary(validation: ValidationResult | undefined): unknown {
  if (!validation) return undefined;
  return {
    ok: validation.ok,
    steps: validation.steps.map((s) => ({ id: s.id, ok: s.ok })),
    ...(validation.pathDiffs ? { pathDiffs: validation.pathDiffs.map((d) => d.path) } : {}),
  };
}

/** Each secondary device's latest capture (decision 40, M43b), hashed the way the primary's is —
 * a phone capture's own manifest/validation changing (a recapture, a pass<->fail flip) must
 * invalidate the pages cache exactly as the primary's does, since `buildPage` reads them to
 * render that device's screenshots and the step's device-only note. */
function secondaryDevicesHash(devices: Device[], buildDir: string, id: string): unknown {
  const secondary = devices.slice(1);
  if (secondary.length === 0) return undefined;
  return secondary.map((device) => {
    const dir = captureDirFor(buildDir, id, device);
    const manifest = readJsonIfExists<CaptureManifest>(join(dir, "manifest.json"));
    const validation = readJsonIfExists<ValidationResult>(join(dir, "validation.json"));
    return {
      device,
      capture: manifest ? manifestHash(stripImpact(manifest), captureModule as unknown as Record<string, unknown>) : null,
      validation: stableValidationSummary(validation),
    };
  });
}

/** Each path's latest capture (decision 34), hashed the way the main capture is, for the pages
 * stage's skip decision: the "Other ways to do this" section is built from them. */
function pathCapturesHash(wf: Walkthrough, captureDir: string): unknown {
  if ((wf.paths ?? []).length === 0) return undefined;
  return readPathCaptures(captureDir, wf).map((p) => ({
    id: p.pathId,
    capture: p.manifest ? manifestHash(stripImpact(p.manifest), captureModule as unknown as Record<string, unknown>) : null,
    validation: stableValidationSummary(p.validation),
  }));
}

/** Exported for direct unit testing of the pages-stage skip decision (see pagesInputHash.test.ts). */
export function pagesInputHash(
  wf: Walkthrough,
  manifest: CaptureManifest,
  validation: ValidationResult | undefined,
  readers: string[] | undefined,
  videoPresent: boolean,
  roles?: ResolvedConfig["roles"],
  pathCaptures?: unknown,
  /** Each path's clip on disk and its "continue at" time (M35): the page embeds them. */
  clipLinks?: unknown,
  /** Every secondary device's manifest/validation (decision 40, M43b): `secondaryDevicesHash`. */
  secondaryDevices?: unknown,
): string {
  const captureHash = manifestHash(stripImpact(manifest), captureModule as unknown as Record<string, unknown>);
  const textFields = {
    title: wf.title,
    summary: wf.summary,
    for: wf.for,
    section: wf.section,
    intro: wf.intro,
    outro: wf.outro,
    start: wf.start,
    // Printed text fills in `{{data}}` (M35), so a data change is a text change.
    data: wf.data,
    // `blur`/`callouts` decide which frame a print figure may show (pages/focus.ts) and the
    // callout labels drawn, not just the resolved boxes the manifest already carries.
    // `devices` (M43b, decision 40): which device(s) a step runs on decides its device-only note
    // and whether it gets a `<DeviceShots>` wrapper.
    steps: wf.steps.map((s) => ({ id: s.id, title: s.title, say: s.say, caption: s.caption, page_text: s.page_text, chapter: s.chapter, blur: s.blur, callouts: s.callouts, devices: s.devices })),
    ...(wf.paths ? { paths: wf.paths } : {}),
  };
  const validationSummary = stableValidationSummary(validation);
  return sha256(
    stableStringify({
      captureHash,
      textFields,
      validationSummary,
      readers,
      videoPresent,
      layout: PAGES_LAYOUT_VERSION,
      ...(roles ? { roles } : {}),
      ...(pathCaptures !== undefined ? { pathCaptures } : {}),
      ...(clipLinks !== undefined && !(Array.isArray(clipLinks) && clipLinks.length === 0) ? { clipLinks } : {}),
      ...(secondaryDevices !== undefined ? { secondaryDevices } : {}),
    }),
  );
}

async function runPagesStage(wf: Walkthrough, config: ResolvedConfig, state: WalkthroughPipelineState): Promise<void> {
  const started = Date.now();
  if (!state.manifest) {
    state.stages.pages = failed("no capture manifest available — capture stage must run first", Date.now() - started);
    return;
  }
  const cacheFile = join(config.buildDir, wf.walkthrough, "pages-cache.json");
  const videoPresent = existsSync(join(state.videoDir, wf.walkthrough, `${wf.walkthrough}.mp4`));
  const inputHash = pagesInputHash(
    wf,
    state.manifest,
    state.validation,
    config.readers,
    videoPresent,
    config.roles,
    pathCapturesHash(wf, state.captureDir),
    pathClipLinks(state.videoDir, wf),
    secondaryDevicesHash(state.devices, config.buildDir, wf.walkthrough),
  );
  const cache = readJsonIfExists<{ hash: string; result: BuildPageResult }>(cacheFile);

  if (cache && cache.hash === inputHash && existsSync(cache.result.indexFile)) {
    state.pageResult = cache.result;
    state.stages.pages = skipped("unchanged since last build", Date.now() - started);
    return;
  }

  try {
    const secondaryCaptures = state.devices.slice(1).map((device) => ({ device, captureDir: captureDirFor(config.buildDir, wf.walkthrough, device) }));
    const result = await buildPage(wf, state.captureDir, state.pagesDir, {
      videoDir: state.videoDir,
      readers: config.readers,
      roles: config.roles,
      devices: state.devices,
      secondaryCaptures,
    });
    state.pageResult = result;
    mkdirSync(join(config.buildDir, wf.walkthrough), { recursive: true });
    writeFileSync(cacheFile, `${JSON.stringify({ hash: inputHash, result }, null, 2)}\n`);
    state.stages.pages = result.publishable
      ? ok(`publishable -> ${result.indexFile}`)
      : failed(`not publishable: ${result.problems.join("; ") || "unknown reason"}`);
    state.stages.pages.ms = Date.now() - started;
  } catch (err) {
    state.stages.pages = failed(firstLine((err as Error).message ?? String(err)), Date.now() - started);
  }
}

/** The page an earlier build left on disk (`pages-cache.json`), for a run that didn't select the
 * pages stage (`aida build --only pdf`). `publishable` folds in that walkthrough's last QA result
 * (`qa.json`), since the cached flag predates QA. Undefined when no page was built, its index
 * file is gone or the cache can't be read. */
function loadBuiltPage(config: ResolvedConfig, id: string): BuildPageResult | undefined {
  try {
    const cache = readJsonIfExists<{ result: BuildPageResult }>(join(config.buildDir, id, "pages-cache.json"));
    if (!cache || !existsSync(cache.result.indexFile)) return undefined;
    const qa = readJsonIfExists<{ ok: boolean }>(join(config.buildDir, id, "qa.json"));
    return { ...cache.result, publishable: cache.result.publishable && qa?.ok !== false };
  } catch {
    return undefined;
  }
}

/** Renders a walkthrough's `<id>.pdf`/`<id>.card.pdf` (docs/scope.md "Printable guides",
 * build-plan.md M12) from its just-built page, then links them into that page's frontmatter
 * (`pdf:`/`pdfCard:`) so the help app's print area can offer a "Download PDF" link. Skipped —
 * not failed — when the page itself isn't publishable; a non-publishable page's PDFs must never
 * ship (same rule as the index stage, pipeline.ts `captureOrVoiceFailed`/pages-failed guards).
 *
 * Runs after QA (see the pdf/qa ordering in `runPipeline`), so `finalPublishable(state)` already
 * reflects this run's QA result — passed as `publishable`, overriding the pages stage's own
 * (QA-blind) flag, so `buildWalkthroughPdf` excludes (and deletes any stale `<id>.pdf`/
 * `<id>.card.pdf` for) a page that failed QA this run, not just one that failed to build at all. */
async function runPdfStage(
  wf: Walkthrough,
  config: ResolvedConfig,
  state: WalkthroughPipelineState,
  pdfDir: string,
  browser: Browser,
  publishable: boolean,
): Promise<void> {
  const started = Date.now();
  if (!state.pageResult) {
    state.stages.pdf = skipped("no page built this run — pages stage did not run or failed", Date.now() - started);
    return;
  }
  try {
    const input = { ...pdfInputFromPage(wf, state.pageResult), publishable, lang: config.lang };
    const result = await buildWalkthroughPdf(input, { pdfDir, paper: config.pdf?.paper ?? "A4", brand: resolvePdfBrand(config), siteUrl: config.publish?.siteUrl, lang: config.lang }, browser);
    state.pdfResult = result;
    if (result.excluded) {
      state.stages.pdf = skipped("page not publishable — not rendering a PDF from it", Date.now() - started);
      return;
    }
    setPdfFrontmatter(state.pageResult.indexFile, pdfPublicLinks(wf.walkthrough));
    await runPdfA11yCheck(state, result);
    state.stages.pdf = result.skipped
      ? skipped("unchanged since last build", Date.now() - started)
      : ok(`${result.file}, ${result.cardFile}`);
    state.stages.pdf.ms = Date.now() - started;
  } catch (err) {
    state.stages.pdf = failed(firstLine((err as Error).message ?? String(err)), Date.now() - started);
  }
}

/**
 * The QA stage runs *before* the pdf stage (see `runPdfStage`'s doc comment), so `a11y:pdf`
 * (qa/a11y.ts, via `runQa`'s `pdf` check) can only run here, once `<id>.pdf`/`<id>.card.pdf`
 * actually exist. Appended to `state.qaReports`/`qa.json` and, on a problem, flips
 * `state.stages.qa` to failed too — the general QA stage already finished and reported "ok"
 * before this PDF even existed, so without this a failed check here would never reach
 * report.json's `failures` (build/failures.ts's `qaFailures` only reads a "failed" qa stage).
 *
 * On a failure, also deletes `<id>.pdf`/`<id>.card.pdf` themselves (review finding
 * build/pipeline.ts:717): `finalPublishable(state)` only reflects this failure from here on, but
 * `buildWalkthroughPdf` already wrote both files before this check ran (`runPdfStage`'s doc
 * comment), and `stagePdfsToHelpApp` copies whatever is on disk in `pdfDir` regardless of
 * publishable state — without this, an inaccessible PDF would still ship to `public/pdf` this
 * run even though its page is unpublished. */
async function runPdfA11yCheck(state: WalkthroughPipelineState, result: PdfBuildResult): Promise<void> {
  const files = [result.file, result.cardFile].filter((f) => existsSync(f));
  if (files.length === 0) return;
  const reports = await Promise.all(
    files.map((file) => runQa(file, { video: false, captions: false, personalData: false, secrets: false, placeholders: false, altText: false, transcript: false })),
  );
  const failedChecks = reports.flatMap((r) => r.checks.filter((c) => !c.ok));
  if (failedChecks.length === 0) return;
  deletePdfOutput(result.file);
  deletePdfOutput(result.cardFile);
  state.qaReports = [...(state.qaReports ?? []), ...reports];
  if (state.qaFile) writeFileSync(state.qaFile, `${JSON.stringify({ ok: false, reports: state.qaReports }, null, 2)}\n`);
  const prior = state.qaProblems ?? 0;
  state.qaProblems = prior + failedChecks.length;
  state.stages.qa = failed(`${prior + failedChecks.length} check(s) failed`, state.stages.qa?.ms ?? 0);
}

/** Copies every file under `pdfDir` into `<helpApp>/public/pdf/` (AGENTS.md principle 12: hosts
 * only run `next build`, so PDFs are generated here and committed/copied in, never built by the
 * host). Small and self-contained on purpose — see the index stage (index-stage.ts) for the
 * equivalent copy of page content, which this deliberately doesn't share code with. */
function stagePdfsToHelpApp(pdfDir: string, helpApp: string): void {
  if (!existsSync(pdfDir)) return;
  const dest = join(helpApp, "public", "pdf");
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dest, { recursive: true });
  cpSync(pdfDir, dest, { recursive: true, filter: (f) => !f.endsWith(".hash") });
}

/** Deliverables QA actually checks for a walkthrough — never render's own working files
 * (`timeline.json`, `.compose/`): they hold raw pixel/time coordinates, which the personal-data
 * scanner can misread as phone numbers, and they're never published anyway. */
function qaTargets(state: WalkthroughPipelineState): string[] {
  const pageDir = join(state.pagesDir, state.wf.walkthrough);
  const videoStepDir = join(state.videoDir, state.wf.walkthrough);
  const targets: string[] = [];
  if (existsSync(pageDir)) targets.push(pageDir);
  if (existsSync(videoStepDir)) {
    const id = state.wf.walkthrough;
    // The secondary phone video is checked on its own (`phoneQaTargets`): its failure drops the
    // phone media, never this page.
    for (const name of [`${id}.mp4`, `${id}.srt`, `${id}.vtt`, `${id}.chapters.vtt`]) {
      const file = join(videoStepDir, name);
      if (existsSync(file)) targets.push(file);
    }
    // Each path's clip (M35) passes the same gates: loudness, black frames, colour range, captions.
    for (const p of state.wf.paths ?? []) {
      const clip = pathClipFiles(videoStepDir, id, p.id);
      for (const file of [clip.mp4, clip.srt, clip.vtt]) if (existsSync(file)) targets.push(file);
    }
  }
  return targets;
}

/** A secondary phone video and its captions (M43c), when rendered. Same gates as the primary's,
 * portrait or not — qa/video.ts's checks never assume a fixed resolution/aspect unless a caller
 * passes `expectedWidth`/`expectedHeight` (this one doesn't). */
function phoneQaTargets(state: WalkthroughPipelineState): string[] {
  const id = state.wf.walkthrough;
  const dir = join(state.videoDir, id);
  return [`${id}.phone.mp4`, `${id}.phone.srt`, `${id}.phone.vtt`, `${id}.phone.chapters.vtt`].map((n) => join(dir, n)).filter((f) => existsSync(f));
}

/** QA of the secondary phone video, apart from the walkthrough's own (decision 40: a phone
 * failure never fails the desktop page). Recorded in `deviceResults.phone.qa`; on a failure the
 * phone render is removed, so the index stage stages none and the page keeps its desktop video. */
async function runPhoneQa(state: WalkthroughPipelineState): Promise<void> {
  const targets = phoneQaTargets(state);
  if (targets.length === 0) return;
  const id = state.wf.walkthrough;
  try {
    const reports: QaReport[] = [];
    for (const target of targets) reports.push(await runQa(target));
    const failedChecks = reports.flatMap((r) => r.checks.filter((c) => !c.ok));
    state.deviceResults.phone = { ...(state.deviceResults.phone ?? { ok: true }), qa: { ok: failedChecks.length === 0, problems: failedChecks.length } };
    if (failedChecks.length === 0) return;
    removePhoneRender(state.videoDir, id);
    const names = [...new Set(failedChecks.map((c) => c.check))].join(", ");
    console.warn(`aida build: ${id}: phone video failed QA (${names}) — not published; the ${state.devices[0]} page still builds`);
  } catch (err) {
    removePhoneRender(state.videoDir, id);
    state.deviceResults.phone = { ...(state.deviceResults.phone ?? { ok: true }), qa: { ok: false, problems: 1 } };
    console.warn(`aida build: ${id}: phone video QA failed to run — not published: ${firstLine((err as Error).message ?? String(err))}`);
  }
}

async function runQaStage(state: WalkthroughPipelineState, buildDir: string): Promise<void> {
  const started = Date.now();
  if (state.devices.slice(1).includes("phone")) await runPhoneQa(state);
  const targets = qaTargets(state);
  if (targets.length === 0) {
    state.stages.qa = failed("nothing to check — pages/render stages did not produce output", Date.now() - started);
    return;
  }
  try {
    let allOk = true;
    let problems = 0;
    const reports: QaReport[] = [];
    for (const target of targets) {
      const report = await runQa(target);
      reports.push(report);
      allOk = allOk && report.ok;
      problems += report.checks.filter((c) => !c.ok).length;
    }
    state.qaProblems = problems;
    // Every check, by name, for report.json's `failures` to point at (`<buildDir>/<id>/qa.json`).
    state.qaReports = reports;
    // `<buildDir>/<id>/qa.json` whichever device is primary: `loadBuiltPage` and failures.ts read it there.
    state.qaFile = join(buildDir, state.wf.walkthrough, "qa.json");
    mkdirSync(join(buildDir, state.wf.walkthrough), { recursive: true });
    writeFileSync(state.qaFile, `${JSON.stringify({ ok: allOk, reports }, null, 2)}\n`);
    state.stages.qa = allOk ? ok(`${targets.length} output(s) checked`) : failed(`${problems} check(s) failed`);
    state.stages.qa.ms = Date.now() - started;
  } catch (err) {
    state.stages.qa = failed(firstLine((err as Error).message ?? String(err)), Date.now() - started);
  }
}

export interface RunPipelineResult {
  walkthroughs: WalkthroughBuildResult[];
  index?: IndexStageResult & { ms: number };
  indexStage: StageResult;
  /** Set when the capture safety gate refused the run: nothing was captured or built. The
   * walkthrough results still carry this run's text problems. */
  refused?: AppDatabaseRefusedError;
  /** This run's start time (ISO) — pass to `assembleReport` so its models section only counts
   * usage-ledger entries from this run, not the build dir's whole history. */
  runStartedAt: string;
}

/** True once this run's spend (model-usage ledger entries recorded since `runStartedAt`, plus
 * voice cost already billed so far this run) has passed `config.budget.usd` — gates every paid
 * stage still to come (docs/scope.md "Caching and budgets": "stops at the per-run budget cap"). */
function runBudgetExceeded(config: ResolvedConfig, runStartedAt: string, voiceCostUsdSoFar: number): boolean {
  const budget = config.budget;
  if (!budget || budget.usd === undefined) return false;
  const models = buildModelsSection(config.buildDir, runStartedAt);
  return models.totalCostUsd + voiceCostUsdSoFar > budget.usd;
}

/**
 * The results for a run the capture safety gate refused: nothing ran, but each walkthrough's text
 * problems (checked first) are still reported.
 */
function refusedResults(files: string[], textProblems: Map<string, WalkthroughTextProblem[]>): WalkthroughBuildResult[] {
  return files.flatMap((file) => {
    let id: string;
    try {
      id = loadWalkthroughFile(file).walkthrough;
    } catch {
      return [];
    }
    const problems = textProblems.get(file) ?? [];
    const notRun = skipped("not run: capture was refused for the whole run");
    const qa = problems.length > 0 ? failed(`${problems.length} text problem(s) (captions, chapter titles, unresolved {{placeholders}}) (aida validate shows them too)`) : notRun;
    return [
      {
        walkthrough: id,
        ok: problems.length === 0,
        stages: { capture: notRun, voice: notRun, render: notRun, pages: notRun, pdf: notRun, qa },
        ...(problems.length > 0 ? { qa: { ok: false, problems: problems.length }, failures: textCheckFailures(problems, file) } : {}),
        file,
      },
    ];
  });
}

/** Runs the full build pipeline for every selected walkthrough, then the index stage once. */
export async function runPipeline(config: ResolvedConfig, opts: BuildOptions): Promise<RunPipelineResult> {
  const runStartedAt = new Date().toISOString();
  const files = findWalkthroughFiles(config.walkthroughsDir, opts.walkthroughIds);
  const stages = selectedStages(opts);
  const draft = Boolean(opts.draft);

  // Text QA first (caption and chapter-title line length, as `aida validate` checks them; M26),
  // before the safety gate and the plan, so a refused database or a plan problem never hides
  // them. Only when a stage that uses the text runs. A walkthrough with text problems is still
  // captured (others may need the data it leaves); its voice, render, pages, pdf and qa fail.
  const checksText = ["voice", "render", "pages", "qa"].some((s) => stages.has(s as BuildStageName));
  const textProblems = new Map<string, WalkthroughTextProblem[]>();
  const checkText = (file: string): void => {
    if (!checksText || textProblems.has(file)) return;
    try {
      textProblems.set(file, checkWalkthroughText(loadWalkthroughFile(file), readFileSync(file, "utf8")));
    } catch {
      // A file that doesn't load is reported when it's loaded below.
    }
  };
  for (const file of files) checkText(file);

  // Run-level safety gate (decisions #27): once, before the first capture opens a browser. A
  // refusal (AppDatabaseRefusedError, the app's database isn't on this machine) stops the run
  // here; commands/build.ts reports it and writes a failed report.json. Skipped when this run
  // captures nothing (`--skip-capture`, `--only` without capture).
  const capturing = stages.has("capture") && !opts.skipCapture;
  if (capturing) {
    try {
      await runCaptureSafetyChecks(config);
    } catch (err) {
      if (!(err instanceof AppDatabaseRefusedError)) throw err;
      return { walkthroughs: refusedResults(files, textProblems), indexStage: skipped("capture refused: nothing built"), runStartedAt, refused: err };
    }
  }

  // Capture order from the walkthroughs' needs/leaves/clears (decision 28), when this run
  // captures: providers first (pulled in with --with-deps), a reset only at a chain's start. A
  // walkthrough no order works for (a need nothing provides, a cycle) is blocked with the reason
  // and the rest still run; the build then fails, as `aida ci` does.
  const run = capturing ? planRunFromFiles(config, files, { withDeps: opts.withDeps, reset: opts.noReset ? "none" : "database-checks" }) : undefined;
  const runFiles = run ? run.plan.walkthroughs.map((p) => run.fileOf(p.id)) : files;
  for (const file of runFiles) checkText(file);

  // Which devices each walkthrough captures on (decision 40): its own `devices` wins, else
  // config's, else the brief's readers — loaded once, read-only, for every walkthrough this run.
  const readersBrief = loadBrief(briefPath(config));
  const states: WalkthroughPipelineState[] = runFiles.map((file) => {
    const wf = loadWalkthroughFile(file);
    const devices = devicesFor(wf, config, readersBrief);
    return {
      file,
      wf,
      // The *primary* device's dir — unchanged `<buildDir>/<id>/capture` when desktop is primary
      // (every desktop-only walkthrough, today's default), so pages/render/pdf keep reading "the"
      // capture exactly as before, even when the primary is phone (a phone-only walkthrough).
      captureDir: captureDirFor(config.buildDir, wf.walkthrough, devices[0]),
      devices,
      deviceResults: {},
      voiceDir: join(config.buildDir, wf.walkthrough, "voice"),
      videoDir: join(config.outDir, "videos"),
      pagesDir: join(config.outDir, "pages"),
      stages: {},
      textProblems: textProblems.get(file) ?? [],
    };
  });
  const textFailed = (state: WalkthroughPipelineState): boolean => state.textProblems.length > 0;
  const textSkip = (state: WalkthroughPipelineState): StageResult =>
    skipped(`${state.textProblems.length} text problem(s) (captions, chapter titles, unresolved {{placeholders}}): fix them first (aida validate shows them)`);

  // Capture + voice: sequential per walkthrough (capture shares app/db state across runs).
  // Voice is the one built-in paid stage (TTS chars billed) — checked against this run's own
  // spend before each walkthrough, so once the run budget trips, every voice stage still to come
  // is skipped rather than keeping on spending (review finding build/report.ts budget check).
  let voiceCostUsdSoFar = 0;
  for (const state of states) {
    const item = run?.plan.walkthroughs.find((p) => p.id === state.wf.walkthrough);
    if (stages.has("capture")) await runCaptureStage(state.wf, config, state, opts, run && item ? { run, item } : undefined);
    else {
      state.stages.capture = notSelected();
      // `--only pages,pdf,index` (etc) without "capture" means "reuse whatever's already
      // captured" just as much as `--skip-capture` does inside runCaptureStage — but that
      // function never runs when "capture" isn't a selected stage, so without this, every
      // downstream stage that needs `state.manifest`/`state.validation` (pages, render) would
      // see them unset even though a real capture sits on disk (bug: "no capture manifest
      // available" even with `--skip-capture`, because `--only` had already dropped capture
      // before `--skip-capture` got a chance to matter).
      state.manifest = readJsonIfExists<CaptureManifest>(join(state.captureDir, "manifest.json")) ?? state.manifest;
      state.validation = readJsonIfExists<ValidationResult>(join(state.captureDir, "validation.json")) ?? state.validation;
    }

    if (!stages.has("voice")) {
      state.stages.voice = notSelected();
      continue;
    }
    // No paid voice for a walkthrough whose capture failed, was blocked or was skipped this run:
    // render and pages won't use it.
    if (state.stages.capture?.status === "failed") {
      state.stages.voice = skipped("capture failed or was skipped this run — not paying for voice nothing will use");
      continue;
    }
    if (textFailed(state)) {
      state.stages.voice = textSkip(state);
      continue;
    }
    if (runBudgetExceeded(config, runStartedAt, voiceCostUsdSoFar)) {
      state.stages.voice = skipped("run budget exceeded — skipping remaining paid stages");
      continue;
    }
    await runVoiceStage(state.wf, config, state);
    voiceCostUsdSoFar += state.voiceReport?.costUsd ?? 0;
  }

  // Render: parallel, limited to 2 (build-plan.md M6/scope.md "Pipeline"). The render workers the
  // machine can take are shared between them, not given to each, so two at once can't run it out
  // of memory.
  if (stages.has("render")) {
    const parallel = Math.min(2, states.length);
    const workers = Math.max(1, Math.floor(defaultConcurrency() / parallel));
    await mapLimit(states, parallel, async (state) => {
      if (textFailed(state)) {
        state.stages.render = textSkip(state);
        return;
      }
      if (captureOrVoiceFailed(state)) {
        state.stages.render = skipped("capture or voice failed this run — not rendering a stale video");
        return;
      }
      await runRenderStage(state.wf, config, state, draft, workers);
    });
  } else {
    for (const state of states) state.stages.render = notSelected();
  }

  // Pages: sequential (cheap; wants render's video links already written).
  for (const state of states) {
    if (!stages.has("pages")) {
      state.stages.pages = notSelected();
      continue;
    }
    if (textFailed(state)) {
      state.stages.pages = textSkip(state);
      continue;
    }
    if (captureOrVoiceFailed(state)) {
      state.stages.pages = skipped("capture or voice failed this run — not building a page from a failed capture");
      continue;
    }
    await runPagesStage(state.wf, config, state);
  }

  // QA: per walkthrough, over whatever pages/render produced. Runs *before* the pdf stage (moved
  // ahead of it — pdf used to run first, which let a page that fails QA this run still get a
  // freshly-rendered/staged PDF before the failure was known; review finding index-stage.ts:152)
  // so `finalPublishable(state)` below already reflects this run's QA result.
  for (const state of states) {
    // Text problems are QA problems found early: the qa stage fails with them whatever ran.
    if (textFailed(state)) state.stages.qa = failed(`${state.textProblems.length} text problem(s) (captions, chapter titles, unresolved {{placeholders}}) (aida validate shows them too)`);
    else if (stages.has("qa")) await runQaStage(state, config.buildDir);
    else state.stages.qa = notSelected();
  }

  // PDF: sequential, one shared Chromium launch for every walkthrough this run touches
  // (build-plan.md M12). Runs after pages and QA (it reads each page's own output, and must
  // never ship/keep a PDF for a page QA just failed).
  const pdfDir = join(config.outDir, "pdf");
  if (stages.has("pdf")) {
    // Without the pages stage this run, render from the pages an earlier build left on disk.
    if (!stages.has("pages")) {
      for (const state of states) {
        if (textFailed(state) || captureOrVoiceFailed(state)) continue;
        state.pageResult = loadBuiltPage(config, state.wf.walkthrough);
      }
    }
    const toProcess = states.filter((s) => Boolean(s.pageResult));
    const noPageSkip = skipped(
      stages.has("pages") ? "capture, voice or pages failed this run — not rendering a PDF from it" : "no built page on disk — run the pages stage first",
    );
    if (toProcess.length > 0) {
      const browser = await launchBrowser();
      try {
        for (const state of states) {
          if (!toProcess.includes(state)) {
            state.stages.pdf = textFailed(state) ? textSkip(state) : noPageSkip;
            continue;
          }
          await runPdfStage(state.wf, config, state, pdfDir, browser, finalPublishable(state));
        }
        // manual.pdf covers every publishable page currently on disk (mirrors the index stage's
        // llms.txt/search-index behaviour, index-stage.ts), not just this run's selected walkthroughs.
        const allIds = findWalkthroughFiles(config.walkthroughsDir, []).map((f) => basename(f).replace(/\.(ya?ml)$/i, ""));
        const allInputs = allIds
          .map((id) => {
            const selected = states.find((s) => s.wf.walkthrough === id);
            if (selected?.pageResult) {
              return { ...pdfInputFromPage(selected.wf, selected.pageResult), publishable: finalPublishable(selected), lang: config.lang };
            }
            try {
              const cached = loadBuiltPage(config, id);
              if (!cached) return undefined;
              const file = findWalkthroughFiles(config.walkthroughsDir, [id])[0];
              return { ...pdfInputFromPage(loadWalkthroughFile(file), cached), lang: config.lang };
            } catch {
              return undefined;
            }
          })
          .filter((i): i is NonNullable<typeof i> => Boolean(i));
        await buildManualPdf(allInputs, { pdfDir, paper: config.pdf?.paper ?? "A4", brand: resolvePdfBrand(config), siteUrl: config.publish?.siteUrl, lang: config.lang }, browser);
      } finally {
        await browser.close();
      }
    } else {
      for (const state of states) state.stages.pdf = textFailed(state) ? textSkip(state) : noPageSkip;
    }
    if (config.helpApp) stagePdfsToHelpApp(pdfDir, config.helpApp);
  } else {
    for (const state of states) state.stages.pdf = notSelected();
  }

  // Help-app theme: keep the site's colours, logo and font in step with config.brand on every
  // build (app/brand.css, lib/brand.json, public/brand/). Unchanged files aren't rewritten, so a
  // running `next dev` doesn't reload for nothing. A missing logo file is a warning, not a failure.
  if (config.helpApp && stages.has("index")) {
    try {
      const theme = writeHelpAppTheme(config, config.helpApp);
      for (const warning of theme.warnings) console.warn(`aida build: theme: ${warning}`);
    } catch (err) {
      console.warn(`aida build: theme not written: ${(err as Error).message}`);
    }
  }

  // Index: once, over every walkthrough's page.
  let indexStage: StageResult;
  let indexResult: (ReturnType<typeof runIndexStage> & { ms: number }) | undefined;
  if (stages.has("index")) {
    const started = Date.now();
    // Pass every page this run actually built — not just the ones that stayed publishable — with
    // `publishable` corrected to this run's final verdict (`finalPublishable`, which folds in the
    // pages/QA stage results the pages-stage's own flag predates). The index stage's own
    // `stagePageContent`/`pruneUnpublishedScreenshots` then remove content/docs, screenshots and
    // the procedures.json entry for anything that isn't publishable, instead of this filtering a
    // just-failed page out before the index stage ever sees it and leaving its old published
    // output live (review finding index-stage.ts:152).
    const pages = states
      .filter((s) => s.pageResult)
      .map((s) => {
        const page = s.pageResult as BuildPageResult;
        return finalPublishable(s) ? page : { ...page, publishable: false };
      });
    // Every walkthrough id that currently exists on disk — not just the ones `files`/`states`
    // selected this run — so the index stage can prune a deleted walkthrough's content/docs
    // entry without touching any walkthrough this run didn't happen to build (review finding
    // index-stage.ts:20).
    const allWalkthroughFiles = findWalkthroughFiles(config.walkthroughsDir, []);
    const allWalkthroughIds = allWalkthroughFiles.map((f) => basename(f).replace(/\.(ya?ml)$/i, ""));
    // Every walkthrough on disk, loaded, so the index stage can place each page in the library by
    // its `section:` (and move a page this run didn't rebuild when its section changed). A file
    // that doesn't load is skipped here — its own build already reports why.
    const allWalkthroughs = allWalkthroughFiles.flatMap((f) => {
      const id = basename(f).replace(/\.(ya?ml)$/i, "");
      const selected = states.find((s) => s.wf.walkthrough === id)?.wf;
      if (selected) return [selected];
      try {
        return [loadWalkthroughFile(f)];
      } catch {
        return [];
      }
    });
    // The app brief goes to the help chat, the agent connector and the home page only once it
    // passes `aida brief check` with no personal data and no template prompts left.
    const brief = briefForBuild(briefPath(config));
    if (brief.skipped) console.warn(`aida build: app brief not published: ${brief.skipped}; fix it and run aida brief check`);
    try {
      const result = runIndexStage({
        pagesDir: join(config.outDir, "pages"),
        outDir: config.outDir,
        helpApp: config.helpApp,
        pages,
        walkthroughIds: allWalkthroughIds,
        videoDir: join(config.outDir, "videos"),
        // Every walkthrough this run attempted a page for, publishable or not — so the index
        // stage's merge/prune (procedures/build.ts `buildProcedures`) can tell "untouched this
        // run" (kept as-is) apart from "attempted but no longer publishable" (pruned), instead of
        // this pre-filtering making every QA-failed id look untouched (review finding
        // index-stage.ts:179/:152).
        procedureSources: states.filter((s) => s.pageResult).map((s) => ({ walkthrough: s.wf, captureDir: s.captureDir })),
        readerNames: { readers: config.readers, roles: config.roles },
        chatConfig: resolveChatConfig(config.chat, config.models),
        walkthroughs: allWalkthroughs,
        productName: config.brand?.name,
        appBrief: brief.artifacts,
        outlineOrder: outlineOrder(config),
        // Whether each walkthrough's phone video (M43c) is current: phone is a secondary device
        // and its capture passed. A failed phone render or QA already removed the files.
        phoneVideos: Object.fromEntries(
          allWalkthroughs.map((wf) => {
            const devices = states.find((s) => s.wf.walkthrough === wf.walkthrough)?.devices ?? devicesFor(wf, config, readersBrief);
            const current = devices.slice(1).includes("phone") && phoneCaptureOk(captureDirFor(config.buildDir, wf.walkthrough, "phone"));
            return [wf.walkthrough, current];
          }),
        ),
      });
      indexResult = { ...result, ms: Date.now() - started };
      indexStage = ok(`${result.pageCount} page(s) indexed -> ${result.searchIndexFile}`);
      indexStage.ms = Date.now() - started;
    } catch (err) {
      indexStage = failed(firstLine((err as Error).message ?? String(err)), Date.now() - started);
    }
  } else {
    indexStage = notSelected();
  }

  const walkthroughs: WalkthroughBuildResult[] = states.map((state) => {
    // Text problems are listed by check (textCheckFailures), not as one generic qa failure.
    const text = textFailed(state);
    const failures = [
      ...(collectFailures(text ? { ...state, stages: { ...state.stages, qa: undefined } } : state) ?? []),
      ...(text ? textCheckFailures(state.textProblems, state.file) : []),
    ];
    return {
      walkthrough: state.wf.walkthrough,
      ok: Object.values(state.stages).every((s) => s?.status !== "failed"),
      stages: state.stages,
      voice: state.voiceReport,
      render: state.renderResult ? { durationSec: state.renderResult.durationSec, wallTimeMs: state.renderResult.wallTimeMs } : undefined,
      ...(state.phoneRenderResult
        ? { phoneRender: { durationSec: state.phoneRenderResult.durationSec, wallTimeMs: state.phoneRenderResult.wallTimeMs } }
        : {}),
      qa: state.stages.qa ? { ok: state.stages.qa.status !== "failed", problems: text ? state.textProblems.length : (state.qaProblems ?? 0) } : undefined,
      file: state.file,
      // Devices (decision 40): quiet for a desktop-only walkthrough (today's default), so
      // report.json gains nothing new for anyone who hasn't opted into phone capture.
      ...(state.devices.length > 1 || state.devices[0] !== "desktop" ? { devices: state.devices } : {}),
      ...(Object.keys(state.deviceResults).length > 0 ? { deviceResults: state.deviceResults } : {}),
      ...(failures.length > 0 ? { failures } : {}),
    };
  });

  return { walkthroughs, index: indexResult, indexStage, runStartedAt };
}

/** Walkthrough ids in outline.yaml card order, for the help site's page order; none without an
 * outline (or with one that doesn't parse — the outline commands report that). */
function outlineOrder(config: Parameters<typeof outlinePath>[0]): string[] | undefined {
  try {
    return readOutline(outlinePath(config))?.outline.cards.map((c) => c.id);
  } catch {
    return undefined;
  }
}
