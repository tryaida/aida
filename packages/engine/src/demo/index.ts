// `aida demo` (decision 44, build-plan M44): every output with no setup. Copies a small fictional
// sample app (Acme Repairs: no database, no sign-in, data in memory) and its walkthroughs into a
// demo folder, scaffolds the help app with `aida init`'s own code, starts the app on a loopback
// port, runs the normal build pipeline through the normal safety gate, makes the proof sheet and
// stops the app. The demo folder stays a working example: plain files to edit and rebuild.
//
// Order of work, chosen so the first outputs come as soon as they can: the machine checks first
// (seconds); the folder and scaffold (seconds, no install); the build with a draft-quality render
// unless `full`; the help site's install (hundreds of MB, minutes) only when `site` asks for it.
import { existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { ENGINE_ROOT } from "../package-root.js";
import { runInitCommand } from "../commands/init.js";
import { loadConfig } from "../config/index.js";
import type { ResolvedConfig } from "../config/index.js";
import { assembleReport, runPipeline, writeReport } from "../build/index.js";
import type { BuildReport, BuildStageName } from "../build/index.js";
import { planRunFromFiles } from "../states/index.js";
import { buildProof } from "../proof/index.js";
import { libraryPlacement } from "../walkthrough/placement.js";
import { loadWalkthroughFile } from "../walkthrough/index.js";
import type { DoctorCheck, DoctorProbes } from "../doctor/index.js";
import { DEMO_APP_DEFAULT_PORT, DEMO_APP_URL_ENV, HELP_DIR_NAME, SHOWCASE_WALKTHROUGH, demoCodeFiles, demoConfigSource, demoFileEntries } from "./assets.js";
import { checkDemoFolder, claimDemoFolder, syncDemoFiles, verifyDemoCode, writeMarker, DemoFolderError, type DemoFolderState, type SyncReport } from "./folder.js";
import { fixDemoAidaDependency } from "./help-package.js";
import { runPreflight, voiceModelCached } from "./preflight.js";
import { outputsToWatch, stageProgress, watchProgress, formatElapsed } from "./progress.js";
import { startSampleApp, manage, type ManagedProcess, type SampleApp } from "./processes.js";
import { startHelpSite, type HelpSite } from "./site.js";
import { aidaInvocation, shellWord } from "./invocation.js";

export { MARKER_FILE, checkDemoFolder, DemoFolderError } from "./folder.js";
export { DEMO_APP_DIR, DEMO_WALKTHROUGHS_DIR, DEMO_APP_DEFAULT_PORT, DEMO_APP_URL_ENV, SHOWCASE_WALKTHROUGH } from "./assets.js";
export { startSampleApp, stopAll, liveCount } from "./processes.js";
export { manage, aidaInvocation };

export interface DemoOptions {
  /** The demo folder (absolute). */
  dir: string;
  /** Narrated videos (voice + render). Default true. */
  video?: boolean;
  /** Every walkthrough's video, at full quality. Default: the showcase walkthrough's only, as a
   * draft: narration is the slowest stage by far, and one video shows what they look like. */
  full?: boolean;
  /** Install the help app and start the help site at the end. Default false. */
  site?: boolean;
  /** The sample app's port. Default 4310, or a free one when that's taken. */
  port?: number;
  /** Leave the sample app running after the build (the command waits for Ctrl-C). */
  keepRunning?: boolean;
  /** Progress lines. */
  log?: (line: string) => void;
  /** Injected in tests. */
  probes?: DoctorProbes;
}

export interface DemoTiming {
  stage: string;
  ms: number;
}

export interface DemoOutputs {
  /** The showcase walkthrough's help page (MDX) and its screenshots. */
  page: string;
  screenshots: string;
  pdf?: string;
  card?: string;
  manual?: string;
  video?: string;
  captions?: string;
  /** One image of every output side by side (`aida proof`). */
  proof?: string;
  proofHtml?: string;
  report: string;
}

export interface DemoResult {
  ok: boolean;
  dir: string;
  helpDir: string;
  config: string;
  error?: string;
  checks?: DoctorCheck[];
  folder?: { state: DemoFolderState["kind"]; files: SyncReport };
  app?: { url: string; running: boolean };
  /** Capture order derived from the walkthroughs' needs/leaves. */
  order?: Array<{ walkthrough: string; needs: string[]; leaves: string[] }>;
  draft: boolean;
  video: boolean;
  timings: DemoTiming[];
  totalMs: number;
  outputs?: DemoOutputs;
  /** One line per failed walkthrough or stage. */
  failures?: string[];
  site?: { url: string; pageUrl: string };
  /** What to try next, in order. */
  next: string[];
}

export interface DemoRun {
  result: DemoResult;
  /** Processes left running on purpose (`keepRunning`, `site`); stop them when done. */
  running: ManagedProcess[];
}

/** The first build pass: everything but the videos. */
const FIRST_PASS_STAGES: BuildStageName[] = ["capture", "pages", "pdf", "qa", "index"];
/** The second: narration and video over the first pass's capture, then the pages, PDFs and checks
 * again so they link the videos. */
const VIDEO_PASS_STAGES: BuildStageName[] = ["voice", "render", "pages", "pdf", "qa", "index"];

/** Report stages as the demo shows them, in pipeline order. */
const STAGE_LABELS: Array<[BuildStageName, string]> = [
  ["capture", "capture"],
  ["voice", "narration"],
  ["render", "video"],
  ["pages", "pages"],
  ["pdf", "PDFs"],
  ["qa", "output checks"],
  ["index", "search index"],
];

function firstLine(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).split("\n")[0];
}

