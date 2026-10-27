// Manifest stability: the app assigns a fresh UUID to every competitor/entry it creates, so two
// captures of the same walkthrough against the same app state produce a manifest.json that
// differs byte-for-byte wherever one of those ids shows up (impact urls/requests, finalUrl, a
// database check's returned row) — stableHash() must hash the same regardless.
import { describe, expect, it } from "vitest";
import { stableHash } from "../../src/capture/stable-hash.js";
import type { CaptureManifest } from "../../src/capture/types.js";

function manifestWithUrl(url: string): CaptureManifest {
  return {
    workflow: "wf",
    baseUrl: "http://127.0.0.1:3100",
    viewport: { width: 1440, height: 810 },
    deviceScaleFactor: 2,
    finalUrl: url,
    steps: [
      {
        id: "s1",
        camera: "full",
        cameraBox: null,
        events: [],
        doc: { image: null, highlights: [] },
        impact: { urls: [url], requests: [{ method: "GET", path: url }] },
        checks: [],
      },
    ],
  };
}

describe("stableHash", () => {
  it("hashes identically when only an embedded UUID differs between two runs", () => {
    const a = manifestWithUrl("/dashboard/entries/success/3f29b1a2-7c4e-4a9b-9d3e-6b2c1a0f9e8d");
    const b = manifestWithUrl("/dashboard/entries/success/9e8d7c6b-5a4f-4b3c-8d2e-1f0a9b8c7d6e");
    expect(stableHash(a)).toBe(stableHash(b));
  });

  it("is case-insensitive for the UUID itself", () => {
    const a = manifestWithUrl("/entries/3F29B1A2-7C4E-4A9B-9D3E-6B2C1A0F9E8D");
    const b = manifestWithUrl("/entries/9e8d7c6b-5a4f-4b3c-8d2e-1f0a9b8c7d6e");
    expect(stableHash(a)).toBe(stableHash(b));
  });

  it("still differs when something other than a UUID changes", () => {
    const a = manifestWithUrl("/dashboard/competitors");
    const b = manifestWithUrl("/dashboard/entries");
    expect(stableHash(a)).not.toBe(stableHash(b));
  });

  it("is a pure function of content, not identity (equal input -> equal hash)", () => {
    const a = manifestWithUrl("/dashboard/competitors");
    const b = manifestWithUrl("/dashboard/competitors");
    expect(stableHash(a)).toBe(stableHash(b));
  });
});
