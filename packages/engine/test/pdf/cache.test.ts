import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cacheSidecarPath, matchesCache, pdfInputHash, writeCacheSidecar } from "../../src/pdf/cache.js";

const dirs: string[] = [];
afterEach(async () => {
  while (dirs.length) await rm(dirs.pop()!, { recursive: true, force: true });
});

async function tmpDir(): Promise<string> {
  const d = await mkdtemp(path.join(os.tmpdir(), "aida-pdf-cache-"));
  dirs.push(d);
  return d;
}

describe("pdfInputHash", () => {
  it("is deterministic for identical inputs", () => {
    const a = pdfInputHash({ markdown: "hello", screenshots: [], paper: "A4" });
    const b = pdfInputHash({ markdown: "hello", screenshots: [], paper: "A4" });
    expect(a).toBe(b);
  });

  it("changes when the markdown changes", () => {
    const a = pdfInputHash({ markdown: "hello", screenshots: [], paper: "A4" });
    const b = pdfInputHash({ markdown: "goodbye", screenshots: [], paper: "A4" });
    expect(a).not.toBe(b);
  });

  it("changes when the paper size changes", () => {
    const a = pdfInputHash({ markdown: "hello", screenshots: [], paper: "A4" });
    const b = pdfInputHash({ markdown: "hello", screenshots: [], paper: "Letter" });
    expect(a).not.toBe(b);
  });

  it("changes when a referenced screenshot's fingerprint changes", async () => {
    const dir = await tmpDir();
    const file = path.join(dir, "step-01.png");
    await writeFile(file, "a");
    const a = pdfInputHash({ markdown: "hello", screenshots: [file], paper: "A4" });
    await writeFile(file, "ab");
    const b = pdfInputHash({ markdown: "hello", screenshots: [file], paper: "A4" });
    expect(a).not.toBe(b);
  });
});

describe("cache sidecar", () => {
  it("matches only when every output file has a sidecar with the same hash", async () => {
    const dir = await tmpDir();
    const file = path.join(dir, "add-thing.pdf");
    await writeFile(file, "pdf-bytes");
    expect(matchesCache([file], "abc")).toBe(false);

    writeCacheSidecar(file, "abc");
    expect(existsSync(cacheSidecarPath(file))).toBe(true);
    expect(matchesCache([file], "abc")).toBe(true);
    expect(matchesCache([file], "different")).toBe(false);
  });

  it("is false when the output file itself is missing even if a stale sidecar exists", async () => {
    const dir = await tmpDir();
    const file = path.join(dir, "missing.pdf");
    writeCacheSidecar(file, "abc");
    expect(matchesCache([file], "abc")).toBe(false);
  });
});
