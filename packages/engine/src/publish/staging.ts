// Stages the *whole* help app into `<helpRoot>/.aida/publish-stage` — what a real deploy
// actually builds/deploys from (docs/build-plan.md M13 "rewrite page frontmatter video URLs in
// the staged copy, not the source"; commands/publish.ts review finding: deploy() must run
// against this staged copy, not helpRoot, or rewritten blob video URLs never ship and oversized
// videos in public/ still deploy as static assets).
//
// `content/docs` and `public` are deep-copied for real, because both get mutated in the stage
// (frontmatter video/srt/vtt links rewritten; oversized video files dropped once uploaded to
// blob storage) — the source tree is never touched, only this copy. Everything else (package.json,
// node_modules, app/, next.config.mjs, lockfiles, etc.) is symlinked rather than copied: it's
// read-only for the deploy and symlinking keeps staging cheap (no node_modules duplication) while
// still presenting a real, buildable app directory at `stage` to the host's own CLI.
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join, relative } from "node:path";
import type { BlobUploadResult, StagedVideo } from "./types.js";

export function stageDirFor(helpRoot: string): string {
  return join(helpRoot, ".aida", "publish-stage");
}

/** Recursively copies `from` into `to`. */
function copyDir(from: string, to: string): void {
  mkdirSync(to, { recursive: true });
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    const fromPath = join(from, entry.name);
    const toPath = join(to, entry.name);
    if (entry.isDirectory()) copyDir(fromPath, toPath);
    else copyFileSync(fromPath, toPath);
  }
}

/**
 * Builds (or rebuilds) the full staged app copy, overwriting any previous stage. `content/docs`
 * and `public` are real copies (they get mutated below); every other top-level entry of
 * `helpRoot` — `node_modules`, `package.json`, `app/`, `next.config.mjs`, etc. — is symlinked in,
 * so `stage` is a complete, buildable app directory without duplicating large/unchanging trees.
 * Call this *after* `adapter.apply()` has written any host config files to `helpRoot`, so those
 * land in the stage too.
 */
export function createStage(helpRoot: string): string {
  const stage = stageDirFor(helpRoot);
  rmSync(stage, { recursive: true, force: true });
  mkdirSync(stage, { recursive: true });

  for (const entry of readdirSync(helpRoot, { withFileTypes: true })) {
    if (entry.name === ".aida") continue; // the stage itself + the approval record live here
    const from = join(helpRoot, entry.name);
    const to = join(stage, entry.name);
    if (entry.name === "content" || entry.name === "public") {
      if (entry.isDirectory()) copyDir(from, to);
      else copyFileSync(from, to);
      continue;
    }
    symlinkSync(from, to, entry.isDirectory() ? "dir" : "file");
  }

  // `content/docs` may not exist yet in a fresh help app — make sure the path callers expect
  // (`<stage>/content/docs`) is there even when there's nothing to copy.
  mkdirSync(join(stage, "content", "docs"), { recursive: true });
  return stage;
}

/**
 * Removes the staged copies of `videos` (deploy finding: once a video has been uploaded to blob
 * storage, the oversized local copy must not still ship as a static asset). Only removes the
 * specific uploaded files, never the whole `public/videos` directory, in case something else
 * lives alongside them.
 */
export function dropStagedVideos(stage: string, videos: StagedVideo[]): void {
  for (const video of videos) {
    const staged = join(stage, video.relPath);
    if (existsSync(staged)) unlinkSync(staged);
  }
}

export interface RewriteResult {
  /** Stage-relative paths of every `.mdx` file whose frontmatter was changed. */
  rewritten: string[];
}

/**
 * Rewrites `video:`/`srt:`/`vtt:` frontmatter links in every staged `.mdx` page that point at
 * an uploaded file's local path, to that upload's URL. `uploads` maps a staged file's `relPath`
 * (relative to `helpRoot`, e.g. `public/videos/add-entry.mp4`) to its blob upload result — pass
 * both the video *and* its caption files (`video-size.ts`'s `findCaptionsFor`) here so `srt:`/
 * `vtt:` get rewritten to their own uploaded URL instead of the video's.
 *
 * Matches a frontmatter value by its *exact* basename, never a substring — `video: "add.mp4"`
 * must never match an uploaded `add-entry.mp4` (review finding: the old substring match let one
 * walkthrough's video rewrite another's link, and silently dropped captions since it rewrote
 * `srt:`/`vtt:` to the video's own URL instead of uploading them).
 */
export function rewriteVideoLinksInStage(
  helpRoot: string,
  stage: string,
  videos: StagedVideo[],
  uploads: Map<string, BlobUploadResult>,
): RewriteResult {
  const docsDir = join(stage, "content", "docs");
  const rewritten: string[] = [];
  if (!existsSync(docsDir)) return { rewritten };

  // A page's frontmatter stores links relative to the page's own dir (pages/content.ts), so
  // match on the exact basename (full filename, extension included) — unambiguous since every
  // walkthrough's video/srt/vtt files have their own distinct basename.
  const byExactBasename = new Map<string, BlobUploadResult>();
  for (const v of videos) {
    const upload = uploads.get(v.relPath);
    if (upload) byExactBasename.set(basenameOf(v.relPath), upload);
  }
  if (byExactBasename.size === 0) return { rewritten };

  const lineRe = /^(video|srt|vtt):\s*"([^"]*)"\s*$/gm;
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.name.endsWith(".mdx")) continue;
      const text = readFileSync(full, "utf8");
      const next = text.replace(lineRe, (line, key: string, value: string) => {
        const upload = byExactBasename.get(basenameOf(value));
        return upload ? `${key}: "${upload.url}"` : line;
      });
      if (next !== text) {
        writeFileSync(full, next);
        rewritten.push(relative(stage, full));
      }
    }
  };
  walk(docsDir);
  return { rewritten };
}

function basenameOf(p: string): string {
  return p.split(/[\\/]/).pop() ?? p;
}