/** `file` relative to the working directory when that's shorter, for printing. */
export function shown(file: string, cwd = process.cwd()): string {
  const rel = relative(cwd, file);
  return rel && !rel.startsWith("..") ? rel : file;
}

export async function runDemo(opts: DemoOptions): Promise<DemoRun> {
  const started = Date.now();
  const log = opts.log ?? (() => {});
  const dir = opts.dir;
  const helpDir = join(dir, HELP_DIR_NAME);
  const configFile = join(helpDir, "aida.config.ts");
  const video = opts.video !== false;
  const draft = !opts.full;
  const timings: DemoTiming[] = [];
  const running: ManagedProcess[] = [];
  const result: DemoResult = { ok: false, dir, helpDir, config: configFile, draft, video, timings, totalMs: 0, next: [] };
  const finish = (): DemoRun => {
    result.totalMs = Date.now() - started;
    return { result, running };
  };
  const timed = async <T>(stage: string, fn: () => Promise<T> | T): Promise<T> => {
    const t = Date.now();
    try {
      return await fn();
    } finally {
      timings.push({ stage, ms: Date.now() - t });
    }
  };

  // The folder first: refusing it costs nothing and writes nothing.
  let folderState: DemoFolderState;
  try {
    folderState = checkDemoFolder(dir);
  } catch (err) {
    result.error = firstLine(err);
    return finish();
  }

  for (const line of whatToExpect(opts)) log(line);
  log("Checking this machine...");
  const preflight = await timed("machine checks", () => runPreflight({ dir, video, site: Boolean(opts.site), probes: opts.probes }));
  result.checks = preflight.checks;
  if (!preflight.ok) {
    result.error = "this machine needs a fix before the demo can run";
    return finish();
  }

  log(`Setting up ${shown(dir)} (sample app, walkthroughs, help app)...`);
  try {
    await timed("set up", () => {
      const marker = claimDemoFolder(dir);
      const files = syncDemoFiles(dir, marker, demoFileEntries(dir));
      // The config's brand is read from the app files just copied in.
      const config = syncDemoFiles(dir, marker, [{ rel: `${HELP_DIR_NAME}/aida.config.ts`, content: demoConfigSource(dir) }]);
      writeMarker(dir, marker);
      for (const key of ["written", "updated", "kept", "unchanged"] as const) files[key].push(...config[key]);
      result.folder = { state: folderState.kind, files };
      // Before anything in the folder runs: the sample app and the config must be the demo's own.
      verifyDemoCode(dir, marker, demoCodeFiles());
      // `aida init`'s own scaffold; the config above is left as it is. No engine pack or install:
      // nothing below needs the help app's packages until --site.
      runInitCommand({ dir, appRepo: dir, install: false, vendorEngine: false, fromApp: false });
      // ...but a later `npm install` in help/ must work, so its aida-docs has to resolve.
      fixDemoAidaDependency(helpDir);
    });
  } catch (err) {
    result.error = err instanceof DemoFolderError ? err.message : `setting up ${dir} failed: ${firstLine(err)}`;
    return finish();
  }
  const kept = result.folder!.files.kept;
  if (kept.length > 0) log(`  kept your edited ${kept.length === 1 ? "file" : "files"}: ${kept.join(", ")}`);

  log("Starting the sample app...");
  let app: SampleApp;
  try {
    app = await timed("start the app", () =>
      startSampleApp({ appDir: dir, port: opts.port ?? DEMO_APP_DEFAULT_PORT, explicitPort: opts.port !== undefined }),
    );
  } catch (err) {
    result.error = `the sample app didn't start: ${firstLine(err)}`;
    return finish();
  }
  result.app = { url: app.url, running: true };
  log(`  Acme Repairs is running at ${app.url}`);

  const previousUrl = process.env[DEMO_APP_URL_ENV];
  let report: BuildReport | undefined;
  let config: ResolvedConfig | undefined;
  try {
    process.env[DEMO_APP_URL_ENV] = app.url;
    config = await loadConfig(configFile);
    const files = readdirSync(config.walkthroughsDir)
      .filter((f) => /\.ya?ml$/i.test(f))
      .sort()
      .map((f) => join(config!.walkthroughsDir, f));
    const plan = planRunFromFiles(config, files, { reset: "database-checks" }).plan;
    result.order = plan.walkthroughs.map((p) => ({ walkthrough: p.id, needs: p.walkthrough.needs ?? [], leaves: p.walkthrough.leaves ?? [] }));
    log(`Capturing ${files.length} walkthroughs in the browser, in the order their needs and leaves give:`);
    for (const [i, item] of result.order.entries()) {
      const notes = [...item.needs.map((n) => `needs ${n}`), ...item.leaves.map((l) => `leaves ${l}`)];
      log(`  ${i + 1}. ${item.walkthrough}${notes.length > 0 ? `  (${notes.join(", ")})` : ""}`);
    }
    log("  The sample app keeps its data in memory, so the database check finds no database setting: expected here.");
    const order = result.order.map((o) => o.walkthrough);

    // First pass: capture, pages and PDFs, so the guides are there in about a minute. Videos are
    // the slow part (narration, then rendering) and come in a second pass over the same capture.
    const first = await buildPass(config, {
      configFile,
      draft,
      only: FIRST_PASS_STAGES,
      walkthroughIds: [],
      watch: outputsToWatch(config, order, { video: false }),
      log,
      timed,
    });
    if (first.refused) {
      const repo = enclosingGitRoot(dir);
      const hint = repo
        ? `\nThe check reads env files from the demo folder up to the root of the git repository it's in (${repo}). ` +
          `Run the demo in a folder outside any project, e.g. ${aidaInvocation()} demo ~/aida-demo.`
        : "";
      throw new Error(`${first.refused}${hint}`);
    }
    report = first.report;
    writeReport(config.buildDir, report);
    const captured = report.walkthroughs.filter((w) => w.stages.capture?.status === "ok" || w.stages.capture?.status === "skipped").map((w) => w.walkthrough);

    // The second pass doesn't use the app: stop it now unless it's wanted afterwards.
    let stopMs: number | undefined;
    if (!opts.keepRunning) {
      const t = Date.now();
      await app.process.stop();
      stopMs = Date.now() - t;
    }

    let second: PassResult | undefined;
    // Narration is the slow part (minutes per walkthrough on a busy machine), so by default only
    // the showcase walkthrough gets a video.
    const filmed = opts.full ? captured : captured.filter((id) => id === SHOWCASE_WALKTHROUGH);
    if (video && filmed.length > 0) {
      log(`First outputs ready after ${formatElapsed(Date.now() - started)}: a page and a PDF guide per walkthrough (${shown(join(config.outDir, "pdf"))}).`);
      const what = opts.full ? `the ${filmed.length} videos at full quality` : `the video for ${SHOWCASE_WALKTHROUGH} (draft quality; --full makes every video at full quality)`;
      log(`Narrating and rendering ${what}...`);
      for (const line of narrationNotice(filmed.length, voiceModelCached())) log(line);
      second = await buildPass(config, {
        configFile,
        draft,
        only: VIDEO_PASS_STAGES,
        walkthroughIds: filmed,
        watch: outputsToWatch(config, filmed, { video: true }).filter((o) => o.stage === "voice" || o.stage === "render"),
        log,
        timed,
      });
      report = mergeReports(config, draft, first.report, second.report, first.startedAt);
    }
    writeReport(config.buildDir, report);
    timings.push(...stageTimings([first, ...(second ? [second] : [])]));
    if (stopMs !== undefined) timings.push({ stage: "stop the app", ms: stopMs });
  } catch (err) {
    if (config && !report) {
      try {
        writeReport(config.buildDir, assembleReport(config, draft, [], undefined, undefined, `aida demo stopped: ${firstLine(err)}`));
      } catch {
        // the report is a nicety here; the error below is what matters
      }
    }
    result.error = `the build stopped: ${(err instanceof Error ? err.message : String(err)).trim()}`;
  } finally {
    if (previousUrl === undefined) delete process.env[DEMO_APP_URL_ENV];
    else process.env[DEMO_APP_URL_ENV] = previousUrl;
    if (app.process.running() && (!opts.keepRunning || result.error)) {
      await timed("stop the app", () => app.process.stop());
    }
    if (app.process.running()) running.push(app.process);
    result.app = { url: app.url, running: app.process.running() };
  }
  if (!report || !config) {
    result.next = nextSteps(result, opts);
    return finish();
  }

  result.failures = report.walkthroughs.flatMap((w) =>
    w.ok ? [] : [`${w.walkthrough}: ${(w.failures ?? []).map((f) => `${f.check}: ${f.problems[0] ?? ""}`).join("; ") || Object.entries(w.stages).filter(([, s]) => s?.status === "failed").map(([n, s]) => `${n}: ${s?.detail ?? ""}`).join("; ")}`],
  );
  if (result.failures.length === 0) delete result.failures;
  result.outputs = outputsFor(config, video, join(config.buildDir, "report.json"));

  if (report.ok) {
    log("Making the proof sheet (every output on one page)...");
    try {
      const proof = await timed("proof sheet", () =>
        buildProof(config!, {
          walkthrough: SHOWCASE_WALKTHROUGH,
          ...(video ? {} : { video: false as const }),
          intro: "Made by aida demo from the sample app. Your own app's guides get the same treatment, in your brand.",
          siteNote: opts.site ? "(the real help site starts next)" : `(${aidaInvocation()} demo --site shows the real help site)`,
        }),
      );
      result.outputs.proof = proof.png;
      result.outputs.proofHtml = proof.html;
    } catch (err) {
      log(`  skipped the proof sheet: ${firstLine(err)}`);
    }
  }
  result.ok = report.ok && !result.error;
  if (!report.ok && !result.error) result.error = "some walkthroughs didn't build; see the failures below";

  if (opts.site && result.ok) {
    try {
      const site = await startSite(helpDir, dir, log, timed);
      running.push(site.process);
      const wf = loadWalkthroughFile(join(config.walkthroughsDir, `${SHOWCASE_WALKTHROUGH}.yaml`));
      result.site = { url: site.url, pageUrl: `${site.url}${libraryPlacement(wf.section, wf.walkthrough).url}` };
    } catch (err) {
      result.ok = false;
      result.error = `the help site didn't start: ${firstLine(err)}`;
    }
  }
  result.next = nextSteps(result, opts);
  return finish();
}


