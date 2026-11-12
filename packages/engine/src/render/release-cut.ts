// The release "what changed" video (decision 45; M48): a cut of scene segments the build already
// rendered, between title cards of its own. Nothing here captures or re-renders a walkthrough:
// a scene is reused by recomputing the hash its segment was cached under (segments.ts), so a
// segment that's missing or out of date is reported, never rebuilt. Segments are joined with the
// concat demuxer and `-c copy`, so a scene's pixels — burned-in blur included — reach the release
// video bit for bit. Cards are rendered through the same player as every other video, from a
// guide's own timeline for the look (brand, style preset, stage and caption band), with no
// screenshot on them.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { playerAssetFiles, writePlayerBundle } from "./bundle.js";
import { toChaptersVtt, toSrt, toVtt } from "./captions.js";
import { matchesCachedHash, writeHashSidecar, type FileHashCache, type HashSettings } from "./hash.js";
import { computeSceneHash, frameRangesForScenes, renderScenesToSegments, segmentPath } from "./segments.js";
import { cardReveals } from "./timeline.js";
import type {
  NarrationBeat,
  RenderQuality,
  Timeline,
  TimelineAudioCue,
  TimelineCaption,
  TimelineChip,
  TimelineClick,
} from "./types.js";
import { iso6392 } from "./video.js";
import { mediaTimeoutMs, PROBE_TIMEOUT_MS, runMediaTool } from "./media-tool.js";

// Kept here too: callers and tests have imported it from this module.
export { runMediaTool } from "./media-tool.js";

/** A card holds at least this long, so its title can be read even with a short spoken line. */
export const RELEASE_CARD_MIN_SECONDS = 3;

/** The card's stand-in "screen": never painted (the stage stays hidden behind a card), but
 * timeline readers expect one frame cue. A data URL, so no screenshot ever rides along. */
const NO_SCREEN = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

/** One title card of the release video. */
export interface ReleaseCardText {
  /** Scene id, unique within the video: it names the card's cached segment ("opening",
   * "guide-<id>", "closing" — a guide's id can't reach the other two). */
  id: string;
  eyebrow: string;
  title: string;
  subtitle?: string;
  facts?: string[];
  /** Who the guide is for, shown like a guide's own intro card. */
  reader?: string;
  /** Spoken, and shown as the caption. */
  say: string;
}

/** How long a card holds for its spoken line: the intro card's rule (voice at 0.7 s, a second
 * after it), with a floor. */
export function cardSeconds(narration: NarrationBeat): number {
  const d = narration.durationMs / 1000;
  return Number(Math.max(RELEASE_CARD_MIN_SECONDS, 0.7 + d + 1.0).toFixed(3));
}

const escapeHtml = (s: string): string =>
  s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c] as string);

/**
 * A card-only timeline: the player's intro card for the whole of it, fading out over its last
 * half second, the stage never shown. `look` is a guide's own timeline from the last build, so
 * the card has the same brand, style preset, frame size and caption band as the scenes around it.
 */
export function buildCardTimeline(card: ReleaseCardText, narration: NarrationBeat, look: Timeline, fps: number): Timeline {
  const duration = cardSeconds(narration);
  const d = narration.durationMs / 1000;
  const style = look.brand?.style ?? "bold";
  const audio: TimelineAudioCue[] = narration.audioPath && narration.durationMs > 0 ? [{ id: card.id, file: narration.audioPath, t: 0.7 }] : [];
  const captions: TimelineCaption[] = card.say.trim() && d > 0 ? [{ t0: 0.7, t1: Math.min(0.7 + d + 0.3, duration - 0.05), text: card.say }] : [];
  const full = { z: 1, cx: look.viewport.w / 2, cy: look.viewport.h / 2 };
  // The stage would slide in at `stageIn.t0`; starting it at the card's end keeps it hidden for
  // every rendered frame, and the player fades the card out over the 0.45 s before.
  const stageIn = { t0: duration, t1: duration + 0.85 };
  const stageOut = { t0: duration + 5, t1: duration + 5.9 };
  return {
    fps,
    viewport: { ...look.viewport },
    ...(look.frame ? { frame: { ...look.frame } } : {}),
    ...(look.band ? { band: { ...look.band } } : {}),
    ...(look.pointer ? { pointer: look.pointer } : {}),
    stage: { ...look.stage },
    chrome: look.chrome ?? 0,
    fade: look.fade,
    brand: look.brand,
    intro: {
      eyebrow: card.eyebrow,
      titleHtml: escapeHtml(card.title),
      subtitle: card.subtitle ?? "",
      ...(card.reader ? { reader: card.reader } : {}),
      facts: card.facts ?? [],
    },
    outro: { title: "", recap: [] },
    cards: cardReveals(style, stageOut.t0, 0, false),
    chapters: [],
    frames: [{ t: 0, src: NO_SCREEN, transition: "cut" }],
    moves: [],
    clicks: [],
    highlights: [],
    callouts: [],
    blur: [],
    cameras: [{ t0: 0, t1: 0, from: full, to: full }],
    captions,
    chips: [],
    audio,
    cursorStart: { ...look.cursorStart },
    stageIn,
    stageOut,
    duration,
    previewAudio: "narration.m4a",
    scenes: [{ id: card.id, t0: 0, t1: duration }],
  };
}

