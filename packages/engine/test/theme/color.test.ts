import { describe, expect, it } from "vitest";
import {
  contrastRatio,
  deriveDarkColor,
  isGrayish,
  isPale,
  parseColor,
  readableForeground,
  sameColor,
  toCssColor,
} from "../../src/theme/color.js";

describe("toCssColor", () => {
  it("wraps a bare HSL triplet and passes everything else through", () => {
    expect(toCssColor("235 55% 42%")).toBe("hsl(235 55% 42%)");
    expect(toCssColor(" 235  55%  42% / 0.5 ")).toBe("hsl(235 55% 42% / 0.5)");
    expect(toCssColor("235.5 55.2% 42%")).toBe("hsl(235.5 55.2% 42%)");
    expect(toCssColor("#4338ca")).toBe("#4338ca");
    expect(toCssColor("oklch(0.55 0.2 260)")).toBe("oklch(0.55 0.2 260)");
    expect(toCssColor("rgb(1, 2, 3)")).toBe("rgb(1, 2, 3)");
    expect(toCssColor("var(--x)")).toBe("var(--x)");
  });
});

describe("parseColor", () => {
  it("parses hex, rgb, hsl, bare triplets, oklch and named colours", () => {
    expect(parseColor("#fff")).toEqual({ r: 1, g: 1, b: 1, a: 1 });
    expect(parseColor("#00000080")!.a).toBeCloseTo(0.5, 2);
    expect(parseColor("rgb(255 0 0 / 50%)")).toEqual({ r: 1, g: 0, b: 0, a: 0.5 });
    expect(parseColor("rgba(0, 0, 255, 0.25)")).toEqual({ r: 0, g: 0, b: 1, a: 0.25 });
    const h = parseColor("hsl(120, 100%, 50%)")!;
    expect([h.r, h.g, h.b]).toEqual([0, 1, 0]);
    expect(parseColor("0 0% 100%")).toEqual({ r: 1, g: 1, b: 1, a: 1 });
    const white = parseColor("oklch(1 0 0)")!;
    expect(white.r).toBeCloseTo(1, 3);
    expect(white.b).toBeCloseTo(1, 3);
    const black = parseColor("oklch(0% 0 0)")!;
    expect(black.g).toBeCloseTo(0, 3);
    expect(parseColor("white")).toEqual({ r: 1, g: 1, b: 1, a: 1 });
    expect(parseColor("var(--x)")).toBeUndefined();
    expect(parseColor("color-mix(in oklab, red, blue)")).toBeUndefined();
    expect(parseColor("10px")).toBeUndefined();
  });
});

describe("contrast helpers", () => {
  it("computes WCAG contrast", () => {
    expect(contrastRatio("#000", "#fff")).toBeCloseTo(21, 1);
    expect(contrastRatio("#fff", "#fff")).toBeCloseTo(1, 5);
    expect(contrastRatio("var(--x)", "#fff")).toBeUndefined();
  });

  it("picks white on dark/saturated colours and dark ink on light ones", () => {
    expect(readableForeground("235 55% 42%")).toBe("hsl(0 0% 100%)");
    const ink = readableForeground("236 72% 71%");
    expect(ink).not.toBe("hsl(0 0% 100%)");
    expect(contrastRatio(ink, "236 72% 71%")!).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(readableForeground("#fde047"), "#fde047")!).toBeGreaterThanOrEqual(4.5);
    expect(readableForeground("var(--unknown)")).toBe("hsl(0 0% 100%)");
  });

  it("classifies pale fills and greys", () => {
    expect(isPale("232 40% 94%")).toBe(true);
    expect(isPale("235 55% 42%")).toBe(false);
    expect(isGrayish("0 0% 45%")).toBe(true);
    expect(isGrayish("183 68% 30%")).toBe(false);
    expect(sameColor("#ffffff", "0 0% 100%")).toBe(true);
    expect(sameColor("235 55% 42%", "183 68% 30%")).toBe(false);
  });
});

describe("deriveDarkColor", () => {
  it("lightens a dark brand colour until it carries on a near-black canvas, keeping the hue", () => {
    const d = deriveDarkColor("235 55% 42%");
    expect(d).toMatch(/^hsl\(235 /);
    expect(contrastRatio(d, "hsl(224 44% 7%)")!).toBeGreaterThanOrEqual(4.5);
  });

  it("keeps a colour that already carries, and uses color-mix() for ones it can't parse", () => {
    expect(deriveDarkColor("#fde047")).toBe("#fde047");
    expect(deriveDarkColor("var(--brand)")).toBe("color-mix(in oklab, var(--brand) 70%, white)");
  });
});
