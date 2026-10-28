// Builds public/procedures.json from publishable walkthroughs + their capture output
// (build-plan.md M15 step 1; scope.md "Agent connector (MCP server)" `get_procedure`). One
// procedure per walkthrough whose page passed this run — never a walkthrough that failed, so an
// agent is never handed steps that weren't actually seen working (scope.md "Truthfulness").
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { copyFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { displayWalkthrough, libraryPlacement, pathWalkthrough, type Walkthrough } from "../walkthrough/index.js";
import type { CaptureManifest, ValidationResult } from "../capture/index.js";
import { readPathCaptures } from "../capture/path-files.js";
import { stripMarkdown } from "../index-search/index.js";
import { pathScreenshotFile, readerNameForRole, screenshotFile, type RoleNames } from "../pages/content.js";
import { personaRole } from "../walkthrough/persona.js";
import { stepInstruction } from "../walkthrough/describe.js";
import type { BuildProceduresResult, Procedure, ProcedurePath, ProcedureStep } from "./types.js";

function readJsonIfExists<T>(file: string): T | undefined {
  return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as T) : undefined;
}

interface Scene {
  id: string;
  t0: number;
  t1: number;
}

/** Reads `<videoDir>/<id>/timeline.json`'s `scenes` array, when a render exists, keyed by scene
 * id (`beatIds()`: intro, each step's `step.id`, outro — see render/types.ts `TimelineScene`). */
function readSceneStarts(videoDir: string | undefined, id: string): Map<string, number> {
  const starts = new Map<string, number>();
  if (!videoDir) return starts;
  const timeline = readJsonIfExists<{ scenes?: Scene[] }>(join(videoDir, id, "timeline.json"));
  for (const scene of timeline?.scenes ?? []) starts.set(scene.id, scene.t0);
  return starts;
}

/** One step's plain-text instruction: `page_text` (markdown stripped) or, failing that,
 * `caption`, matching the priority the build spec gives ("page_text or caption"); a step with
 * neither is described from its actions ("Press Enter.", "Hover over Settings."). */
function instructionFor(step: Walkthrough["steps"][number], data: Walkthrough["data"]): string {
  return stripMarkdown(stepInstruction(step, data));
}

/**
 * Builds one walkthrough's procedure, when its capture validation passed (`passed` flag the
 * pages stage already computed — see pages/build.ts `BuildPageResult.passed`). Screenshots are
 * copied to `<publicDir>/screenshots/<id>/step-NN.png` so `get_procedure`'s `screenshot` URL is
 * a real static file any MCP/chat client can fetch directly, independent of how the site's own
 * MDX pages resolve their relative image links. The *source* copied is always the page's own
 * already-annotated screenshot (`<pagesDir>/<id>/screenshots/step-NN.png`, written by
 * pages/build.ts's `annotateFrame` with any `blur:`/`callouts:` already burned in) — never the
 * raw `captureDir/frames/*` file, which could still show what a step's `blur:` was meant to hide
 * (M22 review finding: procedures.json's screenshot copy bypassed annotateFrame entirely).
 */