/** The per-scene cache key settings for a quality — what `encodeTimeline` hashes with. */
export function sceneHashSettings(quality: RenderQuality, draft: boolean): HashSettings {
  return { fps: quality.fps, crf: quality.crf, preset: quality.preset, draft };
}

/** The folder `computeSceneHash` reads player assets from: the bundle the build rendered with,
 * else this engine's own player (an older build whose bundle is gone then reads as stale). */
export async function sceneAssetsDir(bundleDir: string): Promise<string> {
  if (existsSync(path.join(bundleDir, "player.js"))) return bundleDir;
  return path.dirname((await playerAssetFiles())[0]);
}

/** A scene of a built video and where its cached segment would be. */
export interface SceneSegment {
  sceneId: string;
  file: string;
  exists: boolean;
  /** The scene's full content hash (the segment name carries its first 16 characters); empty
   * for a scene id the timeline doesn't have. */
  hash: string;
  /** Global frame range of the scene in its own video. */
  start: number;
  end: number;
}

/**
 * Finds the cached segments of `sceneIds` in a built video, by recomputing each scene's hash
 * exactly as `renderScenesToSegments` did (same timeline slice, frames and narration by content,
 * player assets, settings). `timeline` is the video's `timeline.json`; its `fps` is set to the
 * quality's, since a draft and a full render share that file. A scene id the timeline doesn't
 * have comes back with `exists: false` and an empty range.
 */
export function findSceneSegments(
  timeline: Timeline,
  sceneIds: string[],
  opts: { assetsDir: string; segmentsDir: string; quality: RenderQuality; draft: boolean; cache?: FileHashCache },
): SceneSegment[] {
  const tl: Timeline = { ...timeline, fps: opts.quality.fps };
  const scenes = tl.scenes ?? [];
  const ranges = frameRangesForScenes(scenes, tl.fps);
  const settings = sceneHashSettings(opts.quality, opts.draft);
  const cache = opts.cache ?? {};
  return sceneIds.map((sceneId) => {
    const i = scenes.findIndex((s) => s.id === sceneId);
    if (i < 0) return { sceneId, file: "", exists: false, hash: "", start: 0, end: 0 };
    const hash = computeSceneHash(tl, scenes[i], opts.assetsDir, settings, cache);
    const file = segmentPath(opts.segmentsDir, sceneId, hash);
    return { sceneId, file, exists: existsSync(file), hash, start: ranges[i].start, end: ranges[i].end };
  });
}

/**
 * True when a reused segment is as long as its planned frame count, within one frame: the build's
 * own check on a segment it reuses (segments.ts `reusedSegmentLooksValid`, same rule and the same
 * "assume ok when ffprobe can't say"). The cut's captions, chapters and narration are timed from
 * planned frame counts, so one truncated segment would shift everything after it.
 */
