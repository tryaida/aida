/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
import { chromium } from "playwright";
import type { Browser, BrowserContext, ElementHandle, Locator, Page } from "playwright";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Action, Persona, Step, Target, Walkthrough } from "../walkthrough/index.js";
import { newRunId, personaRole, resolveTemplatesDeep, withRunValues } from "../walkthrough/index.js";
import { checkLeftStates, needsPreparation, prepareWalkthrough, preparationWrites, WalkthroughSetupError } from "../states/prepare.js";
import type { PrepareOptions, PrepareReport } from "../states/prepare.js";
import type { ResolvedConfig } from "../config/types.js";
import { resolveCaptureSettings } from "../config/types.js";
import { boxOf, center, locate } from "./locate.js";
import { paint, settle, smoothScrollTo } from "./settle.js";
import { applyMasks, clearMasks, type MaskOptions } from "./mask.js";
import { resetProfile, profileAsync } from "./profile.js";
import { HIDE_NEXT_PORTAL_SCRIPT, NAME_SHIM_SCRIPT } from "./init-scripts.js";
import { assertLocalDatabase, assertWritesAllowed } from "./write-guard.js";
import { buildFailureReport, recheckAfterReload, runLevelFailure } from "./failure-report.js";
import { redactErrorMessage, redactLine, stripQueryAndHash } from "./redact.js";
import { StepWatch, isSignInPath, type ActionProgress } from "./diagnose.js";
import { accessibleName, pageHeadings, seenField } from "./seen.js";
import { ImpactTracker } from "./impact.js";
import { gotoReady } from "./page-ready.js";
import { seenTargets } from "./target-names.js";
import type {
  Box,
  CaptureEvent,
  CaptureManifest,
  CheckResult,
  DatabaseCheckResult,
  FailureReport,
  ManifestStep,
  ProblemEntry,
  ResolvedBox,
  StepResult,
  ValidationResult,
} from "./types.js";

const IGNORED_CONSOLE = [/fonts\.googleapis\.com/];
const WRITE_ACTIONS = new Set(["click", "type", "select"]);

export interface CaptureOptions {
  walkthrough: Walkthrough;
  config: ResolvedConfig;
  /** `.build/<id>/capture` — frames and manifest/validation are written here. */
  outDir: string;
  /** When set, a storageState file reused/updated across walkthroughs in one run. */
  storageStatePath?: string;
  /** `{{run.id}}` for this run, shared by every walkthrough in it. Default: a new one. */
  runId?: string;
  /** Persona for a role named by `setup.as` or a config state's `as` (default `{ role }`). */
  personaFor?: (role: string) => Persona | undefined;
  log?: (...args: unknown[]) => void;
  /**
   * Stop once the step with this id has passed (`aida inspect --after`): no later step runs,
   * and the end-of-run database checks and left-state checks are skipped.
   */
  stopAfterStep?: string;
  /** Called with the live page once `stopAfterStep` passed, before the browser closes. */
  onStopped?: (page: Page) => Promise<void>;
  /** Default true. False: no frames, screenshots or failure.json; the actions still run for real. */
  record?: boolean;
  /** Caps every wait (default 20-60 s per action). For tests and quick probes. */
  maxWaitMs?: number;
  /** Blocks service workers in the browser context (`aida inspect`: their requests would get
   * past a page-level write block). */
  blockServiceWorkers?: boolean;
  /** Called with the browser context right after it is created, before any page or sign-in
   * (`aida inspect --after` installs its write gate here, so it routes every request and
   * WebSocket from the first one). */
  onContext?: (context: BrowserContext) => Promise<void>;
  /** Default true. False opens a visible browser window (`aida record`, where a person clicks
   * through the app in the page `onStopped` hands over). */
  headless?: boolean;
}

export interface CaptureRunResult {
  manifest: CaptureManifest;
  /** Wall-clock metadata about this run — kept out of `manifest` so it stays byte-identical across runs. */
  run: RunInfo;
  validation: ValidationResult;
  framesDir: string;
  failure?: FailureReport;
  /** What the unrecorded setup phase did (needs and `setup.steps`), when there was one. */
  setup?: PrepareReport;
  /** Non-fatal problems, e.g. a state this walkthrough should leave whose check says it isn't true. */
  warnings?: string[];
  /** True when the run stopped at `stopAfterStep`. */
  stopped?: boolean;
}

export interface RunInfo {
  capturedAt: string;
  durationMs: number;
}

const noop = (): void => {};

/** Resolves a step's `callouts`/`blur` entries to boxes for the capture manifest (M22):
 * `target`-pinned entries are located against the live page right now (so the box reflects
 * wherever the element actually rendered this run); a fixed `box` entry is passed through
 * unchanged. An entry whose target can't be found this run is simply dropped — pages/render
 * then skip it rather than drawing a stale/wrong box. */
async function resolveOverlayBoxes(
  page: Page,
  items: Array<{ id: string; target?: Target; box?: Box }> | undefined,
): Promise<ResolvedBox[]> {
  if (!items || items.length === 0) return [];
  const out: ResolvedBox[] = [];
  for (const item of items) {
    if (item.target) {
      const box = await boxOf(item.target, page).catch(() => null);
      if (box) out.push({ id: item.id, box });
    } else if (item.box) {
      out.push({ id: item.id, box: item.box });
    }
  }
  return out;
}

