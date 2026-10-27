// Finds video files in a staged help app copy and decides whether they need blob storage before
// deploy (docs/scope.md "Runs on Node...": "Videos are uploaded to blob storage"; build-plan.md
// M13 "video to blob storage"). Triggered either by exceeding a host's per-file static-asset
// limit (e.g. Cloudflare's Workers static-assets limit of 25 MiB/file) or by `publish.videoStorage`
// being set in config, which forces blob storage regardless of size.
import { existsSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, extname, join, relative } from "node:path";
import type { StagedVideo } from "./types.js";

const VIDEO_EXT = new Set([".mp4", ".webm", ".mov"]);
const CAPTION_EXT = [".srt", ".vtt"] as const;

/** Walks `<helpRoot>/public` (where the help app template serves static files from) collecting
 * every video. Safe to call on a dir with no videos yet — returns an empty list. */
export function findStagedVideos(helpRoot: string): StagedVideo[] {
  const publicDir = join(helpRoot, "public");
  const out: StagedVideo[] = [];
  if (!existsSync(publicDir)) return out;

  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      const ext = entry.name.slice(entry.name.lastIndexOf("."));
      if (!VIDEO_EXT.has(ext)) continue;
      const bytes = statSync(full).size;
      out.push({ absPath: full, relPath: relative(helpRoot, full), bytes });
    }
  };
  walk(publicDir);
  return out;
}

/** True when any staged video exceeds `limitBytes`, or the caller forced it (config `videoStorage`). */
export function needsBlobStorage(videos: StagedVideo[], limitBytes: number | undefined, forced: boolean): boolean {
  if (forced) return true;
  if (!limitBytes) return false;
  return videos.some((v) => v.bytes > limitBytes);
}

/**
 * Finds a video's caption files — `<id>.srt`/`<id>.vtt` next to `<id>.mp4` (the same layout
 * `build/pipeline.ts`'s `qaTargets()` and `pages/build.ts`'s `videoLinks()` both assume: video
 * and captions share a directory and basename stem). Review finding: captions must be uploaded
 * to blob storage alongside their video, with their own URL — not silently rewritten to the
 * video's URL.
 */
export function findCaptionsFor(helpRoot: string, video: StagedVideo): StagedVideo[] {
  const dir = dirname(video.absPath);
  const stem = basename(video.absPath, extname(video.absPath));
  const out: StagedVideo[] = [];
  for (const ext of CAPTION_EXT) {
    const file = join(dir, `${stem}${ext}`);
    if (!existsSync(file)) continue;
    out.push({ absPath: file, relPath: relative(helpRoot, file), bytes: statSync(file).size });
  }
  return out;
}
