import { afterEach, describe, expect, it } from "vitest";
import { createDryRunBlobAdapter } from "../../src/publish/blob/dry-run.js";
import { createS3BlobAdapter } from "../../src/publish/blob/s3.js";
import { createVercelBlobAdapter } from "../../src/publish/blob/vercel-blob.js";
import { createR2BlobAdapter } from "../../src/publish/blob/r2.js";
import { createNetlifyBlobsAdapter } from "../../src/publish/blob/netlify-blobs.js";
import { getBlobAdapter, defaultBlobProviderFor, listBlobProviders } from "../../src/publish/blob/registry.js";
import { createFakeCommandRunner } from "../../src/publish/runner.js";
import { cleanupTmpDirs } from "./helpers.js";
import type { StagedVideo } from "../../src/publish/types.js";

afterEach(cleanupTmpDirs);

const video: StagedVideo = { absPath: "/tmp/does-not-matter.mp4", relPath: "public/videos/add-entry.mp4", bytes: 123 };

describe("dry-run blob adapter", () => {
  it("never calls a runner and returns a deterministic fake URL", async () => {
    const adapter = createDryRunBlobAdapter();
    const result = await adapter.upload(video, async () => {
      throw new Error("should never be called");
    });
    expect(result.url).toBe("https://dry-run.blob.local/public%2Fvideos%2Fadd-entry.mp4");
    expect(result.key).toBe(video.relPath);
    expect(result.bytes).toBe(123);
  });
});

describe("s3 blob adapter", () => {
  it("plans an `aws s3 cp` command naming the bucket from env", () => {
    const adapter = createS3BlobAdapter({ AIDA_S3_BUCKET: "my-bucket" });
    const [cmd] = adapter.plan(video);
    expect(cmd.cmd).toBe("aws");
    expect(cmd.args).toEqual(["s3", "cp", video.absPath, "s3://my-bucket/public/videos/add-entry.mp4", "--acl", "public-read"]);
  });

  it("upload() runs that exact command through the injected runner", async () => {
    const adapter = createS3BlobAdapter({ AIDA_S3_BUCKET: "my-bucket" });
    const { runner, calls } = createFakeCommandRunner({ code: 0, stdout: "", stderr: "" });
    const result = await adapter.upload(video, runner);
    expect(calls).toHaveLength(1);
    expect(calls[0].cmd).toBe("aws");
    expect(result.key).toBe(video.relPath);
    expect(result.url).toContain("my-bucket");
  });

  it("throws when the upload command fails", async () => {
    const adapter = createS3BlobAdapter({ AIDA_S3_BUCKET: "my-bucket" });
    const { runner } = createFakeCommandRunner({ code: 1, stdout: "", stderr: "access denied" });
    await expect(adapter.upload(video, runner)).rejects.toThrow(/access denied/);
  });

  it("envVars names only (no values) are advertised for the gate/secrets display", () => {
    const adapter = createS3BlobAdapter();
    expect(adapter.envVars).toEqual(["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AIDA_S3_BUCKET"]);
  });
});

// Regression tests (review finding): Vercel Blob's randomized URL suffix, R2's non-deterministic
// public URL, and Netlify Blobs' total lack of a public URL all mean `urlFor` must never guess —
// it must use what the upload actually returned, require explicit config, or refuse.
describe("vercel-blob adapter", () => {
  it("upload() parses the real URL from put()'s own JSON output, not a guessed shape", async () => {
    const adapter = createVercelBlobAdapter({ BLOB_READ_WRITE_TOKEN: "t" });
    const realUrl = "https://abc123.public.blob.vercel-storage.com/public/videos/add-entry-XyZ9.mp4";
    const { runner, calls } = createFakeCommandRunner({ code: 0, stdout: JSON.stringify({ url: realUrl }), stderr: "" });
    const result = await adapter.upload(video, runner);
    expect(calls).toHaveLength(1);
    expect(result.url).toBe(realUrl);
    // Never the old guessed shape (no random suffix, wrong host).
    expect(result.url).not.toBe(`https://blob.vercel-storage.com/${encodeURIComponent(video.relPath)}`);
  });

  it("throws clearly when the upload command doesn't print a parseable URL", async () => {
    const adapter = createVercelBlobAdapter({ BLOB_READ_WRITE_TOKEN: "t" });
    const { runner } = createFakeCommandRunner({ code: 0, stdout: "not json", stderr: "" });
    await expect(adapter.upload(video, runner)).rejects.toThrow(/parseable/);
  });
});

describe("r2 adapter", () => {
  it("refuses before uploading when AIDA_R2_PUBLIC_BASE_URL isn't set — no deterministic public URL to guess", async () => {
    const adapter = createR2BlobAdapter({ AIDA_R2_BUCKET: "my-bucket" });
    const { runner, calls } = createFakeCommandRunner();
    await expect(adapter.upload(video, runner)).rejects.toThrow(/AIDA_R2_PUBLIC_BASE_URL/);
    expect(calls).toHaveLength(0);
  });

  it("uses the configured publicBaseUrl once set", async () => {
    const adapter = createR2BlobAdapter({ AIDA_R2_BUCKET: "my-bucket", AIDA_R2_PUBLIC_BASE_URL: "https://videos.example.com/" });
    const { runner } = createFakeCommandRunner({ code: 0, stdout: "", stderr: "" });
    const result = await adapter.upload(video, runner);
    expect(result.url).toBe(`https://videos.example.com/${video.relPath}`);
  });
});

describe("netlify-blobs adapter", () => {
  it("always refuses — Netlify Blobs have no public URL at all", async () => {
    const adapter = createNetlifyBlobsAdapter({ NETLIFY_SITE_ID: "site" });
    const { runner, calls } = createFakeCommandRunner();
    await expect(adapter.upload(video, runner)).rejects.toThrow(/no public URL/);
    expect(calls).toHaveLength(0);
  });
});

describe("blob registry", () => {
  it("lists the five providers decisions #16/scope.md name", () => {
    expect(listBlobProviders().sort()).toEqual(["netlify-blobs", "r2", "s3", "supabase-storage", "vercel-blob"].sort());
  });

  it("dryRun: true always returns the dry-run adapter regardless of name", async () => {
    const adapter = getBlobAdapter("s3", { dryRun: true });
    const result = await adapter.upload(video, async () => {
      throw new Error("should never be called");
    });
    expect(result.url).toContain("dry-run.blob.local");
  });

  it("picks a sensible default blob provider per host", () => {
    expect(defaultBlobProviderFor("vercel")).toBe("vercel-blob");
    expect(defaultBlobProviderFor("netlify")).toBe("netlify-blobs");
    expect(defaultBlobProviderFor("cloudflare")).toBe("r2");
    expect(defaultBlobProviderFor("static")).toBe("s3");
  });
});