/** Runs one walkthrough end to end: sign in, replay every step, validate. */
export async function runCapture(opts: CaptureOptions): Promise<CaptureRunResult> {
  const { walkthrough: rawWt, config } = opts;
  const log = opts.log ?? noop;
  // M11 (docs/build-plan.md, "capture speed"): AIDA_PROFILE=1 per-phase timing. Reset here (not
  // at module load) so each capture run gets its own clean counters — see withFrameStabilization
  // in frame-diff.ts, which prints the combined report after this run's frame-diff phase too.
  resetProfile();
  const runStarted = Date.now();
  const capturedAt = new Date().toISOString();
  // `{{run.id}}` is the same for every walkthrough in one run, so a value one walkthrough's
  // setup creates can be found by the next.
  const runId = opts.runId ?? newRunId();
  const data = withRunValues(rawWt.data, { id: runId });
  const walkthrough: Walkthrough = {
    ...rawWt,
    steps: resolveTemplatesDeep(rawWt.steps, data),
    validate: rawWt.validate ? resolveTemplatesDeep(rawWt.validate, data) : rawWt.validate,
  };

  const baseUrl = walkthrough.start?.baseUrl ?? config.app.baseUrl;
  // A walkthrough's start.baseUrl may only *reiterate* the configured origin,
  // never redirect capture (and the signed-in-session POST that follows) to
  // another host.
  const configOrigin = new URL(config.app.baseUrl).origin;
  if (walkthrough.start?.baseUrl && new URL(walkthrough.start.baseUrl).origin !== configOrigin) {
    throw new Error(
      `walkthrough start.baseUrl ${walkthrough.start.baseUrl} does not match config.app.baseUrl origin ${configOrigin}`,
    );
  }
  const baseOrigin = new URL(baseUrl).origin;

  const viewport = walkthrough.start?.viewport ?? config.viewport ?? { width: 1440, height: 810 };
  const deviceScaleFactor = walkthrough.start?.deviceScaleFactor ?? config.deviceScaleFactor ?? 2;
  // A long value (a UUID, say) used to pay one screenshot per character — 6 steps took 255 s.
  const maxTypeMs = resolveCaptureSettings(config.capture).maxTypeMs;

  // Run the write-guard before anything touches the network: it must gate
  // sign-in (which POSTs a session ticket to `baseUrl`) too, not just the
  // click/type steps later.
  const hasWriteActions =
    walkthrough.steps.some((s) => s.actions.some((a) => WRITE_ACTIONS.has(a.do))) || preparationWrites(rawWt, config);
  if (hasWriteActions) assertWritesAllowed(baseUrl, config.allowWrites);

  const record = opts.record ?? true;
  if (opts.stopAfterStep && !walkthrough.steps.some((s) => s.id === opts.stopAfterStep)) {
    const ids = walkthrough.steps.map((s) => s.id).filter(Boolean);
    throw new Error(`no step "${opts.stopAfterStep}" in walkthrough ${walkthrough.walkthrough} (steps: ${ids.join(", ") || "none with an id"})`);
  }
  const waitCap = (ms: number): number => Math.min(ms, opts.maxWaitMs ?? ms);

  const framesDir = join(opts.outDir, "frames");
  if (record) mkdirSync(framesDir, { recursive: true });

  const browser: Browser = await chromium.launch({ headless: opts.headless ?? true });
  let context: BrowserContext;
  const reuseState = opts.storageStatePath && existsSync(opts.storageStatePath) ? opts.storageStatePath : undefined;
  try {
    const contextOptions = {
      viewport,
      deviceScaleFactor,
      locale: config.locale ?? "en-AU",
      timezoneId: config.timezone ?? "Australia/Perth",
      colorScheme: "light" as const,
      // Most real apps' CSS/JS honour this, which keeps captures still —
      // crisper frames, fewer flaky mid-animation screenshots.
      reducedMotion: config.reducedMotion ?? "reduce",
    };
    context = await browser.newContext({
      ...contextOptions,
      // Lets state hooks call the app's API with relative paths (`ctx.request.post("/api/...")`).
      // Nothing else depends on it: every page.goto here is absolute (`baseUrl + startPath`, and
      // a `goto` action is resolved against the current page URL first).
      baseURL: baseUrl,
      ...(opts.blockServiceWorkers ? { serviceWorkers: "block" as const } : {}),
      ...(reuseState ? { storageState: reuseState } : {}),
    });
    if (opts.onContext) await opts.onContext(context);
    // A plain source-text string, not a function — see init-scripts.ts for why: a function here
    // can pick up a transpiler-injected `__name(...)` call that doesn't exist in the page.
    await context.addInitScript(NAME_SHIM_SCRIPT);
    await context.addInitScript(HIDE_NEXT_PORTAL_SCRIPT);

    const problems = { console: [] as ProblemEntry[], page: [] as ProblemEntry[], server: [] as ProblemEntry[] };
    // Set during the diagnosis-only reload after a failure: what that reload does is not the run's.
    let diagnosing = false;
    const page = await context.newPage();
    page.setDefaultTimeout(waitCap(30_000));
    if (config.clock) {
      await page.clock.install({ time: new Date(config.clock) });
    }
    page.on("console", (m) => {
      if (diagnosing || m.type() !== "error") return;
      const text = m.text();
      if (!IGNORED_CONSOLE.some((re) => re.test(text))) problems.console.push({ url: stripQueryAndHash(page.url()), text: redactLine(text, 500) });
    });
    page.on("pageerror", (e) => {
      if (!diagnosing) problems.page.push({ url: stripQueryAndHash(page.url()), text: redactLine(String(e), 500) });
    });
    page.on("response", (r) => {
      if (!diagnosing && r.status() >= 500) problems.server.push({ url: stripQueryAndHash(r.url()), status: r.status() });
    });

    const doSignIn = async (): Promise<void> => {
      if (!config.signIn) return;
      log("signing in");
      try {
        await config.signIn({
          page,
          context,
          baseUrl,
          persona: walkthrough.start?.persona,
          env: process.env,
        });
      } catch (err) {
        // Tagged so the run-level failure report says "environment: signing in failed" (M28).
        if (err && typeof err === "object") (err as { aidaPhase?: string }).aidaPhase = "sign-in";
        throw err;
      }
      if (opts.storageStatePath) {
        mkdirSync(dirname(opts.storageStatePath), { recursive: true });
        await context.storageState({ path: opts.storageStatePath });
      }
    };

    if (!reuseState && config.signIn) {
      await doSignIn();
    }

    // Page-level default masking (config `mask.personalData`, default true): every screenshot
    // gets a personal-data scan before it's taken, not only the fields a step names in its own
    // `mask` list — see mask.ts applyPersonalDataMask. `config.mask.selectors` are extra elements
    // always blurred regardless of scanning.
    const maskOptions: MaskOptions = {
      personalData: config.mask?.personalData,
      selectors: config.mask?.selectors,
    };

    let frameNo = 0;
    const shot = async (kind: string, mask?: string[]): Promise<string> => {
      if (!record) return "";
      const file = `${String(++frameNo).padStart(4, "0")}-${kind}.png`;
      await applyMasks(page, mask, maskOptions);
      await profileAsync("screenshot", () =>
        page.screenshot({ path: join(framesDir, file), animations: "disabled", caret: "hide", scale: "device" }),
      );
      await clearMasks(page);
      return file;
    };

    const impact = new ImpactTracker(page, baseUrl);
    // What changed during each step, for the failure report (M28; capture/diagnose.ts).
    const watch = new StepWatch(page, baseUrl, {
      signedInAs: personaRole(walkthrough.start),
      apiOrigins: resolveCaptureSettings(config.capture).apiOrigins,
    });

    const manifest: CaptureManifest = {
      workflow: walkthrough.walkthrough,
      baseUrl,
      viewport,
      deviceScaleFactor,
      steps: [],
    };
    const results: StepResult[] = [];
    let failure: FailureReport | undefined;

    const startPath = walkthrough.start?.page ?? "/";
    log("opening", startPath);
    await gotoReady(page, baseUrl + startPath, 120_000);
    await settle(page);

    // A reused session can go stale (cookie expiry, server restart since the
    // session file was written). Detect the bounce to sign-in and recover
    // once rather than failing the whole walkthrough.
    if (reuseState && config.signIn && isSignInPath(page.url())) {
      log("stored session looks stale — signing in again");
      await doSignIn();
      await gotoReady(page, baseUrl + startPath, 120_000);
      await settle(page);
    }

    // Setup phase (decision 28), unrecorded: make the data this walkthrough needs true, run its
    // `setup.steps`, then reload the start page so step 1 sees the result. Runs after the
    // session check above, so a setup page in this context is signed in.
    const prepareOpts: PrepareOptions = {
      walkthrough: rawWt,
      config,
      browser,
      context,
      baseUrl,
      runId,
      personaFor: opts.personaFor,
      sessionDir: opts.storageStatePath ? dirname(opts.storageStatePath) : undefined,
      contextOptions,
      log,
    };
    let setupReport: PrepareReport | undefined;
    if (needsPreparation(rawWt, config)) {
      try {
        setupReport = await prepareWalkthrough(prepareOpts);
      } catch (err) {
        if (!(err instanceof WalkthroughSetupError)) throw err;
        log("  SETUP FAILED:", redactErrorMessage(err.message));
        return setupFailureResult(walkthrough, baseUrl, viewport, deviceScaleFactor, capturedAt, runStarted, framesDir, record ? opts.outDir : undefined, page.url(), err);
      }
      await page.bringToFront();
      await gotoReady(page, baseUrl + startPath, 120_000);
      await settle(page);
    }

    // Preflight the database check, before any step runs: fail fast, and
    // never let a replay (especially its write steps) proceed under the
    // impression checks will run against an unverified database. The URL is
    // cached here and reused for both the query pass below and the
    // (redacted) validation.database field — never re-fetched.
    // A run that stops early (`stopAfterStep`) never reaches the end state these checks assert.
    const needsDb = !opts.stopAfterStep && Boolean(walkthrough.validate?.database?.length);
    let dbUrl: string | undefined;
    if (needsDb && config.database) {
      dbUrl = await config.database.url();
      assertLocalDatabase(dbUrl);
    } else if (needsDb) {
      log("walkthrough has validate.database checks but no config.database adapter is configured — skipping");
    }

    impact.take();
    // Sign-in and setup traffic isn't any step's; from here on, a different path before the
    // first click means the app redirected away from the start page.
    watch.reset();
    watch.navigated(startPath);
    const firstFrame = await shot("state", walkthrough.steps[0]?.mask);
    let stopped = false;
    let failureTarget: Target | undefined;

    for (const [si, step] of walkthrough.steps.entries()) {
      const events: CaptureEvent[] & { cameraBox?: ManifestStep["cameraBox"] } = [];
      if (si === 0) events.push({ type: "frame", image: firstFrame, transition: "cut" });
      const stepResult: StepResult = { id: step.id, title: step.title, checks: [], ok: true, ms: 0 };
      const started = Date.now();
      log(`step ${si + 1}/${walkthrough.steps.length}: ${step.id ?? step.title ?? si}`);
      let snapshotForDoc: string | null = null;
      let failedAction: Action | undefined;
      let calloutBoxes: ResolvedBox[] = [];
      let blurBoxes: ResolvedBox[] = [];
      let docHighlights: Box[] = [];
      const highlightState: HighlightState = { target: null };
      const progress: ActionProgress = {};
      const seen: (string | undefined)[] = [];
      watch.start();

      try {
        const acts = step.actions;
        for (let ai = 0; ai < acts.length; ai++) {
          const a = acts[ai];
          failedAction = a;
          progress.current = { index: ai + 1, do: a.do, ...("target" in a ? { target: a.target } : {}) };
          ai = await runAction({
            page,
            step,
            a,
            acts,
            ai,
            events,
            shot,
            stepResult,
            baseOrigin,
            maxTypeMs,
            highlightState,
            watch,
            progress,
            waitCap,
            seen,
          });
          progress.lastOk = { index: ai + 1, do: acts[ai].do };
        }
        progress.current = undefined;
        // Resolve callout/blur target boxes against the page in the state it's in right after
        // this step's actions ran — the same moment the step's doc screenshot is taken from, so
        // a pinned box matches what that screenshot (and the video frame built from it) shows.
        calloutBoxes = await resolveOverlayBoxes(page, step.callouts);
        blurBoxes = await resolveOverlayBoxes(page, step.blur);
        // A highlight box is only meaningful on the doc screenshot if it describes where its
        // element sits *right now* — a box captured at click time (before a navigating click, say)
        // can land over unrelated content once the page has moved on. Re-resolve whatever
        // highlight is still "on" (see HighlightState) against the current page rather than
        // reusing whatever box an earlier action captured; if the target is gone or hidden, drop
        // it from the doc screenshot (it's still shown correctly, at the right moment, in the
        // video via the per-action highlight/clearHighlight events above).
        if (highlightState.target) {
          const box = await boxOf(highlightState.target, page).catch(() => null);
          if (box) {
            docHighlights = [box];
          } else {
            log(
              `  step ${step.id ?? step.title ?? si}: highlight target no longer visible after this step's actions — dropping it from the doc screenshot`,
            );
          }
        }
        if (step.camera && step.camera !== "full" && step.camera.focus) {
          const b = await boxOf(step.camera.focus, page).catch(() => null);
          if (b) {
            const x = Math.max(0, b.x);
            const y = Math.max(0, b.y);
            const r = Math.min(viewport.width, b.x + b.w);
            const btm = Math.min(viewport.height, b.y + b.h);
            events.cameraBox = { x, y, w: Math.max(1, r - x), h: Math.max(1, btm - y) };
          }
        }
        snapshotForDoc = [...events].reverse().find((e) => e.type === "frame")?.image ?? null;
      } catch (err) {
        stepResult.ok = false;
        // Redacted and capped: a Playwright message carries the call log and `Received` values.
        stepResult.error = redactErrorMessage((err as Error).message ?? String(err));
        const fail = record ? await shot("failure", step.mask).catch(() => null) : null;
        stepResult.failureFrame = fail;
        // `progress.current` names the action that was really running: a wait a click consumed
        // (runAction's click case) rather than the click itself.
        failureTarget = progress.current?.target ?? (failedAction && "target" in failedAction ? failedAction.target : undefined);
        failure = await buildFailureReport(
          page,
          step.id ?? step.title,
          progress.current?.do ?? failedAction?.do ?? "unknown",
          err as Error,
          fail ? join(framesDir, fail) : null,
          failureTarget,
          { watch, progress },
        );
        log("  FAILED:", stepResult.error);
      }

      stepResult.ms = Date.now() - started;
      seen.push(...(await pageHeadings(page)));
      results.push(stepResult);
      manifest.steps.push({
        id: step.id,
        camera: step.camera ?? "full",
        cameraBox: events.cameraBox ?? null,
        events: events.filter(Boolean),
        doc: { image: snapshotForDoc, highlights: docHighlights, callouts: calloutBoxes, blur: blurBoxes },
        impact: impact.take(),
        checks: stepResult.checks,
        ...seenTargets(rawWt.steps[si]?.actions),
        ...seenField(seen, runId),
      });
      if (!stepResult.ok) break;
      if (opts.stopAfterStep && step.id === opts.stopAfterStep) {
        stopped = true;
        break;
      }
    }

    manifest.finalUrl = page.url();
    // Before the end checks read the database: the last save's request has answered (capped).
    if (needsDb && config.database && dbUrl) await watch.writesSettled(waitCap(15_000));
    // Every server action's response headers read, so its read/save flag is in the manifest.
    await impact.settled(waitCap(5_000));
    impact.dispose();
    if (stopped && opts.onStopped) {
      // `networkidle` returns at once on a page that already loaded, so a save's follow-up
      // request may not have gone yet: wait for the writes to finish (capped) before handing the
      // page over (`inspect --after` blocks every write from then on, and scans what's shown).
      await watch.writesSettled(waitCap(15_000));
      await settle(page);
    }
    watch.dispose();
    // Diagnosis only, after the failure was recorded (frames, snapshot, manifest step, finalUrl):
    // a save that worked followed by a missed wait gets one reload to tell a stale screen apart.
    if (failure && failureTarget) {
      diagnosing = true;
      failure = await recheckAfterReload(page, failure, failureTarget, waitCap(10_000));
      diagnosing = false;
    }
    if (stopped && opts.onStopped) await opts.onStopped(page);

    const dbChecks: DatabaseCheckResult[] = [];
    if (needsDb && config.database && dbUrl) {
      try {
        for (const check of walkthrough.validate!.database!) {
          try {
            const rows = await config.database.query(check.sql, check.params ?? [], { url: dbUrl });
            const row = rows[0] ?? {};
            const mismatches = Object.entries(check.expect).filter(([k, v]) => !valuesEqual(row[k], v));
            dbChecks.push({ name: check.name, ok: rows.length > 0 && mismatches.length === 0, row, expect: check.expect });
          } catch (e) {
            dbChecks.push({ name: check.name, ok: false, error: redactErrorMessage((e as Error).message ?? String(e)) });
          }
        }
      } finally {
        await config.database.close?.();
      }
    }

    const allStepsOk = results.length === walkthrough.steps.length && results.every((r) => r.ok);
    // Only a capture that worked is expected to have left its states.
    const warnings = allStepsOk && !opts.stopAfterStep && dbChecks.every((c) => c.ok) ? await checkLeftStates(prepareOpts) : [];
    for (const w of warnings) log("  warning:", w);
    const validation: ValidationResult = {
      workflow: walkthrough.walkthrough,
      ranAt: capturedAt,
      baseUrl,
      database: dbUrl ? redactDbUrl(dbUrl) : undefined,
      ok: allStepsOk && dbChecks.every((c) => c.ok) && problems.page.length === 0 && problems.server.length === 0,
      steps: results,
      dbChecks,
      problems,
    };

    // Persist the trimmed failure report into the capture dir itself (not just the in-memory
    // result) so an agent — or the build pipeline, which calls `runCapture` directly without
    // going through `aida capture` — can read it straight off disk. Cleared on a passing run
    // so a stale failure.json from a previous broken capture never lingers after a fix lands.
    const failureJsonPath = join(opts.outDir, "failure.json");
    if (!record) {
      // `inspect --after`: nothing on disk, failure included.
    } else if (failure) {
      writeFileSync(failureJsonPath, `${JSON.stringify(failure, null, 2)}\n`);
    } else if (existsSync(failureJsonPath)) {
      rmSync(failureJsonPath, { force: true });
    }

    return {
      manifest,
      run: { capturedAt, durationMs: Date.now() - runStarted },
      validation,
      framesDir,
      failure,
      ...(setupReport ? { setup: setupReport } : {}),
      ...(warnings.length > 0 ? { warnings } : {}),
      ...(stopped ? { stopped } : {}),
    };
  } finally {
    await browser.close();
  }
}

