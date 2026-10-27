import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  NEUTRAL_COLORS,
  brandFingerprint,
  cssColor,
  resolveArtifactBrand,
  safeFontUrl,
  timelineBrand,
} from "../../src/render/brand.js";
import { buildTimeline } from "../../src/render/timeline.js";
import { computeSceneHash } from "../../src/render/segments.js";
import type { CaptureManifest } from "../../src/capture/index.js";
import type { Walkthrough } from "../../src/walkthrough/types.js";

const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

const dirs: string[] = [];
afterEach(async () => {
  while (dirs.length) await rm(dirs.pop()!, { recursive: true, force: true });
});
async function tmp(): Promise<string> {
  const d = await mkdtemp(path.join(os.tmpdir(), "aida-brand-"));
  dirs.push(d);
  return d;
}

describe("cssColor", () => {
  it("wraps a bare HSL triplet and passes other CSS colours through", () => {
    expect(cssColor("235 55% 42%")).toBe("hsl(235 55% 42%)");
    expect(cssColor("#4338ca")).toBe("#4338ca");
    expect(cssColor("oklch(0.55 0.2 270)")).toBe("oklch(0.55 0.2 270)");
  });

  it("rejects values that could break out of a CSS declaration", () => {
    expect(cssColor("red; } body { display: none")).toBeUndefined();
    expect(cssColor('red" onload="x')).toBeUndefined();
    expect(cssColor("")).toBeUndefined();
  });
});

describe("safeFontUrl", () => {
  it("accepts https only", () => {
    expect(safeFontUrl("https://fonts.googleapis.com/css2?family=Inter")).toBe("https://fonts.googleapis.com/css2?family=Inter");
    expect(safeFontUrl("http://fonts.example.com/x.css")).toBeUndefined();
    expect(safeFontUrl("file:///etc/passwd")).toBeUndefined();
  });
});

describe("resolveArtifactBrand", () => {
  it("falls back to the neutral palette when nothing is configured", () => {
    const b = resolveArtifactBrand({ configDir: "/x" });
    expect(b.configured).toBe(false);
    expect(b.colors).toEqual(NEUTRAL_COLORS);
    expect(b.name).toBeUndefined();
  });

  it("resolves colours (primaryColor/accentColor win over colors.*), font and logo paths", () => {
    const b = resolveArtifactBrand({
      configDir: "/app",
      brand: {
        name: "Acme Events",
        primaryColor: "235 55% 42%",
        colors: { primary: "#000000", accent: "183 68% 30%", foreground: "#111111" },
        logo: "public/logo.png",
        logoDark: "public/logo-white.png",
        font: "Inter",
        fontUrl: "https://fonts.googleapis.com/css2?family=Inter",
      },
    });
    expect(b.configured).toBe(true);
    expect(b.name).toBe("Acme Events");
    expect(b.colors.primary).toBe("hsl(235 55% 42%)");
    expect(b.colors.accent).toBe("hsl(183 68% 30%)");
    expect(b.colors.foreground).toBe("#111111");
    expect(b.logoPath).toBe("/app/public/logo.png");
    expect(b.logoDarkPath).toBe("/app/public/logo-white.png");
    expect(b.font).toBe("Inter");
    expect(b.fontUrl).toMatch(/^https:/);
  });

  it("uses the primary as accent when only a primary is set (stays monochrome)", () => {
    const b = resolveArtifactBrand({ configDir: "/app", brand: { primaryColor: "#7c3aed" } });
    expect(b.colors.accent).toBe("#7c3aed");
  });
});

describe("timelineBrand", () => {
  it("inlines logoDark (preferred) as a data URL and carries colours + font", async () => {
    const dir = await tmp();
    await writeFile(path.join(dir, "logo.png"), TINY_PNG);
    await writeFile(path.join(dir, "logo-dark.png"), TINY_PNG);
    const brand = resolveArtifactBrand({
      configDir: dir,
      brand: { name: "Acme", primaryColor: "#123456", logo: "logo.png", logoDark: "logo-dark.png", font: "Inter" },
    });
    const tb = timelineBrand(brand);
    expect(tb.name).toBe("Acme");
    expect(tb.logoSrc).toMatch(/^data:image\/png;base64,/);
    expect(tb.logoForDark).toBe(true);
    expect(tb.colors?.primary).toBe("#123456");
    expect(tb.font).toBe("Inter");
  });

  it("prefers the walkthrough's product name, and is just a name without a brand", () => {
    expect(timelineBrand(undefined, "Widget")).toEqual({ name: "Widget" });
    const brand = resolveArtifactBrand({ configDir: "/x", brand: { name: "Acme" } });
    expect(timelineBrand(brand, "Widget").name).toBe("Widget");
    expect(timelineBrand(brand).name).toBe("Acme");
  });

  it("skips a missing logo file rather than failing", () => {
    const brand = resolveArtifactBrand({ configDir: "/nonexistent", brand: { logo: "nope.png" } });
    expect(timelineBrand(brand).logoSrc).toBeUndefined();
  });
});

