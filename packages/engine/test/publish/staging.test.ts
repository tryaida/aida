// docs/build-plan.md M13 "Tests: ... blob rewrite in staged copy" — rewriting a page's video
// link must only touch `.aida/publish-stage`, never the source `content/docs` file.
import { existsSync, lstatSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createStage, dropStagedVideos, rewriteVideoLinksInStage, stageDirFor } from "../../src/publish/staging.js";
import { findCaptionsFor, findStagedVideos, needsBlobStorage } from "../../src/publish/video-size.js";
import { cleanupTmpDirs, makeHelpRoot, writePage } from "./helpers.js";
import type { BlobUploadResult, StagedVideo } from "../../src/publish/types.js";

afterEach(cleanupTmpDirs);

function writeVideo(helpRoot: string, relPath: string, bytes: number): void {
  const full = join(helpRoot, relPath);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, Buffer.alloc(bytes));
}

describe("findStagedVideos / needsBlobStorage", () => {
  it("finds video files under public/, ignoring everything else", () => {
    const helpRoot = makeHelpRoot();
    writeVideo(helpRoot, "public/videos/add-entry.mp4", 1000);
    writeFileSync(join(helpRoot, "public", "videos", "add-entry.srt"), "not a video");
    const videos = findStagedVideos(helpRoot);
    expect(videos).toHaveLength(1);
    expect(videos[0].relPath).toBe(join("public", "videos", "add-entry.mp4"));
    expect(videos[0].bytes).toBe(1000);
  });

  it("needs blob storage once a video exceeds the host's per-file limit", () => {
    const small: StagedVideo = { absPath: "a", relPath: "a", bytes: 1000 };
    const big: StagedVideo = { absPath: "b", relPath: "b", bytes: 30 * 1024 * 1024 };
    expect(needsBlobStorage([small], 25 * 1024 * 1024, false)).toBe(false);
    expect(needsBlobStorage([small, big], 25 * 1024 * 1024, false)).toBe(true);
  });

  it("is forced on regardless of size when publish.videoStorage is set", () => {
    const small: StagedVideo = { absPath: "a", relPath: "a", bytes: 1000 };
    expect(needsBlobStorage([small], undefined, true)).toBe(true);
  });
});