interface PassResult {
  report: BuildReport;
  startedAt: string;
  /** Wall time of the pass. */
  ms: number;
  /** The safety gate's refusal, when it refused. */
  refused?: string;
}

/** One `runPipeline` run (as `aida build --only <stages>` runs it), with progress lines. */
async function buildPass(
  config: ResolvedConfig,
  o: {
    configFile: string;
    draft: boolean;
    only: BuildStageName[];
    walkthroughIds: string[];
    watch: ReturnType<typeof outputsToWatch>;
    log: (line: string) => void;
    timed: <T>(stage: string, fn: () => Promise<T> | T) => Promise<T>;
  },
): Promise<PassResult> {
  const started = Date.now();
  const watcher = watchProgress(o.watch, o.log, { since: started });
  const narrations = o.only.includes("voice") ? new Set(o.watch.filter((w) => w.stage === "voice").map((w) => w.walkthrough)).size : 0;
  const onProgress = stageProgress(o.log, { since: started, narrations, heard: () => watcher.heard() });
  try {
    const pipeline = await runPipeline(config, { configPath: o.configFile, walkthroughIds: o.walkthroughIds, draft: o.draft, only: o.only, json: false, onProgress });
    const ms = Date.now() - started;
    if (pipeline.refused) {
      // The real safety gate said no: a database or live payment key in this environment.
      const report = assembleReport(config, o.draft, pipeline.walkthroughs, undefined, pipeline.runStartedAt, pipeline.refused.message);
      writeReport(config.buildDir, report);
      return { report, ms, startedAt: pipeline.runStartedAt, refused: pipeline.refused.message };
    }
    const report = assembleReport(config, o.draft, pipeline.walkthroughs, pipeline.index ? { ...pipeline.index, ...pipeline.indexStage } : pipeline.indexStage, pipeline.runStartedAt);
    return { report, ms, startedAt: pipeline.runStartedAt };
  } finally {
    watcher.stop();
  }
}

