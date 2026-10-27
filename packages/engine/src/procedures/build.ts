// Builds public/procedures.json from publishable walkthroughs + their capture output
// (build-plan.md M15 step 1; scope.md "Agent connector (MCP server)" `get_procedure`). One
// procedure per walkthrough whose page passed this run — never a walkthrough that failed, so an
// agent is never handed steps that weren't actually seen working (scope.md "Truthfulness").
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { copyFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { libraryPlacement, type Walkthrough } from "../walkthrough/index.js";
import type { CaptureManifest, ValidationResult } from "../capture/index.js";
import { stripMarkdown } from "../index-search/index.js";
import { readerNameForRole, screenshotFile, type RoleNames } from "../pages/content.js";
import { personaRole } from "../walkthrough/persona.js";
import type { BuildProceduresResult, Procedure, ProcedureStep } from "./types.js";

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
 * `caption`, matching the priority the build spec gives ("page_text or caption"). */
function instructionFor(step: Walkthrough["steps"][number]): string {
  if (step.page_text) return stripMarkdown(step.page_text);
  if (step.caption) return stripMarkdown(step.caption);
  return "";
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
      instruction: instructionFor(step),
      ...(screenshot ? { screenshot } : {}),
      ...(videoTimeSec !== undefined ? { videoTimeSec } : {}),
    });
  }

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
  };
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
