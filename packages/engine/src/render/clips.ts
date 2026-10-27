// A short narrated clip per walkthrough path (decision 34; M35): the path's title card, its
// opening steps from its own capture — the same player, brand, style preset, zoom and blur rules
// as the main video — and a closing card "Then continue from step N: <title>", pointing at that
// step's chapter in the main video. Written next to the main video as `<id>.path-<pathId>.mp4`
// with `.srt`/`.vtt` captions, and cached by content hash per scene exactly like the main video.
//
// Blur is per screen across every capture of the task: the main run's and every path's boxes are
// unioned by route (`taskRouteBlur`), so a screen blurred anywhere is blurred in every video.
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import type { CaptureManifest } from "../capture/types.js";
import { readPathCaptures } from "../capture/path-files.js";
import type { Walkthrough } from "../walkthrough/types.js";
import { pathWalkthrough } from "../walkthrough/paths.js";
import { pathBeatId, pathClipText } from "./clip-lines.js";
import { buildTimeline, mergeRouteBlur, routeBlurFor, type RouteBlur } from "./timeline.js";
import type { NarrationBeat, PathClipResult, RenderOptions, Timeline } from "./types.js";
import type { EncodeContext, EncodeFiles, EncodeResult } from "./index.js";

export interface PathClipFiles {
  mp4: string;
  srt: string;
  vtt: string;
  timelineJson: string;
}

/** `<id>.path-<pathId>.mp4` (+ `.srt`, `.vtt`) and its timeline, in the walkthrough's video dir. */
export function pathClipFiles(videoStepDir: string, id: string, pathId: string): PathClipFiles {
  const base = path.join(videoStepDir, `${id}.path-${pathId}`);
  return { mp4: `${base}.mp4`, srt: `${base}.srt`, vtt: `${base}.vtt`, timelineJson: path.join(videoStepDir, `path-${pathId}.timeline.json`) };
}

/** True when any path step declares `blur:`. */
export function pathsDeclareBlur(wf: Pick<Walkthrough, "paths">): boolean {
  return (wf.paths ?? []).some((p) => p.steps.some((s) => (s.blur?.length ?? 0) > 0));
}

/** Every capture of the task's blur boxes by screen: the main run's and each path's (whatever
 * capture is on disk, passing or not — over-blurring beats a leak). */
export function taskRouteBlur(wf: Walkthrough, mainManifest: Pick<CaptureManifest, "steps">, captureDir: string): RouteBlur {
  const parts: RouteBlur[] = [routeBlurFor(wf, mainManifest)];
  if ((wf.paths ?? []).length > 0) {
    for (const capture of readPathCaptures(captureDir, wf)) {
      const p = wf.paths!.find((x) => x.id === capture.pathId);
      if (!p || !capture.manifest) continue;
      try {
        parts.push(routeBlurFor(pathWalkthrough(wf, p).walkthrough, capture.manifest));
      } catch {
        // joins no main step: the loader rejects that file
      }
    }
  }
  return mergeRouteBlur(...parts);
}

/** Removes a clip's files (an older render for a path that's gone or no longer passes). */
function removeClip(files: PathClipFiles): void {
  for (const f of [files.mp4, `${files.mp4}.hash`, files.srt, files.vtt, files.timelineJson]) rmSync(f, { force: true });
}

/** Clip files in `videoStepDir` for paths the walkthrough no longer has. */
function pruneOldClips(videoStepDir: string, id: string, keep: Set<string>): void {
  if (!existsSync(videoStepDir)) return;
  const prefix = `${id}.path-`;
  for (const name of readdirSync(videoStepDir)) {
    const m = name.startsWith(prefix) ? /^(.+?)\.(mp4|mp4\.hash|srt|vtt)$/.exec(name.slice(prefix.length)) : null;
    const t = /^path-(.+)\.timeline\.json$/.exec(name);
    const pathId = m?.[1] ?? t?.[1];
    if (pathId && !keep.has(pathId)) rmSync(path.join(videoStepDir, name), { force: true });
  }
  for (const name of ["segments", ".compose-paths"]) {
    const dir = path.join(videoStepDir, name);
    if (!existsSync(dir)) continue;
    for (const entry of readdirSync(dir)) {
      const m = /^path-(.+)$/.exec(entry);
      if (m && !keep.has(m[1])) rmSync(path.join(dir, entry), { recursive: true, force: true });
    }
  }
}

export interface RenderPathClipsContext {
  options: RenderOptions;
  quality: EncodeContext["quality"];
  draft: boolean;
  /** `<outDir>/<id>`: the main video's folder. */
  outDir: string;
  sharedBlur: RouteBlur;
  encode: (timeline: Timeline, files: EncodeFiles, ctx: EncodeContext) => Promise<EncodeResult>;
}

/** The narration a clip's timeline reads, keyed the way `buildTimeline` asks for it. */
function clipNarration(narration: Record<string, NarrationBeat>, pathId: string, stepIds: string[]): Record<string, NarrationBeat> | string {
  const out: Record<string, NarrationBeat> = {};
  for (const beat of ["intro", ...stepIds, "outro"]) {
    const b = narration[pathBeatId(pathId, beat)];
    if (!b) return `narration for "${pathBeatId(pathId, beat)}" is missing — run voice again`;
    out[beat] = b;
  }
  return out;
}

/**
 * Renders a clip for each of `wf`'s paths whose capture passed (see the module comment).
 * `wf` is the display walkthrough; `mainTimeline` gives each clip's "continue at" time.
 */
