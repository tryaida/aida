// The published release video's record of what it was cut from, and the check that takes it down
// once that's no longer true (M48). The release video holds copies of guides' own scenes, so it
// must come down with any of them: a guide deleted, unpublished, edited, or rendered again (a new
// blur box, a recapture) leaves a copy in `_whats-new/` that nothing else would ever remove.
//
// Kept apart from release-video.ts so the build's index stage can run the check on every build
// without loading the cut, the QA gates or the voice: it's file reads and a few hashes, and it
// never throws into the build.
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { findStagedPages } from "../build/library.js";
import { loadFileHashCache, walkthroughHash, type FileHashCache, type HashSettings } from "../render/hash.js";
import { computeSceneHash } from "../render/scene-hash.js";
import type { Timeline } from "../render/types.js";
import type { Walkthrough } from "../walkthrough/types.js";
import { VIDEO_BLOCK_KEY } from "./release-text.js";

/** Folder of the release video, under the render dir and the help app's `public/videos/`. The
 * leading underscore keeps it clear of every walkthrough id (`^[a-z0-9][a-z0-9-]*$`), whose
 * folders the build stages and prunes. */
export const RELEASE_VIDEO_DIR = "_whats-new";
export const RELEASE_BASENAME = "whats-new";
/** The record beside the staged video: which guides, walkthroughs and scenes it was cut from. */
export const RELEASE_MANIFEST = `${RELEASE_BASENAME}.manifest.json`;

/** The files staged into the help app, the manifest last. */
export function releaseStagedNames(): string[] {
  return ["mp4", "srt", "vtt", "chapters.vtt", "transcript.md"].map((ext) => `${RELEASE_BASENAME}.${ext}`);
}

export function releasePublicDir(helpApp: string): string {
  return join(helpApp, "public", "videos", RELEASE_VIDEO_DIR);
}

export function whatsNewPageFile(helpApp: string): string {
  return join(helpApp, "content", "docs", "whats-new", "index.mdx");
}

export interface ReleaseManifest {
  version: 1;
  /** The per-scene cache key settings the scenes were found under (render/release-cut.ts). */
  settings: HashSettings;
  guides: {
    id: string;
    /** `walkthroughHash` of the walkthrough as loaded, when the video was cut. */
    walkthrough: string;
    /** Each scene of the guide's own video in the cut, with its full content hash. */
    scenes: { id: string; hash: string }[];
  }[];
}

export function readReleaseManifest(helpApp: string): ReleaseManifest | undefined {
  try {
    const m = JSON.parse(readFileSync(join(releasePublicDir(helpApp), RELEASE_MANIFEST), "utf8")) as ReleaseManifest;
    if (m?.version !== 1 || !Array.isArray(m.guides) || !m.settings) return undefined;
    return m;
  } catch {
    return undefined;
  }
}