describe("rewriteVideoLinksInStage", () => {
  it("rewrites a nested library page whose links are site URLs under /videos/<id>/ (index stage layout), captions to their own upload", () => {
    const helpRoot = makeHelpRoot();
    writePage(helpRoot, "how-do-i/payments/add-entry", { video: "/videos/add-entry/add-entry.mp4", srt: "/videos/add-entry/add-entry.srt" });
    writeVideo(helpRoot, "public/videos/add-entry/add-entry.mp4", 10);
    writeFileSync(join(helpRoot, "public", "videos", "add-entry", "add-entry.srt"), "1");
    const [video] = findStagedVideos(helpRoot);
    const media = [video, ...findCaptionsFor(helpRoot, video)];
    const uploads = new Map<string, BlobUploadResult>(
      media.map((m) => [m.relPath, { url: `https://blob.example.com/${m.relPath.split("/").pop()}`, key: m.relPath, bytes: m.bytes }]),
    );

    const stage = createStage(helpRoot);
    rewriteVideoLinksInStage(helpRoot, stage, media, uploads);

    const staged = readFileSync(join(stage, "content", "docs", "how-do-i", "payments", "add-entry", "index.mdx"), "utf8");
    expect(staged).toContain('video: "https://blob.example.com/add-entry.mp4"');
    expect(staged).toContain('srt: "https://blob.example.com/add-entry.srt"');
  });

  it("rewrites the staged copy's video link, leaving the source page untouched", () => {
    const helpRoot = makeHelpRoot();
    const sourceFile = writePage(helpRoot, "add-entry", { video: "../../videos/add-entry/add-entry.mp4" });
    const video: StagedVideo = {
      absPath: join(helpRoot, "public", "videos", "add-entry.mp4"),
      relPath: join("public", "videos", "add-entry.mp4"),
      bytes: 123,
    };
    const upload: BlobUploadResult = { url: "https://blob.example.com/add-entry.mp4", key: video.relPath, bytes: 123 };
    const uploads = new Map([[video.relPath, upload]]);

    const stage = createStage(helpRoot);
    const { rewritten } = rewriteVideoLinksInStage(helpRoot, stage, [video], uploads);

    expect(rewritten).toHaveLength(1);
    const stagedFile = join(stage, "content", "docs", "add-entry", "index.mdx");
    expect(readFileSync(stagedFile, "utf8")).toContain(upload.url);

    // Source untouched.
    expect(readFileSync(sourceFile, "utf8")).toContain("../../videos/add-entry/add-entry.mp4");
    expect(readFileSync(sourceFile, "utf8")).not.toContain(upload.url);
  });

  // Regression test (review finding): matching must be on the *exact* basename, never a
  // substring — "add.mp4" must not be rewritten by an uploaded "add-entry.mp4".
  it("never rewrites a video link whose basename is only a substring match", () => {
    const helpRoot = makeHelpRoot();
    const addFile = writePage(helpRoot, "add", { video: "../../videos/add/add.mp4" });
    const addEntryFile = writePage(helpRoot, "add-entry", { video: "../../videos/add-entry/add-entry.mp4" });
    const video: StagedVideo = {
      absPath: join(helpRoot, "public", "videos", "add-entry.mp4"),
      relPath: join("public", "videos", "add-entry.mp4"),
      bytes: 123,
    };
    const upload: BlobUploadResult = { url: "https://blob.example.com/add-entry.mp4", key: video.relPath, bytes: 123 };
    const uploads = new Map([[video.relPath, upload]]);

    const stage = createStage(helpRoot);
    const { rewritten } = rewriteVideoLinksInStage(helpRoot, stage, [video], uploads);

    expect(rewritten).toEqual([join("content", "docs", "add-entry", "index.mdx")]);
    const stagedAddFile = join(stage, "content", "docs", "add", "index.mdx");
    const stagedAddEntryFile = join(stage, "content", "docs", "add-entry", "index.mdx");
    expect(readFileSync(stagedAddFile, "utf8")).toContain("../../videos/add/add.mp4");
    expect(readFileSync(stagedAddFile, "utf8")).not.toContain(upload.url);
    expect(readFileSync(stagedAddEntryFile, "utf8")).toContain(upload.url);

    // Sanity: the unrelated source pages were never touched either.
    expect(readFileSync(addFile, "utf8")).toContain("../../videos/add/add.mp4");
    expect(readFileSync(addEntryFile, "utf8")).toContain("../../videos/add-entry/add-entry.mp4");
  });

  // Regression test (review finding): srt/vtt get rewritten to their *own* uploaded URL, never
  // silently aliased to the video's URL.
  it("rewrites srt/vtt to their own uploaded URL, not the video's", () => {
    const helpRoot = makeHelpRoot();
    const sourceFile = writePage(helpRoot, "add-entry", {
      video: "../../videos/add-entry/add-entry.mp4",
      srt: "../../videos/add-entry/add-entry.srt",
    });
    // writePage's `opts` type doesn't carry `vtt`, so add it by hand to exercise all three keys.
    writeFileSync(
      sourceFile,
      readFileSync(sourceFile, "utf8").replace(
        'srt: "../../videos/add-entry/add-entry.srt"',
        'srt: "../../videos/add-entry/add-entry.srt"\nvtt: "../../videos/add-entry/add-entry.vtt"',
      ),
    );

    const video: StagedVideo = {
      absPath: join(helpRoot, "public", "videos", "add-entry.mp4"),
      relPath: join("public", "videos", "add-entry.mp4"),
      bytes: 123,
    };
    const srt: StagedVideo = {
      absPath: join(helpRoot, "public", "videos", "add-entry.srt"),
      relPath: join("public", "videos", "add-entry.srt"),
      bytes: 10,
    };
    const vtt: StagedVideo = {
      absPath: join(helpRoot, "public", "videos", "add-entry.vtt"),
      relPath: join("public", "videos", "add-entry.vtt"),
      bytes: 10,
    };
    const videoUpload: BlobUploadResult = { url: "https://blob.example.com/add-entry.mp4", key: video.relPath, bytes: 123 };
    const srtUpload: BlobUploadResult = { url: "https://blob.example.com/add-entry.srt", key: srt.relPath, bytes: 10 };
    const vttUpload: BlobUploadResult = { url: "https://blob.example.com/add-entry.vtt", key: vtt.relPath, bytes: 10 };
    const uploads = new Map([
      [video.relPath, videoUpload],
      [srt.relPath, srtUpload],
      [vtt.relPath, vttUpload],
    ]);

    const stage = createStage(helpRoot);
    const { rewritten } = rewriteVideoLinksInStage(helpRoot, stage, [video, srt, vtt], uploads);

    expect(rewritten).toHaveLength(1);
    const stagedFile = join(stage, "content", "docs", "add-entry", "index.mdx");
    const text = readFileSync(stagedFile, "utf8");
    expect(text).toContain(`video: "${videoUpload.url}"`);
    expect(text).toContain(`srt: "${srtUpload.url}"`);
    expect(text).toContain(`vtt: "${vttUpload.url}"`);
    // Captions must never end up aliased to the video's own URL.
    expect(text).not.toContain(`srt: "${videoUpload.url}"`);
    expect(text).not.toContain(`vtt: "${videoUpload.url}"`);
  });

  it("stage dir lives under .aida/publish-stage and is overwritten on re-creation", () => {
    const helpRoot = makeHelpRoot();
    writePage(helpRoot, "add-entry");
    const stage1 = createStage(helpRoot);
    expect(stage1).toBe(stageDirFor(helpRoot));
    expect(existsSync(join(stage1, "content", "docs", "add-entry", "index.mdx"))).toBe(true);

    // Re-running createStage after the source page is removed clears stale stage content.
    writeFileSync(join(helpRoot, "content", "docs", "add-entry", "index.mdx"), "");
    const stage2 = createStage(helpRoot);
    expect(statSync(join(stage2, "content", "docs", "add-entry", "index.mdx")).size).toBe(0);
  });

  // Regression test (review finding): deploy() must be able to actually build/deploy from the
  // stage, so it has to be a full, buildable app directory — not just content/docs.
  it("stages the whole app (next.config.mjs etc.), not just content/docs", () => {
    const helpRoot = makeHelpRoot();
    const stage = createStage(helpRoot);
    expect(existsSync(join(stage, "next.config.mjs"))).toBe(true);
    // Unchanging/large trees are symlinked rather than copied, so staging stays cheap.
    expect(lstatSync(join(stage, "next.config.mjs")).isSymbolicLink()).toBe(true);
  });

  // Regression test (review finding): host config files apply() writes to helpRoot (vercel.json,
  // netlify.toml, ...) must show up in the stage too, since deploy() now runs from the stage.
  it("picks up a file apply() wrote to helpRoot, when created after apply()", () => {
    const helpRoot = makeHelpRoot();
    writeFileSync(join(helpRoot, "vercel.json"), '{"framework":"nextjs"}\n');
    const stage = createStage(helpRoot);
    expect(readFileSync(join(stage, "vercel.json"), "utf8")).toContain("nextjs");
  });
});