/** The result for a capture whose setup phase failed: no steps ran, nothing was recorded. */
function setupFailureResult(
  walkthrough: Walkthrough,
  baseUrl: string,
  viewport: { width: number; height: number },
  deviceScaleFactor: number,
  capturedAt: string,
  runStarted: number,
  framesDir: string,
  /** Unset when the run records nothing (`record: false`). */
  outDir: string | undefined,
  url: string,
  err: WalkthroughSetupError,
): CaptureRunResult {
  const failure: FailureReport = runLevelFailure(err, {
    phase: "setup",
    step: err.step ? `setup: ${err.step}` : err.state ? `needs ${err.state}` : "setup",
    action: "setup",
    url: err.url ?? url,
  });
  if (outDir) writeFileSync(join(outDir, "failure.json"), `${JSON.stringify(failure, null, 2)}\n`);
  return {
    manifest: { workflow: walkthrough.walkthrough, baseUrl, viewport, deviceScaleFactor, steps: [] },
    run: { capturedAt, durationMs: Date.now() - runStarted },
    validation: {
      workflow: walkthrough.walkthrough,
      ranAt: capturedAt,
      baseUrl,
      ok: false,
      steps: [],
      dbChecks: [],
      problems: { console: [], page: [], server: [] },
    },
    framesDir,
    failure,
  };
}