export function buildProcedure(
  wf: Walkthrough,
  captureDir: string,
  opts: { pagesDir?: string; videoDir?: string; publicDir?: string; lastChecked?: string; readerNames?: ReaderNames },
): Procedure | undefined {
  wf = displayWalkthrough(wf);
  const manifest = readJsonIfExists<CaptureManifest>(join(captureDir, "manifest.json"));
  const validation = readJsonIfExists<ValidationResult>(join(captureDir, "validation.json"));
  if (!manifest || !validation?.ok) return undefined;

  const id = wf.walkthrough;
  const sceneStarts = readSceneStarts(opts.videoDir, id);

  const steps: ProcedureStep[] = [];
  const impactRoutes = new Set<string>();
  for (let i = 0; i < wf.steps.length; i++) {
    const step = wf.steps[i];
    const mStep = manifest.steps[i];
    const vStep = validation.steps[i];
    if (!mStep || (vStep && !vStep.ok)) continue; // never hand an agent a step that didn't pass

    const n = i + 1;
    let screenshot: string | undefined;
    if (mStep.doc.image && opts.publicDir && opts.pagesDir) {
      const src = join(opts.pagesDir, id, screenshotFile(n));
      if (existsSync(src)) {
        const destRel = join("screenshots", id, `step-${String(n).padStart(2, "0")}.png`);
        const dest = join(opts.publicDir, destRel);
        mkdirSync(dirname(dest), { recursive: true });
        copyFileSync(src, dest);
        screenshot = `/${destRel.split("\\").join("/")}`;
      }
    }

    const videoTimeSec = step.id ? sceneStarts.get(step.id) : undefined;

    for (const url of mStep.impact?.urls ?? []) {
      try {
        impactRoutes.add(new URL(url).pathname);
      } catch {
        if (url.startsWith("/")) impactRoutes.add(url);
      }
    }

    steps.push({
      n,
      title: step.title ?? `Step ${n}`,
      instruction: instructionFor(step, wf.data),
      ...(screenshot ? { screenshot } : {}),
      ...(videoTimeSec !== undefined ? { videoTimeSec } : {}),
    });
  }

  const paths = buildProcedurePaths(wf, captureDir, validation, steps, opts);
  const roleId = personaRole(wf.start);
  return {
    id,
    title: wf.title,
    url: libraryPlacement(wf.section, id).url,
    ...(wf.for ? { for: wf.for } : {}),
    start: {
      page: wf.start?.page,
      // `role` stays the persona's role id (what agent connectors match on); `roleName` is what
      // readers call it (config `roles`), the words the page prints.
      role: roleId,
      roleName: roleId ? readerNameForRole(roleId, wf, opts.readerNames?.readers, opts.readerNames?.roles) : undefined,
    },
    steps,
    ...(impactRoutes.size > 0 ? { impactRoutes: [...impactRoutes].sort() } : {}),
    ...(opts.lastChecked ? { lastChecked: opts.lastChecked } : {}),
    ...(paths.length > 0 ? { paths } : {}),
  };
}

/** Copies a page's already-annotated screenshot into `<publicDir>/screenshots/<id>/<name>`,
 * returning its site URL; undefined when there's no such screenshot. */
function publishScreenshot(src: string, id: string, name: string, publicDir: string): string | undefined {
  if (!existsSync(src)) return undefined;
  const destRel = join("screenshots", id, name);
  const dest = join(publicDir, destRel);
  mkdirSync(dirname(dest), { recursive: true });
  copyFileSync(src, dest);
  return `/${destRel.split("\\").join("/")}`;
}

/**
 * The walkthrough's other ways in (decision 34), for `get_procedure`: each path whose capture
 * passed, with its start page, its opening steps (screenshots copied from the page's own
 * annotated `screenshots/paths/` files, never raw frames) and the main step it joins (none for a
 * path that runs to its own end). A path that
 * didn't pass is left out, as a failed main step is.
 */
