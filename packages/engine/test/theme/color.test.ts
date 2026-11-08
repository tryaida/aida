import { describe, expect, it } from "vitest";
import {
  contrastRatio,
  deriveDarkColor,
  isGrayish,
  isPale,
  mixColors,
  parseColor,
  readableForeground,
  sameColor,
  textSafeVariant,
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

describe("mixColors", () => {
  it("averages channels at t=0.5", () => {
    expect(mixColors("#000000", "#ffffff", 0.5)).toBe("rgb(128 128 128)");
  });

  it("returns `a` at t=0 and `b` at t=1", () => {
    expect(mixColors("#112233", "#ffffff", 0)).toBe("rgb(17 34 51)");
    expect(mixColors("#112233", "#ffffff", 1)).toBe("rgb(255 255 255)");
  });

  it("clamps an out-of-range t", () => {
    expect(mixColors("#000000", "#ffffff", 2)).toBe("rgb(255 255 255)");
    expect(mixColors("#000000", "#ffffff", -1)).toBe("rgb(0 0 0)");
  });

  it("returns `a` unparsed when either colour can't be read", () => {
    expect(mixColors("var(--x)", "#ffffff", 0.5)).toBe("var(--x)");
  });
});

describe("textSafeVariant", () => {
  it("leaves an already-readable colour alone, just normalised", () => {
    expect(textSafeVariant("235 55% 42%", "#ffffff")).toBe("hsl(235 55% 42%)");
    expect(contrastRatio("235 55% 42%", "#ffffff")!).toBeGreaterThanOrEqual(4.5);
  });

  it("darkens a pale brand colour (sky-300-ish) until it reaches 4.5:1 on white, keeping the hue", () => {
    expect(contrastRatio("#7dd3fc", "#ffffff")!).toBeLessThan(4.5); // the untouched colour fails
    const safe = textSafeVariant("#7dd3fc", "#ffffff");
    expect(contrastRatio(safe, "#ffffff")!).toBeGreaterThanOrEqual(4.5);
    expect(safe).toMatch(/^hsl\(19[0-9]/); // same cyan-blue hue family as #7dd3fc (~198deg)
  });

  it("lightens a dark brand colour until it reaches 4.5:1 on a near-black background", () => {
    const dark = "#1e3a8a"; // a dark blue that already carries on white, but not on near-black
    expect(contrastRatio(dark, "#0a0a0a")!).toBeLessThan(4.5);
    const safe = textSafeVariant(dark, "#0a0a0a");
    expect(contrastRatio(safe, "#0a0a0a")!).toBeGreaterThanOrEqual(4.5);
  });

  it("a mid colour where white text would fail 4.5 still reaches it by going darker", () => {
    // A mid-lightness amber: white-on-this fails 4.5 (it's not dark enough), so the safe variant
    // has to move toward black, not white, to pass.
    const mid = "hsl(38 92% 55%)";
    expect(contrastRatio("#ffffff", mid)!).toBeLessThan(4.5);
    const safe = textSafeVariant(mid, "#ffffff");
    expect(contrastRatio(safe, "#ffffff")!).toBeGreaterThanOrEqual(4.5);
    expect(safe).toMatch(/^hsl\(38 /); // hue kept
  });

  it("satisfies every background at once when given more than one", () => {
    const safe = textSafeVariant("#7dd3fc", ["#ffffff", "hsl(0 0% 94%)"]);
    expect(contrastRatio(safe, "#ffffff")!).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(safe, "hsl(0 0% 94%)")!).toBeGreaterThanOrEqual(4.5);
  });

  it("passes unparseable colours through unchanged", () => {
    expect(textSafeVariant("var(--x)", "#ffffff")).toBe("var(--x)");
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
