// M34: the house style preset reaches print — the body class every style rule hangs off, the
// cover layout (dark band / quiet light page / rounded panel on a tint), the browser bar framing
// full-screen shots in bold, and titles still escaped on the new covers.
import { describe, expect, it } from "vitest";
import { buildCoverHtml, buildPageHtml, pdfTheme } from "../../src/pdf/html.js";
import type { PdfPageInput } from "../../src/pdf/types.js";

const input: PdfPageInput = {
  id: "add-order",
  title: "Add an order",
  markdown: "# Add an order\n\nCreate an order.\n",
  baseDir: "/tmp",
  passed: true,
  publishable: true,
  cardSteps: [],
};

describe("print presets", () => {
  it("defaults to bold and tags the body with the preset", () => {
    expect(pdfTheme(undefined).style).toBe("bold");
    expect(buildPageHtml(input)).toContain('<body class="style-bold">');
    expect(buildPageHtml(input, { style: "minimal" })).toContain('<body class="style-minimal">');
    expect(buildPageHtml(input, { style: "friendly" })).toMatch(/\.style-friendly \.ring \{[^}]*border-radius: 999pt/);
    expect(buildPageHtml(input, { style: "bold" })).toMatch(/\.style-bold \.shot-full \.shot-bar \{ display: flex/);
  });

  it("lays the cover out per preset", () => {
    const bold = buildCoverHtml("Acme guide", "2026-10-27", { name: "Acme" });
    const minimal = buildCoverHtml("Acme guide", "2026-10-27", { name: "Acme", style: "minimal", tagline: "Help for busy days" });
    const friendly = buildCoverHtml("Acme guide", "2026-10-27", { name: "Acme", style: "friendly" }, { heroImage: "/tmp/hero.png" });
    expect(bold).toContain('class="band"');
    expect(minimal).toContain("v-minimal");
    expect(minimal).toContain("Help for busy days");
    expect(minimal).not.toContain('class="band"');
    expect(friendly).toContain("v-friendly");
    expect(friendly).toContain('class="hero"');
  });

  it("escapes the title on the light covers too", () => {
    const html = buildCoverHtml('<iframe src="file:///x"></iframe>', "2026-10-27", { style: "friendly" });
    expect(html).not.toContain("<iframe");
  });
});