function buildProcedurePaths(
  wf: Walkthrough,
  captureDir: string,
  validation: ValidationResult,
  mainSteps: ProcedureStep[],
  opts: { pagesDir?: string; publicDir?: string },
): ProcedurePath[] {
  if (!wf.paths?.length) return [];
  const captures = new Map(readPathCaptures(captureDir, wf).map((c) => [c.pathId, c] as const));
  const flagged = new Set((validation.pathDiffs ?? []).map((d) => d.path));
  const out: ProcedurePath[] = [];
  for (const path of wf.paths) {
    const capture = captures.get(path.id);
    if (!capture?.manifest || !capture.validation?.ok) continue;
    const run = pathWalkthrough(wf, path);
    const joinsAt = run.alone ? undefined : run.joinIndex + 1;
    if (joinsAt !== undefined && !mainSteps.some((s) => s.n === joinsAt)) continue; // the step it joins isn't a verified one
    const steps: ProcedureStep[] = path.steps.map((step, i) => {
      const n = i + 1;
      const rel = pathScreenshotFile(path.id, n);
      const screenshot =
        capture.manifest!.steps[i]?.doc.image && opts.publicDir && opts.pagesDir
          ? publishScreenshot(join(opts.pagesDir, wf.walkthrough, rel), wf.walkthrough, rel.replace(/^screenshots\//, ""), opts.publicDir)
          : undefined;
      return { n, title: step.title ?? `Step ${n}`, instruction: instructionFor(step, wf.data), ...(screenshot ? { screenshot } : {}) };
    });
    const joinStep = joinsAt !== undefined ? wf.steps[run.joinIndex] : undefined;
    out.push({
      id: path.id,
      title: path.title,
      when: path.when,
      start: { page: path.start.page },
      steps,
      ...(joinsAt !== undefined ? { joinsAt, joinsTitle: joinStep?.title ?? `Step ${joinsAt}` } : {}),
      ...(flagged.has(path.id) && path.note ? { note: path.note } : {}),
    });
  }
  return out;
}

export interface BuildProceduresOptions {
  /** Each publishable walkthrough this run built, with its own capture dir. */
  sources: { wf: Walkthrough; captureDir: string; lastChecked?: string }[];
  /** `<outDir>/pages` — where pages/build.ts wrote each walkthrough's already-annotated
   * screenshots; `buildProcedure` copies from here, never from `captureDir/frames`. */
  pagesDir?: string;
  /** `<outDir>/videos` (or help app's video dir) — optional, for `videoTimeSec`. */
  videoDir?: string;
  /** Where to write `procedures.json` and copy screenshots into `screenshots/<id>/`. */
  publicDir: string;
  /**
   * `procedures.json` as it stood before this run (read by the caller). Merged with this run's
   * freshly-built procedures by id, so a scoped run (`aida build <id>`) doesn't wipe every
   * other walkthrough's entry (review finding index-stage.ts:179: "rebuilds procedures.json from
   * this run only, wiping others"). Omit (or pass `[]`) to skip merging — the result is then
   * exactly this run's procedures, as before.
   */
  existing?: Procedure[];
  /**
   * Every walkthrough id this run attempted to build a procedure for (regardless of whether it
   * actually produced one) — an `existing` entry whose id is in this set but has no corresponding
   * fresh procedure is for a walkthrough that's no longer publishable and is pruned, rather than
   * kept stale. Defaults to `sources`' own ids.
   */
  attemptedIds?: string[];
  /**
   * Every walkthrough id that currently exists on disk. An `existing` entry whose id isn't in
   * this set is for a deleted walkthrough and is pruned. Omit to skip pruning deleted ids.
   */
  validIds?: string[];
  /** config `readers`/`roles`, so `start.roleName` is the reader-facing name pages print too. */
  readerNames?: ReaderNames;
}

/** config `readers` and `roles` — what `readerNameForRole` needs to name a sign-in role. */
export interface ReaderNames {
  readers?: string[];
  roles?: RoleNames;
}

/**
 * Builds and writes `<publicDir>/procedures.json` from every given source, merged with
 * `opts.existing` by id, sorted by id for a deterministic diff. An id this run successfully
 * built always wins; an id this run attempted but couldn't produce (no longer publishable, or
 * its capture/validation is missing/failed) is pruned rather than left stale; an id for a
 * walkthrough deleted from disk (`validIds` given and it's not in it) is pruned too. Every other
 * existing id (untouched by this run) is carried over unchanged.
 */
export function buildProcedures(opts: BuildProceduresOptions): BuildProceduresResult {
  const procedures: Procedure[] = [];
  for (const source of opts.sources) {
    const procedure = buildProcedure(source.wf, source.captureDir, {
      pagesDir: opts.pagesDir,
      videoDir: opts.videoDir,
      publicDir: opts.publicDir,
      lastChecked: source.lastChecked,
      readerNames: opts.readerNames,
    });
    if (procedure) procedures.push(procedure);
  }

  const byId = new Map(procedures.map((p) => [p.id, p]));
  const attemptedIds = new Set(opts.attemptedIds ?? opts.sources.map((s) => s.wf.walkthrough));
  const validIds = opts.validIds ? new Set(opts.validIds) : undefined;
  for (const old of opts.existing ?? []) {
    if (byId.has(old.id)) continue; // this run rebuilt it — the fresh value wins
    if (attemptedIds.has(old.id)) continue; // attempted this run but produced nothing — prune (unpublishable)
    if (validIds && !validIds.has(old.id)) continue; // walkthrough no longer exists on disk — prune
    byId.set(old.id, old);
  }
  const merged = [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));

  mkdirSync(opts.publicDir, { recursive: true });
  const outFile = join(opts.publicDir, "procedures.json");
  writeFileSync(outFile, `${JSON.stringify(merged, null, 2)}\n`, "utf8");

  return { procedures: merged, outFile };
}