/**
 * One report for both passes: each walkthrough's stages from both (the later pass wins for the
 * stages it ran again), ok only when both were, and the second pass's index.
 */
export function mergeReports(config: ResolvedConfig, draft: boolean, first: BuildReport, second: BuildReport, runStartedAt?: string): BuildReport {
  const later = new Map(second.walkthroughs.map((w) => [w.walkthrough, w]));
  const walkthroughs = first.walkthroughs.map((a) => {
    const b = later.get(a.walkthrough);
    if (!b) return a;
    const stages = { ...a.stages };
    for (const [name, stage] of Object.entries(b.stages)) if (stage && stage.status !== "not-selected") stages[name as BuildStageName] = stage;
    const failures = [...(a.failures ?? []).filter((f) => f.stage === "capture"), ...(b.failures ?? [])];
    return { ...a, ...b, stages, ok: a.ok && b.ok, ...(failures.length > 0 ? { failures } : { failures: undefined }) };
  });
  return assembleReport(config, draft, walkthroughs, second.index ?? first.index, runStartedAt);
}

/**
 * Time per stage for the summary, added up over the passes. Every stage runs one walkthrough at a
 * time except render (two at once), so render's wall time is what's left of its pass.
 */
function stageTimings(passes: PassResult[]): DemoTiming[] {
  const totals = new Map<string, number>();
  for (const pass of passes) {
    const ran = (stage: BuildStageName) =>
      stage === "index" ? Boolean(pass.report.index) : pass.report.walkthroughs.some((w) => w.stages[stage] && w.stages[stage]!.status !== "not-selected");
    const msOf = (stage: BuildStageName) =>
      stage === "index" ? (pass.report.index?.ms ?? 0) : pass.report.walkthroughs.reduce((sum, w) => sum + (w.stages[stage]?.status === "not-selected" ? 0 : (w.stages[stage]?.ms ?? 0)), 0);
    const here = STAGE_LABELS.filter(([stage]) => ran(stage)).map(([stage, label]) => ({ stage, label, ms: msOf(stage) }));
    const render = here.find((t) => t.stage === "render");
    if (render) render.ms = Math.max(0, pass.ms - here.filter((t) => t !== render).reduce((sum, t) => sum + t.ms, 0));
    for (const t of here) totals.set(t.label, (totals.get(t.label) ?? 0) + t.ms);
  }
  return STAGE_LABELS.filter(([, label]) => totals.has(label)).map(([, label]) => ({ stage: label, ms: totals.get(label)! }));
}

