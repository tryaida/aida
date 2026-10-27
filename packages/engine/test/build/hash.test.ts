import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { manifestHash, readHashCache, sha256, stableStringify, writeHashCache } from "../../src/build/hash.js";

describe("stableStringify", () => {
  it("is insensitive to key order", () => {
    expect(stableStringify({ a: 1, b: 2 })).toBe(stableStringify({ b: 2, a: 1 }));
  });

  it("differs when a value changes", () => {
    expect(stableStringify({ a: 1 })).not.toBe(stableStringify({ a: 2 }));
  });

  it("sorts keys inside nested objects and arrays", () => {
    const a = { steps: [{ id: "x", say: "hi" }], meta: { z: 1, a: 2 } };
    const b = { meta: { a: 2, z: 1 }, steps: [{ say: "hi", id: "x" }] };
    expect(stableStringify(a)).toBe(stableStringify(b));
  });
});

describe("manifestHash", () => {
  it("is deterministic for identical manifests", () => {
    const manifest = { workflow: "add-x", baseUrl: "http://x", steps: [{ id: "step-1" }] };
    expect(manifestHash(manifest)).toBe(manifestHash(structuredClone(manifest)));
  });

  it("changes when manifest content changes", () => {
    const a = manifestHash({ workflow: "add-x", steps: [{ id: "step-1" }] });
    const b = manifestHash({ workflow: "add-x", steps: [{ id: "step-2" }] });
    expect(a).not.toBe(b);
  });

  it("ignores the deprecated volatile capturedAt field (fallback path)", () => {
    const a = manifestHash({ workflow: "add-x", capturedAt: "2026-01-01T00:00:00Z", steps: [] });
    const b = manifestHash({ workflow: "add-x", capturedAt: "2026-06-01T00:00:00Z", steps: [] });
    expect(a).toBe(b);
  });

  it("prefers capture's own stableHash export when present", () => {
    const manifest = { workflow: "add-x", steps: [] };
    const fakeCaptureModule = { stableHash: (_m: unknown) => "custom-hash-value" };
    expect(manifestHash(manifest, fakeCaptureModule)).toBe("custom-hash-value");
  });
});

describe("sha256", () => {
  it("is a 64-char hex digest", () => {
    expect(sha256("hello")).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("hash cache file", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "aida-hashcache-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("round-trips through read/write", () => {
    const file = path.join(dir, "nested", "hashes.json");
    writeHashCache(file, { pages: "abc123" });
    expect(readHashCache(file)).toEqual({ pages: "abc123" });
  });

  it("returns {} for a missing file", () => {
    expect(readHashCache(path.join(dir, "nope.json"))).toEqual({});
  });

  it("returns {} for a corrupt file", async () => {
    const file = path.join(dir, "bad.json");
    await (await import("node:fs/promises")).writeFile(file, "{not json");
    expect(readHashCache(file)).toEqual({});
  });
});
