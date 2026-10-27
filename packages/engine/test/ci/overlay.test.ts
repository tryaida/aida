import { describe, expect, it } from "vitest";
import { PNG } from "pngjs";
import { buildDiffOverlay } from "../../src/ci/overlay.js";
import { solidPng } from "./helpers.js";

describe("ci/overlay buildDiffOverlay", () => {
  it("returns the after image unchanged when before === after", () => {
    const img = solidPng(3, 3, [10, 20, 30]);
    const overlay = buildDiffOverlay(img, img, 10);
    const png = PNG.sync.read(overlay);
    expect(png.data.slice(0, 4)).toEqual(Buffer.from([10, 20, 30, 255]));
  });

  it("tints changed pixels red-ish while keeping dimensions", () => {
    const before = solidPng(2, 2, [0, 0, 0]);
    const after = solidPng(2, 2, [255, 255, 255]);
    const overlay = buildDiffOverlay(before, after, 10);
    const png = PNG.sync.read(overlay);
    expect(png.width).toBe(2);
    expect(png.height).toBe(2);
    // Tinted toward the red TINT colour, not plain white.
    expect(png.data[0]).toBeGreaterThan(200); // red channel high
    expect(png.data[2]).toBeLessThan(255); // blue channel pulled down from white
  });

  it("falls back to the after image when dimensions mismatch", () => {
    const before = solidPng(2, 2, [0, 0, 0]);
    const after = solidPng(3, 3, [255, 255, 255]);
    const overlay = buildDiffOverlay(before, after, 10);
    expect(overlay).toEqual(after);
  });
});