/** Installs the help app (the same packing and install `aida init` does) and starts its dev server. */
async function startSite(
  helpDir: string,
  dir: string,
  log: (line: string) => void,
  timed: <T>(stage: string, fn: () => Promise<T> | T) => Promise<T>,
): Promise<HelpSite> {
  const installed = existsSync(join(helpDir, "node_modules", "next", "package.json"));
  log(installed ? "Updating the help app's packages..." : "Installing the help app's packages (about 700 MB the first time; npm's output follows)...");
  await timed("install the help site", () => runInitCommand({ dir, appRepo: dir, fromApp: false }));
  log("Starting the help site...");
  return timed("start the help site", () => startHelpSite({ helpDir, log }));
}

/** Where the showcase walkthrough's outputs are, when they exist. */
export function outputsFor(config: Pick<ResolvedConfig, "outDir" | "buildDir">, video: boolean, report: string): DemoOutputs {
  const id = SHOWCASE_WALKTHROUGH;
  const ifExists = (file: string) => (existsSync(file) ? file : undefined);
  return {
    page: join(config.outDir, "pages", id, "index.mdx"),
    screenshots: join(config.outDir, "pages", id, "screenshots"),
    pdf: ifExists(join(config.outDir, "pdf", `${id}.pdf`)),
    card: ifExists(join(config.outDir, "pdf", `${id}.card.pdf`)),
    manual: ifExists(join(config.outDir, "pdf", "manual.pdf")),
    video: video ? ifExists(join(config.outDir, "videos", id, `${id}.mp4`)) : undefined,
    captions: video ? ifExists(join(config.outDir, "videos", id, `${id}.vtt`)) : undefined,
    report,
  };
}