export function writeReleaseManifest(helpApp: string, manifest: ReleaseManifest): void {
  writeFileSync(join(releasePublicDir(helpApp), RELEASE_MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`);
}

const VIDEO_BLOCK_RE = new RegExp(
  `\\n*(?:\\{/\\* aida:begin ${VIDEO_BLOCK_KEY} \\*/\\}|<!-- aida:begin ${VIDEO_BLOCK_KEY} -->)[\\s\\S]*?(?:\\{/\\* aida:end ${VIDEO_BLOCK_KEY} \\*/\\}|<!-- aida:end ${VIDEO_BLOCK_KEY} -->)`,
);

/** True when the What's new page embeds the release video. */
export function pageHasVideoBlock(helpApp: string): boolean {
  const file = whatsNewPageFile(helpApp);
  return existsSync(file) && VIDEO_BLOCK_RE.test(readFileSync(file, "utf8"));
}

/** Takes the video's block off the What's new page, hand-edited or not: with no video an embed
 * points at nothing. Only the block (and its sidecar entry) goes; the rest of the page stays. */
export function removeVideoBlock(helpApp: string): boolean {
  const file = whatsNewPageFile(helpApp);
  if (!existsSync(file)) return false;
  const text = readFileSync(file, "utf8");
  if (!VIDEO_BLOCK_RE.test(text)) return false;
  writeFileSync(file, text.replace(VIDEO_BLOCK_RE, "").replace(/\n{3,}/g, "\n\n"));
  const sidecar = `${file}.aida.json`;
  try {
    const entries = JSON.parse(readFileSync(sidecar, "utf8")) as Record<string, string>;
    if (VIDEO_BLOCK_KEY in entries) {
      delete entries[VIDEO_BLOCK_KEY];
      writeFileSync(sidecar, `${JSON.stringify(entries, null, 2)}\n`);
    }
  } catch {
    // No sidecar (or an unreadable one): nothing recorded for the block.
  }
  return true;
}

/** Removes the staged release video, its manifest and its page block. True when anything went. */
export function takeDownReleaseVideo(helpApp: string): boolean {
  const dir = releasePublicDir(helpApp);
  let removed = false;
  // The manifest first: a take-down cut short leaves files with no record, which the next check
  // takes down too, never a record that vouches for files it didn't describe.
  for (const name of [RELEASE_MANIFEST, ...releaseStagedNames()]) {
    const file = join(dir, name);
    if (existsSync(file)) {
      rmSync(file, { force: true });
      removed = true;
    }
  }
  return removeVideoBlock(helpApp) || removed;
}

/** The player files a scene hash covers when a render's own bundle is gone: this engine's, as
 * render/release-cut.ts `sceneAssetsDir` falls back to (bundle.ts's candidates, synchronously). */
function engineAssetsDir(): string | undefined {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const candidate of [resolve(here, "../../assets/player"), resolve(here, "../assets/player")]) {
    if (existsSync(join(candidate, "index.html"))) return candidate;
  }
  return undefined;
}

export interface ReleaseCheckInputs {
  helpApp: string;
  /** `<outDir>/videos`: each guide's last render (`timeline.json`, `.compose/`). */
  videoDir: string;
  /** Every walkthrough on disk, as loaded (`loadWalkthroughFile`); undefined when unknown, which
   * can't vouch for anything. */
  walkthroughs: Iterable<Walkthrough> | undefined;
}

export type ReleaseCheck = { published: false } | { published: true; current: true } | { published: true; current: false; reason: string };

/**
 * Whether the published release video still shows only what its guides show now: every guide in
 * its manifest exists, is published (its page staged and its own video on the site), has the
 * same walkthrough, and every scene it took still hashes the same in the guide's last render.
 */
export function checkPublishedReleaseVideo(inputs: ReleaseCheckInputs): ReleaseCheck {
  const dir = releasePublicDir(inputs.helpApp);
  const files = [RELEASE_MANIFEST, ...releaseStagedNames()].filter((n) => existsSync(join(dir, n)));
  const block = pageHasVideoBlock(inputs.helpApp);
  if (files.length === 0 && !block) return { published: false };
  const stale = (reason: string): ReleaseCheck => ({ published: true, current: false, reason });
  if (!releaseStagedNames().every((n) => files.includes(n))) return stale("its files aren't all on the site");
  if (!block) return stale("the What's new page doesn't embed it");
  const manifest = readReleaseManifest(inputs.helpApp);
  if (!manifest) return stale("it has no record of the guides it was cut from");
  if (!inputs.walkthroughs) return stale("the walkthroughs it was cut from weren't given to check against");

  const byId = new Map<string, Walkthrough>();
  for (const wf of inputs.walkthroughs) byId.set(wf.walkthrough, wf);
  const staged = new Set(findStagedPages(join(inputs.helpApp, "content", "docs")).map((p) => p.id));
  for (const g of manifest.guides) {
    const wf = byId.get(g.id);
    if (!wf) return stale(`${g.id} was deleted`);
    if (walkthroughHash(wf) !== g.walkthrough) return stale(`${g.id}'s walkthrough changed since the video was made`);
    if (!staged.has(g.id) || !existsSync(join(inputs.helpApp, "public", "videos", g.id, `${g.id}.mp4`))) return stale(`${g.id} is no longer published`);
    let timeline: Timeline;
    try {
      timeline = JSON.parse(readFileSync(join(inputs.videoDir, g.id, "timeline.json"), "utf8")) as Timeline;
    } catch {
      return stale(`${g.id} has no render to compare with`);
    }
    const tl: Timeline = { ...timeline, fps: manifest.settings.fps };
    const bundle = join(inputs.videoDir, g.id, ".compose");
    const assetsDir = existsSync(join(bundle, "player.js")) ? bundle : engineAssetsDir();
    if (!assetsDir) return stale(`${g.id}'s player files can't be found`);
    const cache = captureHashCache(tl);
    for (const s of g.scenes) {
      const scene = tl.scenes?.find((x) => x.id === s.id);
      if (!scene || computeSceneHash(tl, scene, assetsDir, manifest.settings, cache) !== s.hash) {
        const gone = tl.frames.some((f) => !f.src.startsWith("data:") && !existsSync(f.src));
        return stale(gone ? `${g.id}'s capture is gone, so its scenes can't be checked` : `${g.id}'s video changed since (step ${s.id})`);
      }
    }
  }
  return { published: true, current: true };
}

/** The capture's own file-hash cache (frames by path, size and mtime), read only: an unchanged
 * frame is stat'd, not re-read. Frames sit at `<captureDir>/frames/<file>`. */
function captureHashCache(tl: Timeline): FileHashCache {
  const src = tl.frames.find((f) => !f.src.startsWith("data:"))?.src;
  return src ? { ...loadFileHashCache(join(dirname(dirname(src)), ".aida-hash-cache.json")) } : {};
}

/**
 * The build's index stage runs this on every build (after pages are staged): the release video
 * and its page block come down when the check above fails or can't run. Never throws.
 */
export function retireStaleReleaseVideo(inputs: ReleaseCheckInputs): { takenDown: boolean; reason?: string } {
  let reason: string;
  try {
    const check = checkPublishedReleaseVideo(inputs);
    if (!check.published || check.current) return { takenDown: false };
    reason = check.reason;
  } catch (err) {
    reason = `it couldn't be checked: ${(err as Error).message.split("\n")[0]}`;
  }
  try {
    if (!takeDownReleaseVideo(inputs.helpApp)) return { takenDown: false };
  } catch (err) {
    console.warn(`aida build: the release video may be out of date (${reason}) but couldn't be taken down: ${(err as Error).message.split("\n")[0]}`);
    return { takenDown: false, reason };
  }
  console.warn(`aida build: took the release video off the What's new page: ${reason}. Run \`aida whats-new --video\` to cut a new one.`);
  return { takenDown: true, reason };
}