/** Compares two values loosely-but-safely: normalises both sides to a comparable string/JSON form. */
function valuesEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || a === undefined || b === null || b === undefined) return false;
  if (typeof a === "object" || typeof b === "object") {
    try {
      return JSON.stringify(a) === JSON.stringify(b);
    } catch {
      // fall through to string comparison
    }
  }
  return String(a) === String(b);
}

/** Redacts credentials *and* query-string params (which can themselves carry passwords/host overrides). */
function redactDbUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.hostname}${u.port ? `:${u.port}` : ""}${u.pathname}`;
  } catch {
    return url.replace(/\/\/[^@]*@/, "//").split("?")[0];
  }
}

interface RunActionArgs {
  page: Page;
  step: Step;
  a: Action;
  acts: Action[];
  ai: number;
  events: CaptureEvent[];
  shot: (kind: string, mask?: string[]) => Promise<string>;
  stepResult: StepResult;
  /** The walkthrough's origin — writes and navigation must stay inside it. */
  baseOrigin: string;
  /** Config `capture.maxTypeMs` (default 1500) — see the `type` case below. */
  maxTypeMs: number;
  /** Shared across every action in this step — updated whenever a `highlight`/`clearHighlight`
   * event is pushed so the step loop can re-resolve whatever's still "on" once actions finish. */
  highlightState: HighlightState;
  /** Told right before a click/select lands, so a failure can say whether the screen changed. */
  watch: StepWatch;
  /** Updated as a click consumes its waits, so a failure names the wait, not the click. */
  progress: ActionProgress;
  /** Caps a wait's timeout (`CaptureOptions.maxWaitMs`); identity by default. */
  waitCap: (ms: number) => number;
  /** Accessible names of the elements this step's actions resolved (`ManifestStep.seen`). */
  seen: (string | undefined)[];
}

/** True when `target`'s `label` is one of `step.mask`'s field names. */
function isMaskedTarget(target: Target, mask: string[] | undefined): boolean {
  return Boolean(target.label && mask?.includes(target.label));
}

/**
 * Finds the listbox a custom combobox trigger owns, so the option click below is scoped to it
 * instead of searching the whole page (bug: page-wide `getByText(option)` can hit a decoy
 * elsewhere on the page — the trigger's own label, a table cell, anything with matching text —
 * before it ever reaches the real option). Prefers the explicit ARIA relationship
 * (`aria-controls`/`aria-owns`); only falls back to "the one visible listbox on the page" when
 * the trigger doesn't declare one.
 */
export async function resolveComboboxListbox(trigger: Locator, page: Page): Promise<Locator> {
  const controls = await trigger.getAttribute("aria-controls").catch(() => null);
  const owns = await trigger.getAttribute("aria-owns").catch(() => null);
  const refId = (controls ?? owns)?.split(/\s+/)[0];
  if (refId) {
    const byId = page.locator(`[id="${refId.replace(/"/g, '\\"')}"]`);
    if ((await byId.count().catch(() => 0)) > 0) return byId.first();
  }
  return page.getByRole("listbox").filter({ visible: true }).first();
}