export async function segmentLengthMatches(ffprobe: string | undefined, file: string, frames: number, fps: number, signal?: AbortSignal): Promise<boolean> {
  if (!ffprobe) return true;
  try {
    const stdout = await runMediaTool(ffprobe, ["-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", file], {
      timeoutMs: PROBE_TIMEOUT_MS,
      signal,
    });
    const duration = Number.parseFloat(stdout.trim());
    if (!Number.isFinite(duration)) return true;
    return Math.abs(duration - frames / fps) <= 1 / fps + 1e-6;
  } catch {
    if (signal?.aborted) throw new Error(`stopped: ${String(signal.reason ?? "aborted")}`);
    return true;
  }
}

/** Renders a card timeline to its cached segment (same player, quality and encoder as every
 * scene, so it joins them with `-c copy`) and returns the segment's path. A card whose text,
 * narration and look are unchanged is reused without opening a browser. */
export async function renderCardSegment(
  tl: Timeline,
  opts: { bundleDir: string; segmentsDir: string; quality: RenderQuality; draft: boolean; ffmpeg: string; ffprobe?: string; cache?: FileHashCache },
): Promise<string> {
  const settings = sceneHashSettings(opts.quality, opts.draft);
  const cache = opts.cache ?? {};
  await writePlayerBundle(opts.bundleDir, tl);
  await renderScenesToSegments({
    bundleDir: opts.bundleDir,
    segmentsDir: opts.segmentsDir,
    timeline: tl,
    quality: opts.quality,
    settings,
    ffmpeg: opts.ffmpeg,
    ffprobe: opts.ffprobe,
    concurrency: 1,
    cache,
  });
  const scene = tl.scenes![0];
  return segmentPath(opts.segmentsDir, scene.id, computeSceneHash(tl, scene, opts.bundleDir, settings, cache));
}

/** One piece of the cut: a segment and the timeline it was rendered from. */
export interface CutPiece {
  /** Segment file (closed GOP, encoded like every other piece). */
  file: string;
  /** The segment's global frame range in `source` (a card: `[0, frames)`). */
  start: number;
  end: number;
  /** Captions, narration and clicks of `source` inside the piece's time range come with it. */
  source: Timeline;
  /** 0-based chapter (guide) the piece belongs to; unset for the opening and closing cards. */
  chapter?: number;
}

export interface ReleaseCut {
  fps: number;
  duration: number;
  /** Each piece with `at`, its start in the cut (seconds, frame-exact). */
  pieces: (CutPiece & { at: number })[];
  audio: TimelineAudioCue[];
  clicks: TimelineClick[];
  captions: TimelineCaption[];
  /** One per guide, `num` its position in the video. */
  chapters: TimelineChip[];
}

const round3 = (n: number): number => Number(n.toFixed(3));

/** Longest chapter title the chapters track carries: one caption line (qa/captions.ts's 42,
 * which the QA gate holds every `.vtt` to, a guide's own chapters track included). */
export const CHAPTER_TITLE_MAX = 42;

/** A guide title cut to one chapter line at a word boundary, with an ellipsis when cut. */
export function chapterTitle(title: string, max = CHAPTER_TITLE_MAX): string {
  const t = title.replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  const room = t.slice(0, max - 1);
  const space = room.lastIndexOf(" ");
  const cut = (space > max / 2 ? room.slice(0, space) : room).replace(/[\s,;:.\-–—]+$/, "");
  return `${cut}…`;
}

/**
 * Lays the pieces end to end and carries each one's captions, narration and clicks across,
 * shifted to where the piece lands. Times come from frame counts, so they match the joined video
 * exactly. `chapterTitles[i]` names chapter `i`: it runs from its first piece to its last.
 */