export async function renderPathClips(wf: Walkthrough, mainTimeline: Timeline, ctx: RenderPathClipsContext): Promise<PathClipResult[]> {
  const id = wf.walkthrough;
  const paths = wf.paths ?? [];
  pruneOldClips(ctx.outDir, id, new Set(paths.map((p) => p.id)));
  if (paths.length === 0) return [];
  const { options, quality, draft } = ctx;
  const captures = new Map(readPathCaptures(options.captureDir, wf).map((c) => [c.pathId, c] as const));
  const blurElsewhere = [...wf.steps, ...paths.flatMap((p) => p.steps)].some((s) => (s.blur?.length ?? 0) > 0);
  const results: PathClipResult[] = [];

  for (const p of paths) {
    const files = pathClipFiles(ctx.outDir, id, p.id);
    const capture = captures.get(p.id);
    const skip = (reason: string) => {
      removeClip(files);
      results.push({ pathId: p.id, skipped: true, notRendered: reason });
    };
    if (!capture?.manifest || !capture.validation?.ok) {
      skip("this way's capture didn't pass, so it has no clip");
      continue;
    }
    const run = pathWalkthrough(wf, p);
    const stepIds = p.steps.map((s) => s.id).filter((s): s is string => Boolean(s));
    if (stepIds.length !== p.steps.length) {
      skip("every step of a path needs an id");
      continue;
    }
    const narration = clipNarration(options.narration, p.id, stepIds);
    if (typeof narration === "string") {
      skip(narration);
      continue;
    }
    const opening = capture.manifest.steps.slice(0, run.openingSteps);
    if (opening.length < p.steps.length) {
      skip("the path's capture is missing some of its opening steps");
      continue;
    }
    const text = pathClipText(wf, p);
    const clipWt: Walkthrough = {
      ...run.walkthrough,
      steps: p.steps,
      intro: text.intro,
      outro: { title: text.outro.title, say: text.outro.say, recap: [] },
    };
    const n = p.steps.length;
    const timeline = buildTimeline(clipWt, { ...capture.manifest, steps: opening }, narration, {
      fps: quality.fps,
      frameSrc: (f) => path.join(capture.dir, "frames", f),
      brand: options.brand,
      zoomToTarget: options.zoomToTarget,
      sharedBlur: ctx.sharedBlur,
      blurDeclaredElsewhere: blurElsewhere,
      clip: { introMinSeconds: 3, facts: [`${n} step${n === 1 ? "" : "s"}`, `then step ${text.continueAt.step}`] },
    });
    const at = mainTimeline.scenes?.find((s) => s.id === text.continueAt.stepId)?.t0;
    const encoded = await ctx.encode(timeline, files, {
      options,
      quality,
      draft,
      bundleDir: path.join(ctx.outDir, ".compose-paths", `path-${p.id}`),
      segmentsDir: path.join(ctx.outDir, "segments", `path-${p.id}`, draft ? "draft" : "full"),
      title: `${wf.title}: ${p.title}`,
      stills: false,
    });
    results.push({
      pathId: p.id,
      mp4: files.mp4,
      srt: files.srt,
      vtt: files.vtt,
      timelineJson: files.timelineJson,
      durationSec: timeline.duration,
      skipped: encoded.skipped,
      continueAt: { ...text.continueAt, ...(at !== undefined ? { t: Number(at.toFixed(2)) } : {}) },
    });
  }
  return results;
}

export interface PathClipLink {
  pathId: string;
  /** Site URL of the clip, `/videos/<id>/<id>.path-<pathId>.mp4`. */
  src: string;
  vtt?: string;
  srt?: string;
  /** The main step the path joins, and where its chapter starts in the main video. */
  continueAt: { step: number; title?: string; t?: number };
  /** Site URL of the main video at that chapter (`…mp4#t=42.3`), when the main video exists. */
  mainVideoAt?: string;
}

/**
 * Each rendered path clip under `<videoDir>/<id>/`, as the site URLs the index stage publishes
 * them at (`/videos/<id>/…`, build/index-stage.ts), with the main video's chapter time to carry on
 * from. Paths with no clip on disk are left out.
 */
export function pathClipLinks(videoDir: string | undefined, wf: Walkthrough): PathClipLink[] {
  if (!videoDir || (wf.paths ?? []).length === 0) return [];
  const id = wf.walkthrough;
  const dir = path.join(videoDir, id);
  const url = (f: string) => `/videos/${id}/${path.basename(f)}`;
  let scenes: { id: string; t0: number }[] = [];
  try {
    scenes = (JSON.parse(readFileSync(path.join(dir, "timeline.json"), "utf8")) as { scenes?: { id: string; t0: number }[] }).scenes ?? [];
  } catch {
    // no main render yet
  }
  const mainVideo = existsSync(path.join(dir, `${id}.mp4`)) ? url(`${id}.mp4`) : undefined;
  const out: PathClipLink[] = [];
  for (const p of wf.paths ?? []) {
    const files = pathClipFiles(dir, id, p.id);
    if (!existsSync(files.mp4)) continue;
    let text;
    try {
      text = pathClipText(wf, p);
    } catch {
      continue;
    }
    const t = scenes.find((s) => s.id === text.continueAt.stepId)?.t0;
    out.push({
      pathId: p.id,
      src: url(files.mp4),
      ...(existsSync(files.vtt) ? { vtt: url(files.vtt) } : {}),
      ...(existsSync(files.srt) ? { srt: url(files.srt) } : {}),
      continueAt: { step: text.continueAt.step, title: text.continueAt.title, ...(t !== undefined ? { t: Number(t.toFixed(2)) } : {}) },
      ...(mainVideo ? { mainVideoAt: t !== undefined ? `${mainVideo}#t=${Number(t.toFixed(2))}` : mainVideo } : {}),
    });
  }
  return out;
}
