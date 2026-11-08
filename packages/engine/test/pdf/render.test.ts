import { describe, expect, it } from "vitest";
import { footerTemplate, headerTemplate } from "../../src/pdf/render.js";
import { pdfTheme } from "../../src/pdf/html.js";
import { NEUTRAL_COLORS } from "../../src/render/brand.js";
import { contrastRatio } from "../../src/theme/color.js";

// Regression (review finding 7, decision 39): the footer's page number is real text on the page's
// white background, not a fill, so its colour — like html.ts's `--primary-text`/`--accent-text` —
// must reach 4.5:1. `footerTemplate` itself only guards against CSS injection (not contrast); the
// contrast fix is the *default* it falls back to, and what `pdf/build.ts`'s `chromeBrand` now
// passes in for `brand.color` (the text-safe `pdfTheme(...).colors.primaryText`, not the raw
// fill) — these tests cover both ends.
describe("footerTemplate (review finding pdf/render.ts: accessibility)", () => {
  it("falls back to a colour that reaches 4.5:1 on the page's white background when none is given", () => {
    const html = footerTemplate("Guide");
    expect(contrastRatio(NEUTRAL_COLORS.primaryText, "#ffffff")!).toBeGreaterThanOrEqual(4.5);
    expect(html).toContain(`color:${NEUTRAL_COLORS.primaryText};`);
  });

  it("rejects an unsafe brand colour value (CSS injection guard) and falls back to the text-safe default", () => {
    const html = footerTemplate("Guide", undefined, { color: "red;background:url(javascript:alert(1))" });
    expect(html).toContain(`color:${NEUTRAL_COLORS.primaryText};`);
  });

  it("prints whatever is passed as brand.color verbatim — callers, not this template, are responsible for contrast", () => {
    // A pale brand colour: a safe CSS value, but well under 4.5:1 on white.
    const pale = "#7dd3fc";
    expect(contrastRatio(pale, "#ffffff")!).toBeLessThan(4.5);
    expect(footerTemplate("Guide", undefined, { color: pale })).toContain(`color:${pale};`);

    // pdf/build.ts's `chromeBrand` passes the theme's text-safe variant instead, which does
    // clear 4.5:1 — this is the actual fix: the caller nudges the colour, not this template.
    const safe = pdfTheme({ colors: { primary: pale } }).colors.primaryText;
    expect(contrastRatio(safe, "#ffffff")!).toBeGreaterThanOrEqual(4.5);
    expect(footerTemplate("Guide", undefined, { color: safe })).toContain(`color:${safe};`);
  });
});

describe("headerTemplate", () => {
  it("still uses the raw brand colour for its (non-text) border rule", () => {
    const html = headerTemplate("Guide", { color: "#7dd3fc" });
    expect(html).toContain("border-bottom:0.75px solid #7dd3fc;");
  });
});