export function assembleCut(pieces: CutPiece[], chapterTitles: string[], fps: number): ReleaseCut {
  const out: ReleaseCut = { fps, duration: 0, pieces: [], audio: [], clicks: [], captions: [], chapters: [] };
  let frame = 0;
  const spans = new Map<number, { t0: number; t1: number }>();
  for (const piece of pieces) {
    const at = frame / fps;
    const from = piece.start / fps;
    const to = piece.end / fps;
    const shift = (t: number) => round3(t - from + at);
    for (const a of piece.source.audio) if (a.t >= from && a.t < to) out.audio.push({ ...a, t: shift(a.t) });
    for (const c of piece.source.clicks) if (c.t >= from && c.t < to) out.clicks.push({ ...c, t: shift(c.t) });
    // A caption belongs to the piece it starts in: one that runs on past its scene's end (a short
    // `voice.gapSeconds`) is cut at the join, never carried into the next piece, where its words
    // would flash by with none of its narration.
    for (const c of piece.source.captions) {
      if (c.t0 < from || c.t0 >= to) continue;
      const t1 = Math.min(c.t1, to);
      if (t1 - c.t0 > 0.05) out.captions.push({ t0: shift(c.t0), t1: shift(t1), text: c.text });
    }
    frame += piece.end - piece.start;
    out.pieces.push({ ...piece, at: round3(at) });
    if (piece.chapter !== undefined) {
      const span = spans.get(piece.chapter);
      spans.set(piece.chapter, { t0: span?.t0 ?? at, t1: frame / fps });
    }
  }
  out.duration = round3(frame / fps);
  out.captions.sort((a, b) => a.t0 - b.t0);
  out.captions.forEach((c, i, all) => {
    if (all[i + 1]) c.t1 = Math.min(c.t1, round3(all[i + 1].t0 - 0.05));
  });
  out.chapters = [...spans.entries()]
    .sort(([a], [b]) => a - b)
    .map(([i, s], n) => ({ t0: round3(s.t0), t1: round3(s.t1), num: String(n + 1), eyebrow: "", title: chapterTitle(chapterTitles[i] ?? "") }));
  return out;
}

export interface ReleaseCutFiles {
  mp4: string;
  srt: string;
  vtt: string;
  chaptersVtt: string;
}

/** The whole-video cache key: every segment (their names carry their own content hash), every
 * narration clip and when it plays, the captions, chapters, title and language. */
export function releaseCutHash(cut: ReleaseCut, title: string, lang: string | undefined): string {
  const payload = {
    fps: cut.fps,
    pieces: cut.pieces.map((p) => [path.basename(p.file), p.end - p.start, p.at]),
    audio: cut.audio.map((a) => [a.file, a.t]),
    clicks: cut.clicks.map((c) => c.t),
    captions: cut.captions,
    chapters: cut.chapters,
    title,
    lang: lang ?? "",
  };
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

/** Writes through a temporary name, so a reader never sees half a file and a copy of the old
 * one elsewhere (a hard link) is never changed in place. */
function writeReplacing(file: string, content: string): void {
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, content);
  renameSync(tmp, file);
}

/** How long an ffmpeg step of the release video may run: generous for a busy machine (the mix
 * of a few minutes of narration takes seconds), but finite (media-tool.ts `mediaTimeoutMs`). */
export function releaseFfmpegTimeoutMs(durationSeconds: number): number {
  return mediaTimeoutMs(durationSeconds);
}

/**
 * The narration mix's ffmpeg arguments: every clip at its cue, soft ticks on clicks, padded and
 * cut to exactly `cut.duration`, loudness-normalised to -16 LUFS (render/audio.ts's mix, same
 * sound). The padding is bounded (`apad=whole_dur`): a bare `apad` pads forever and leaves only
 * `atrim` to end the graph, and ffmpeg 8 sometimes never gets there (a filter-graph thread
 * spinning at full CPU, ignoring SIGTERM), seen as release-video tests' ffmpeg runs left for hours.
 */
export function releaseNarrationArgs(cut: Pick<ReleaseCut, "audio" | "clicks" | "duration">, tick: string, outFile: string): string[] {
  const inputs: string[] = [];
  const filters: string[] = [];
  cut.audio.forEach((a, i) => {
    inputs.push("-i", a.file);
    filters.push(`[${i}:a]aresample=44100,aformat=channel_layouts=mono,adelay=${Math.round(a.t * 1000)}:all=1[v${i}]`);
  });
  cut.clicks.forEach((c, j) => {
    inputs.push("-i", tick);
    filters.push(`[${cut.audio.length + j}:a]volume=0.22,adelay=${Math.round(c.t * 1000)}:all=1[c${j}]`);
  });
  const labels = [...cut.audio.map((_, i) => `[v${i}]`), ...cut.clicks.map((_, j) => `[c${j}]`)].join("");
  const d = cut.duration;
  filters.push(
    `${labels}amix=inputs=${cut.audio.length + cut.clicks.length}:normalize=0:dropout_transition=0,` +
      `apad=whole_dur=${d},atrim=0:${d},loudnorm=I=-16:TP=-1.5:LRA=11,aresample=48000[out]`,
  );
  return ["-y", "-v", "error", ...inputs, "-filter_complex", filters.join(";"), "-map", "[out]", "-c:a", "aac", "-b:a", "192k", outFile];
}

