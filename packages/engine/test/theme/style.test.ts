import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveArtifactBrand } from "../../src/render/brand.js";
import { defaultStyle, parseBrandNotes, radiusPx, readBrandNotes, resolveBrandStyle } from "../../src/theme/style.js";

describe("house style presets (M34)", () => {
  it("reads a radius in px, rem or bare numbers", () => {
    expect(radiusPx("10px")).toBe(10);
    expect(radiusPx("0.75rem")).toBe(12);
    expect(radiusPx("6")).toBe(6);
    expect(radiusPx("calc(1px + 2px)")).toBeUndefined();
  });

  it("picks the default from the app's corners and shadows", () => {
    expect(defaultStyle({ radius: "16px" })).toBe("friendly");
    expect(defaultStyle({ radius: "0.75rem", shadow: "strong" })).toBe("friendly");
    expect(defaultStyle({ radius: "2px" })).toBe("minimal");
    expect(defaultStyle({ radius: "8px", shadow: "none" })).toBe("minimal");
    expect(defaultStyle({ radius: "8px", shadow: "strong" })).toBe("bold");
    expect(defaultStyle({ radius: "8px" })).toBe("bold");
    expect(defaultStyle(undefined)).toBe("bold");
  });

  it("reads only style and tagline from brand.md's frontmatter", () => {
    const text = "---\nstyle: friendly\ntagline: \"Shows run smoother\"\nvoice: af_bella\n---\n# Acme\nWarm and plain.";
    expect(parseBrandNotes(text)).toEqual({ style: "friendly", tagline: "Shows run smoother" });
    expect(parseBrandNotes("---\nstyle: loud\n---\n")).toEqual({});
    expect(parseBrandNotes("# no frontmatter")).toEqual({});
  });

  it("config.brand.style beats brand.md beats the detected default", () => {
    expect(resolveBrandStyle({ style: "minimal", radius: "20px" }, { style: "bold" }).style).toBe("minimal");
    expect(resolveBrandStyle({ radius: "20px" }, { style: "bold" })).toMatchObject({ style: "bold", source: "brand.md" });
    expect(resolveBrandStyle({ radius: "20px" })).toMatchObject({ style: "friendly", source: "detected" });
  });

  it("finds brand.md next to the config and carries the preset into every artifact's brand", () => {
    const dir = mkdtempSync(join(tmpdir(), "aida-style-"));
    writeFileSync(join(dir, "brand.md"), "---\nstyle: minimal\ntagline: Acme help\n---\nNotes for agents.");
    expect(readBrandNotes({ configDir: dir })).toMatchObject({ style: "minimal", tagline: "Acme help" });
    const brand = resolveArtifactBrand({ configDir: dir, brand: { name: "Acme", radius: "20px" } });
    expect(brand.style).toBe("minimal");
    expect(brand.tagline).toBe("Acme help");
    // Neutral fallback still gets a preset.
    expect(resolveArtifactBrand({ configDir: mkdtempSync(join(tmpdir(), "aida-style-")) }).style).toBe("bold");
  });
});