/** The git work tree `dir` is inside, if any: the safety check reads env files up to its root. */
export function enclosingGitRoot(dir: string): string | undefined {
  let current = dir;
  for (let i = 0; i < 40; i++) {
    try {
      statSync(join(current, ".git"));
      return current;
    } catch {
      // keep looking
    }
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
  return undefined;
}

/**
 * What the run will do and roughly how long it takes, printed first: a newcomer otherwise sees a
 * few lines and then minutes of quiet. Times are from runs on an ordinary laptop (build-plan M44:
 * the pages and PDFs in about 3 minutes, then the video).
 */
export function whatToExpect(opts: Pick<DemoOptions, "video" | "full" | "site">): string[] {
  const lines =
    opts.video === false
      ? ["aida demo builds a help page and a PDF guide for each of the sample app's walkthroughs. It takes about 3 minutes; no video."]
      : opts.full
        ? [
            "aida demo builds a help page, a PDF guide and a narrated video for each of the sample app's walkthroughs.",
            "The pages and PDFs come first (about 3 minutes); the videos take 15 minutes or more, most of it narration.",
          ]
        : [
            "aida demo builds a help page and a PDF guide for each of the sample app's walkthroughs, and one narrated video.",
            "It takes about 5 to 10 minutes: the pages and PDFs first (about 3 minutes), then the video.",
          ];
  if (opts.site) lines.push("Then it installs the help site (about 700 MB the first time), which takes a few more minutes.");
  return lines;
}

/**
 * Said before narration starts. The voice model runs on this process's main thread and blocks
 * it, so after each "Narrating ..." line the progress lines pause until that narration is done;
 * without this the run looks stuck.
 */
export function narrationNotice(count: number, modelCached: boolean | undefined): string[] {
  const lines = [
    count === 1
      ? "  Narration runs a voice model on this computer and takes a few minutes; the progress lines pause while it works."
      : "  Narration runs a voice model on this computer and takes a few minutes per video; the progress lines pause while each one is narrated.",
  ];
  if (modelCached !== true) lines.push("  The first run also downloads the voice model (about 90 MB, once).");
  return lines;
}

function nextSteps(result: DemoResult, opts: DemoOptions): string[] {
  const aida = aidaInvocation();
  const dir = shellWord(shown(result.dir));
  const steps: string[] = [];
  if (!result.ok && !result.outputs) return steps;
  if (!result.site) {
    steps.push(`See the help site: ${aida} demo ${dir} --site (installs the help app, about 700 MB the first time)`);
  }
  if (!result.video) steps.push(`Add the narrated videos: ${aida} demo ${dir}`);
  else if (result.draft) steps.push(`A video for every walkthrough, at full quality: ${aida} demo ${dir} --full`);
  steps.push(`Edit a walkthrough in ${shown(join(result.helpDir, "walkthroughs"))}, then rebuild: ${aida} demo ${dir} (keeps your edits)`);
  const env = result.app && new URL(result.app.url).port !== String(DEMO_APP_DEFAULT_PORT) ? `${DEMO_APP_URL_ENV}=${result.app.url} ` : "";
  if (opts.keepRunning && result.app?.running) {
    steps.push(`Try aida against the running app (in another terminal): ${env}${aida} inspect /jobs --config ${shellWord(shown(result.config))}`);
  } else {
    steps.push(`Or run the app yourself (cd ${dir} && node server.mjs), then: ${aida} build --config ${shellWord(shown(result.config))} --draft`);
    steps.push(`Try aida inspect or aida record against the sample app: ${aida} demo ${dir} --keep-running`);
  }
  return steps;
}

export { formatElapsed };