/**
 * True once the trigger's own value/text reflects the option just clicked — not just "a click
 * landed somewhere". Takes an `ElementHandle` captured *before* the option click, not a fresh
 * `page.getByRole(..., { name })` re-lookup: a role+name locator re-resolves against the live DOM
 * on every call, and the whole point of a working select is that the trigger's accessible name
 * changes to the new option — so re-resolving by the *old* name would now (correctly) match
 * nothing and make a successful selection look like a verification failure.
 */
export async function comboboxShowsOption(trigger: ElementHandle<Element>, option: string): Promise<boolean> {
  return trigger
    .evaluate((el, opt) => {
      const value = (el as HTMLInputElement).value ?? "";
      const text = el.textContent ?? "";
      return value.includes(opt) || text.includes(opt);
    }, option)
    .catch(() => false);
}

/** Executes one action, mutating `events`/`stepResult`. Returns the action index to resume from. */
async function runAction({
  page,
  step,
  a,
  acts,
  ai,
  events,
  shot,
  stepResult,
  baseOrigin,
  maxTypeMs,
  highlightState,
  watch,
  progress,
  waitCap,
  seen,
}: RunActionArgs): Promise<number> {
  const viewportWidth = page.viewportSize()?.width ?? 1440;

  // Writes must never land on a page that has drifted off-origin (an
  // off-origin redirect somewhere upstream of this action, including one a
  // prior `goto` let through before this check existed).
  if (WRITE_ACTIONS.has(a.do)) {
    const currentOrigin = new URL(page.url()).origin;
    if (currentOrigin !== baseOrigin) {
      throw new Error(`refusing to ${a.do} on off-origin page ${page.url()} (walkthrough origin is ${baseOrigin})`);
    }
  }

  switch (a.do) {
    case "expect": {
      await (await locate(a.target, page)).waitFor({ state: "visible", timeout: waitCap(20_000) });
      watch.waitPassed();
      pushCheck(stepResult, { expect: a.target, ok: true });
      if (a.highlight) await smoothScrollTo(page, a.highlight === true ? a.target : a.highlight, events, shot, { margin: 24 }, step.mask);
      const hb = await highlightBox(page, a.highlight, a.target);
      if (hb) {
        events.push({ type: "highlight", box: hb }, { type: "hold", seconds: 0.6 });
        highlightState.target = highlightTargetOf(a.highlight, a.target);
      }
      return ai;
    }
    case "waitFor": {
      await (await locate(a.target, page)).waitFor({ state: "visible", timeout: waitCap(60_000) });
      watch.waitPassed();
      await settle(page);
      events.push({ type: "frame", image: await shot("state", step.mask), transition: "fade" });
      pushCheck(stepResult, { waitFor: a.target, ok: true });
      const hb = await highlightBox(page, a.highlight, a.target);
      if (hb) {
        events.push({ type: "highlight", box: hb });
        highlightState.target = highlightTargetOf(a.highlight, a.target);
      }
      return ai;
    }
    case "waitForUrl": {
      await page.waitForURL(new RegExp(a.pattern), { timeout: waitCap(60_000) });
      watch.waitPassed();
      await settle(page);
      events.push({ type: "frame", image: await shot("state", step.mask), transition: "fade" });
      pushCheck(stepResult, { waitForUrl: a.pattern, ok: true });
      return ai;
    }
    case "goto": {
      const target = new URL(a.path, page.url());
      if (target.origin !== baseOrigin) {
        throw new Error(`refusing cross-origin goto to ${target.origin} (walkthrough origin is ${baseOrigin})`);
      }
      await gotoReady(page, target.href, waitCap(120_000));
      watch.navigated(target.pathname);
      await settle(page);
      events.push({ type: "frame", image: await shot("state", step.mask), transition: "fade" });
      pushCheck(stepResult, { goto: a.path, ok: true });
      return ai;
    }
    case "scrollTo": {
      await smoothScrollTo(page, a.target, events, shot, { align: "top" }, step.mask);
      return ai;
    }
    case "point":
    case "click": {
      await smoothScrollTo(page, a.target, events, shot, { margin: a.do === "point" ? 24 : 60 }, step.mask);
      const loc = await locate(a.target, page);
      await loc.waitFor({ state: "visible" });
      seen.push(await accessibleName(loc));
      const box = await boxOf(a.target, page);
      const pt = center(box);
      if (a.do === "click" && a.target.label) pt.x = Math.round(box.x + Math.min(box.w * 0.3, 140));
      if (a.do === "point") {
        if (box.w <= 320) {
          pt.x = box.x + box.w + 10;
          pt.y = Math.round(box.y + box.h * 0.55);
        } else {
          pt.x = Math.round(box.x + box.w * 0.72);
          pt.y = Math.round(box.y + box.h * 0.62);
        }
        pt.x = Math.min(pt.x, viewportWidth - 24);
      }
      await page.mouse.move(pt.x, pt.y, { steps: 4 });
      await page.waitForTimeout(160);
      await paint(page);
      events.push({ type: "move", to: pt });
      events.push({ type: "frame", image: await shot("hover", step.mask), transition: "cut" });
      const hb = await highlightBox(page, a.highlight, a.target);
      if (hb) {
        events.push({ type: "highlight", box: hb });
        highlightState.target = highlightTargetOf(a.highlight, a.target);
      }
      if (a.do === "point") {
        events.push({ type: "hold", seconds: 0.8 });
        pushCheck(stepResult, { point: a.target, ok: true });
        return ai;
      }
      events.push({ type: "click", at: pt });
      await watch.beforeClick();
      await loc.click({ position: { x: pt.x - box.x, y: pt.y - box.y } });
      pushCheck(stepResult, { click: a.target, ok: true });

      // A click may navigate: whatever was highlighted at click time (`hb` above) belongs to the
      // page as it was *before* this click, so it must not survive as "the current highlight"
      // past this point — it's re-asserted below only if a wait that follows asks for its own
      // highlight on the page the click lands on.
      highlightState.target = null;

      // Consume the waits that belong to this click before showing the result.
      let i = ai;
      while (acts[i + 1] && (acts[i + 1].do === "waitFor" || acts[i + 1].do === "waitForUrl")) {
        const w = acts[++i];
        progress.lastOk = { index: i, do: acts[i - 1].do };
        progress.current = { index: i + 1, do: w.do, ...(w.do === "waitFor" ? { target: w.target } : {}) };
        if (w.do === "waitFor") {
          await (await locate(w.target, page)).waitFor({ state: "visible", timeout: waitCap(60_000) });
        } else if (w.do === "waitForUrl") {
          await page.waitForURL(new RegExp(w.pattern), { timeout: waitCap(60_000) });
        }
        watch.waitPassed();
        if (w.do === "waitFor") pushCheck(stepResult, { waitFor: w.target, ok: true });
        else if (w.do === "waitForUrl") pushCheck(stepResult, { waitForUrl: w.pattern, ok: true });
        if (w.do === "waitFor" && w.snapshot) {
          await paint(page);
          events.push({ type: "clearHighlight" }, { type: "frame", image: await shot("state", step.mask), transition: "fade" });
          const wb = await highlightBox(page, w.highlight, w.target);
          if (wb) {
            events.push({ type: "highlight", box: wb });
            highlightState.target = highlightTargetOf(w.highlight, w.target);
          }
          events.push({ type: "hold", seconds: 0.9 });
        }
      }
      await settle(page);
      events.push({ type: "clearHighlight" }, { type: "frame", image: await shot("state", step.mask), transition: "fade" });
      highlightState.target = null;
      return i;
    }
    case "select": {
      // Native <select> and custom combobox widgets need different drivers (see action.ts): a
      // native select has no `role=option` nodes for Playwright to click, so `locator.click()` on
      // one just times out — `selectOption` is the only thing that works. A custom combobox (the
      // common design-system pattern: a button that opens a listbox) has no native "select a
      // value" primitive, so it keeps the open-then-click-option behaviour that explicit
      // `click`/`click` pairs already use.
      await smoothScrollTo(page, a.target, events, shot, { margin: 60 }, step.mask);
      const loc = await locate(a.target, page);
      await loc.waitFor({ state: "visible" });
      seen.push(await accessibleName(loc));
      const box = await boxOf(a.target, page);
      const pt = center(box);
      if (a.target.label) pt.x = Math.round(box.x + Math.min(box.w * 0.3, 140));
      await page.mouse.move(pt.x, pt.y, { steps: 4 });
      await page.waitForTimeout(160);
      await paint(page);
      events.push({ type: "move", to: pt });
      events.push({ type: "frame", image: await shot("hover", step.mask), transition: "cut" });
      const hb = await highlightBox(page, a.highlight, a.target);
      if (hb) {
        events.push({ type: "highlight", box: hb });
        highlightState.target = highlightTargetOf(a.highlight, a.target);
      }

      const isNativeSelect = await loc.evaluate((el) => el.tagName === "SELECT").catch(() => false);
      events.push({ type: "click", at: pt });
      await watch.beforeClick();
      if (isNativeSelect) {
        try {
          await loc.selectOption({ label: a.option });
        } catch {
          await loc.selectOption(a.option);
        }
      } else {
        await loc.click({ position: { x: pt.x - box.x, y: pt.y - box.y } });
        // Captured before the option click: the trigger's own accessible name/text is expected to
        // change to the picked option, so a fresh `getByRole(..., { name: oldName })` re-lookup
        // afterwards would (correctly) stop matching — see `comboboxShowsOption`.
        const triggerHandle = await loc.elementHandle();
        const listbox = await resolveComboboxListbox(loc, page);
        const optionLoc = listbox.getByRole("option", { name: a.option, exact: true });
        await optionLoc.waitFor({ state: "visible", timeout: waitCap(10_000) });
        await optionLoc.click();
        const confirmed = triggerHandle ? await comboboxShowsOption(triggerHandle, a.option) : false;
        if (!confirmed) {
          throw new Error(
            `select: ${JSON.stringify(a.option)} does not appear selected in ${JSON.stringify(a.target)} after clicking the option`,
          );
        }
      }
      pushCheck(stepResult, { select: a.target, option: a.option, ok: true });
      await settle(page);
      events.push({ type: "clearHighlight" }, { type: "frame", image: await shot("state", step.mask), transition: "fade" });
      highlightState.target = null;
      return ai;
    }
    case "type": {
      const loc = await locate(a.target, page);
      const isFocused = await loc.evaluate((el) => el === document.activeElement);
      seen.push(await accessibleName(loc));
      if (!isFocused) await loc.focus();
      const masked = isMaskedTarget(a.target, step.mask);
      const images: string[] = [];
      // Visible per-character typing (one screenshot per char, for the video) up to `maxTypeMs`
      // of wall-clock time; once that budget is spent, `fill()` the rest in one shot rather than
      // keep paying a screenshot per character — a long value (a UUID, say) used to make typing
      // dominate a capture's wall time for no benefit nobody watching the video would notice
      // (docs/build-plan.md: "6 steps took 255s, typing UUIDs"). The final value and all other
      // frames are unaffected either way.
      const chars = Array.from(a.text);
      const typeStarted = Date.now();
      let typed = 0;
      for (const ch of chars) {
        if (Date.now() - typeStarted >= maxTypeMs) break;
        await page.keyboard.type(ch);
        await paint(page);
        images.push(await shot("type", step.mask));
        typed += 1;
      }
      if (typed < chars.length) {
        await loc.fill(a.text);
      }
      await settle(page);
      // `typeFrames.text` drives the on-screen caption of what was typed —
      // never store the real text for a masked field here either.
      events.push({ type: "typeFrames", images, text: masked ? "[REDACTED]" : a.text });
      events.push({ type: "frame", image: await shot("state", step.mask), transition: "cut" });
      const value = await loc.inputValue().catch(() => null);
      const ok = value === null || value === a.text;
      pushCheck(stepResult, {
        type: a.target,
        text: masked ? "[REDACTED]" : a.text,
        value: masked ? (value === null ? null : "[REDACTED]") : value,
        ok,
      });
      if (!ok) {
        throw new Error(
          masked
            ? `typed text did not match for masked field ${JSON.stringify(a.target)}`
            : `typed "${a.text}" but field holds "${value}"`,
        );
      }
      return ai;
    }
    default:
      throw new Error(`unknown action ${(a as Action).do}`);
  }
}

function pushCheck(stepResult: StepResult, check: CheckResult): void {
  stepResult.checks.push(check);
}

async function highlightBox(
  page: Page,
  spec: boolean | Target | undefined,
  target: Target,
): Promise<Box | null> {
  if (!spec) return null;
  if (spec === true) return boxOf(target, page);
  return boxOf(spec, page);
}

/** The `Target` a highlight spec actually points at (same resolution `highlightBox` uses), so the
 * caller can re-resolve the same element's box later rather than reusing a box captured at a
 * different moment on a possibly different page. */
function highlightTargetOf(spec: boolean | Target | undefined, target: Target): Target | null {
  if (!spec) return null;
  return spec === true ? target : spec;
}

/** Tracks which highlight (if any) is still "on" at any point in a step's action stream, so the
 * doc screenshot can draw whatever is on-screen right now rather than every box a `highlight:
 * true` action ever produced mid-step. A `click`/`select` always clears its own highlight once
 * the resulting page has settled (see runAction) — a highlight only survives to the end of a step
 * when nothing after it cleared it (typically a trailing `expect`/`waitFor`/`point`). */
interface HighlightState {
  target: Target | null;
}