describe("brandFingerprint", () => {
  it("changes when a logo file is replaced in place", async () => {
    const dir = await tmp();
    const logo = path.join(dir, "logo.png");
    await writeFile(logo, TINY_PNG);
    const brand = resolveArtifactBrand({ configDir: dir, brand: { logo: "logo.png" } });
    const before = JSON.stringify(brandFingerprint(brand));
    await writeFile(logo, Buffer.concat([TINY_PNG, Buffer.from("x")]));
    expect(JSON.stringify(brandFingerprint(brand))).not.toBe(before);
  });
});

describe("brand in the video timeline", () => {
  const wf: Walkthrough = {
    walkthrough: "demo",
    title: "Demo",
    steps: [{ id: "s1", title: "One", say: "x", camera: "full", actions: [] }],
  };
  const manifest: CaptureManifest = {
    workflow: "demo",
    capturedAt: "2026-01-01T00:00:00.000Z",
    baseUrl: "http://localhost",
    viewport: { width: 1440, height: 810 },
    deviceScaleFactor: 1,
    steps: [
      {
        id: "s1",
        camera: "full",
        cameraBox: null,
        events: [{ type: "frame", image: "f1.png", transition: "cut" }],
        doc: { image: "f1.png", highlights: [] },
        impact: { urls: [], requests: [] },
        checks: [],
      },
    ],
  };
  const narration = {
    intro: { audioPath: "/v/intro.wav", durationMs: 1000 },
    s1: { audioPath: "/v/s1.wav", durationMs: 1000 },
    outro: { audioPath: "/v/outro.wav", durationMs: 1000 },
  };

  it("defaults the intro eyebrow to 'How to' and puts the brand on the timeline", () => {
    const brand = resolveArtifactBrand({ configDir: "/x", brand: { name: "Acme", primaryColor: "#123456" } });
    const tl = buildTimeline(wf, manifest, narration, { fps: 10, brand });
    expect(tl.intro.eyebrow).toBe("How to");
    expect(tl.brand.name).toBe("Acme");
    expect(tl.brand.colors?.primary).toBe("#123456");
  });

  it("re-renders every scene when the brand changes (brand is part of each scene's hash)", async () => {
    const dir = await tmp();
    const assets = path.join(dir, "bundle");
    await mkdir(assets, { recursive: true });
    for (const f of ["index.html", "player.js", "player.css"]) await writeFile(path.join(assets, f), f);
    const settings = { fps: 10, crf: 17, preset: "slow", draft: false };
    const a = buildTimeline(wf, manifest, narration, { fps: 10, brand: resolveArtifactBrand({ configDir: "/x", brand: { primaryColor: "#123456" } }) });
    const b = buildTimeline(wf, manifest, narration, { fps: 10, brand: resolveArtifactBrand({ configDir: "/x", brand: { primaryColor: "#654321" } }) });
    for (const scene of a.scenes!) {
      expect(computeSceneHash(a, scene, assets, settings, {})).not.toBe(computeSceneHash(b, scene, assets, settings, {}));
    }
  });
});

describe("resolveArtifactBrand: theme alignment with the help app", () => {
  it("ignores a pale shadcn-style accent (a hover tint, not a brand colour) and derives a readable foreground", () => {
    const b = resolveArtifactBrand({ configDir: "/x", brand: { colors: { primary: "#facc15", accent: "210 40% 96%" } } });
    expect(b.colors.accent).toBe("#facc15");
    expect(b.colors.primaryForeground).not.toBe("hsl(0 0% 100%)"); // white on yellow is unreadable
  });

  it("derives a Google Fonts URL for a known family when fontUrl is unset (same as the site)", () => {
    const b = resolveArtifactBrand({ configDir: "/x", brand: { font: "Inter" } });
    expect(b.fontUrl).toMatch(/^https:\/\/fonts\.googleapis\.com\/css2\?family=Inter/);
  });
});