/**
 * Writes the cut's captions and chapters, then its video: the segments joined with `-c copy`,
 * the narration mixed and loudness-normalised like every other video's, muxed with the captions
 * as a soft track. Skipped (`skipped: true`) when the `.hash` sidecar already matches.
 *
 * Every ffmpeg here runs through `runMediaTool` (no stdin, killed on a timeout or `signal`), with
 * the same arguments as render/video.ts's `concatSegments` and `muxVideo`.
 */
export async function encodeReleaseCut(
  cut: ReleaseCut,
  files: ReleaseCutFiles,
  ctx: { workDir: string; ffmpeg: string; title: string; lang?: string; signal?: AbortSignal; timeoutMs?: number },
): Promise<{ skipped: boolean }> {
  mkdirSync(path.dirname(files.mp4), { recursive: true });
  writeReplacing(files.srt, toSrt(cut.captions));
  writeReplacing(files.vtt, toVtt(cut.captions));
  writeReplacing(files.chaptersVtt, toChaptersVtt(cut.chapters));
  const hash = releaseCutHash(cut, ctx.title, ctx.lang);
  if (matchesCachedHash(files.mp4, hash)) return { skipped: true };

  // The mix needs at least one input; a cut with nothing to hear isn't a narrated video.
  if (cut.audio.length === 0 && cut.clicks.length === 0) throw new Error("the release video has no narration at all");
  rmSync(ctx.workDir, { recursive: true, force: true });
  mkdirSync(ctx.workDir, { recursive: true });
  const run = (args: string[]) => runMediaTool(ctx.ffmpeg, args, { timeoutMs: ctx.timeoutMs ?? releaseFfmpegTimeoutMs(cut.duration), signal: ctx.signal });

  const silent = path.join(ctx.workDir, "video.mp4");
  const list = path.join(ctx.workDir, "segments.txt");
  writeFileSync(list, cut.pieces.map((p) => `file '${p.file.replace(/'/g, "'\\''")}'`).join("\n"));
  await run(["-y", "-v", "error", "-f", "concat", "-safe", "0", "-i", list, "-c", "copy", silent]);

  const tick = path.join(ctx.workDir, "tick.wav");
  if (cut.clicks.length > 0) {
    await run(["-y", "-v", "error", "-f", "lavfi", "-i", "aevalsrc='0.6*sin(2*PI*2400*t)*exp(-t*90)+0.25*sin(2*PI*900*t)*exp(-t*60)':s=44100:d=0.06", "-ac", "1", tick]);
  }
  const narration = path.join(ctx.workDir, "narration.m4a");
  await run(releaseNarrationArgs(cut, tick, narration));

  // Two passes, as muxVideo does: captions folded into the `-shortest` mux could cut the video
  // to the last cue.
  const language = iso6392(ctx.lang);
  const muxed = path.join(ctx.workDir, "muxed.mp4");
  await run(["-y", "-v", "error", "-i", silent, "-i", narration, "-map", "0:v", "-map", "1:a", "-c:v", "copy", "-c:a", "copy", "-shortest", "-movflags", "+faststart", "-metadata", `title=${ctx.title}`, "-metadata:s:a:0", `language=${language}`, muxed]);
  const tmp = path.join(ctx.workDir, "release.mp4");
  await run(["-y", "-v", "error", "-i", muxed, "-i", files.vtt, "-map", "0", "-map", "1:s", "-c", "copy", "-c:s", "mov_text", "-movflags", "+faststart", "-metadata:s:s:0", `language=${language}`, "-disposition:s:0", "0", tmp]);
  renameSync(tmp, files.mp4);
  writeHashSidecar(files.mp4, hash);
  return { skipped: false };
}