describe("dropStagedVideos", () => {
  it("removes only the uploaded video files from the stage, not the whole public/videos dir", () => {
    const helpRoot = makeHelpRoot();
    writeVideo(helpRoot, "public/videos/add-entry.mp4", 1000);
    writeFileSync(join(helpRoot, "public", "videos", "keep-me.txt"), "not a video");
    const video: StagedVideo = {
      absPath: join(helpRoot, "public", "videos", "add-entry.mp4"),
      relPath: join("public", "videos", "add-entry.mp4"),
      bytes: 1000,
    };
    const stage = createStage(helpRoot);
    expect(existsSync(join(stage, video.relPath))).toBe(true);

    dropStagedVideos(stage, [video]);

    expect(existsSync(join(stage, video.relPath))).toBe(false);
    expect(existsSync(join(stage, "public", "videos", "keep-me.txt"))).toBe(true);
    // Source is never touched.
    expect(existsSync(video.absPath)).toBe(true);
  });
});

describe("findCaptionsFor", () => {
  it("finds srt/vtt files next to the video, sharing its basename stem", () => {
    const helpRoot = makeHelpRoot();
    writeVideo(helpRoot, "public/videos/add-entry.mp4", 1000);
    writeFileSync(join(helpRoot, "public", "videos", "add-entry.srt"), "1\n00:00:00,000 --> 00:00:01,000\nHi\n");
    writeFileSync(join(helpRoot, "public", "videos", "add-entry.vtt"), "WEBVTT\n\n00:00.000 --> 00:01.000\nHi\n");
    const video: StagedVideo = {
      absPath: join(helpRoot, "public", "videos", "add-entry.mp4"),
      relPath: join("public", "videos", "add-entry.mp4"),
      bytes: 1000,
    };
    const captions = findCaptionsFor(helpRoot, video);
    expect(captions.map((c) => c.relPath).sort()).toEqual(
      [join("public", "videos", "add-entry.srt"), join("public", "videos", "add-entry.vtt")].sort(),
    );
  });

  it("returns nothing when no caption files exist", () => {
    const helpRoot = makeHelpRoot();
    writeVideo(helpRoot, "public/videos/add-entry.mp4", 1000);
    const video: StagedVideo = {
      absPath: join(helpRoot, "public", "videos", "add-entry.mp4"),
      relPath: join("public", "videos", "add-entry.mp4"),
      bytes: 1000,
    };
    expect(findCaptionsFor(helpRoot, video)).toEqual([]);
  });
});
