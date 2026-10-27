import { describe, expect, it } from "vitest";
import { buildCardHtml, buildCoverHtml, buildPageHtml, buildTocHtml } from "../../src/pdf/html.js";
import type { CardStepInput, PdfPageInput } from "../../src/pdf/types.js";

function pageInput(overrides: Partial<PdfPageInput> = {}): PdfPageInput {
  return {
    id: "add-thing",
    title: "Add a thing",
    markdown: "# Add a thing\n\nDo the thing.\n",
    baseDir: "/tmp",
    passed: true,
    publishable: true,
    cardSteps: [],
    ...overrides,
  };
}

// Regression (review finding pdf/html.ts:166, also L59/L90/L117): titles, step text and reader
// names are interpolated into the print HTML Chromium renders straight off file://. Unescaped,
// an `<iframe src=file:///home/u/.env>` in any of these fields gets printed into the PDF as a
// live tag instead of inert text, and a plain "<" silently drops the rest of the line.
const IFRAME_PAYLOAD = '<iframe src="file:///home/u/.env"></iframe>';

describe("buildPageHtml", () => {
  it("escapes an iframe payload and a bare '<' in the page title", () => {
    const html = buildPageHtml(pageInput({ title: IFRAME_PAYLOAD }));
    expect(html).not.toContain("<iframe");
    expect(html).toContain("&lt;iframe");
  });

  it("escapes 'a < b' instead of dropping it", () => {
    const html = buildPageHtml(pageInput({ title: "a < b" }));
    expect(html).toContain("a &lt; b");
  });

  it("emits a Content-Security-Policy meta tag blocking scripts/frames/remote loads by default", () => {
    const html = buildPageHtml(pageInput());
    expect(html).toMatch(/<meta http-equiv="Content-Security-Policy"/);
    expect(html).toMatch(/frame-src 'none'/);
    expect(html).toMatch(/script-src 'none'/);
    expect(html).not.toMatch(/img-src[^;]*https:/);
  });

  it("allows https: in the CSP img-src only when allowRemoteImages is set", () => {
    const html = buildPageHtml(pageInput(), undefined, true);
    expect(html).toMatch(/img-src[^;]*https:/);
  });
});

describe("buildCoverHtml", () => {
  it("escapes an iframe payload in the cover title", () => {
    const html = buildCoverHtml(IFRAME_PAYLOAD, "2026-10-22");
    expect(html).not.toContain("<iframe");
    expect(html).toContain("&lt;iframe");
  });
});

describe("buildTocHtml", () => {
  it("escapes an iframe payload in a reader name and a walkthrough title", () => {
    const html = buildTocHtml([{ title: IFRAME_PAYLOAD, reader: IFRAME_PAYLOAD }]);
    expect(html).not.toContain("<iframe");
    expect(html).toContain("&lt;iframe");
  });
});

describe("buildCardHtml", () => {
  it("escapes an iframe payload in a card step's caption text", () => {
    const steps: CardStepInput[] = [{ number: 1, title: "Step 1", text: IFRAME_PAYLOAD }];
    const html = buildCardHtml("Card title", steps, undefined, {});
    expect(html).not.toContain("<iframe");
    expect(html).toContain("&lt;iframe");
  });

  it("escapes an iframe payload in the card title", () => {
    const html = buildCardHtml(IFRAME_PAYLOAD, [], undefined, {});
    expect(html).not.toContain("<iframe");
    expect(html).toContain("&lt;iframe");
  });
});

describe("brand in the print HTML", () => {
  const brand = {
    name: "Acme Events",
    colors: { primary: "hsl(235 55% 42%)", accent: "hsl(183 68% 30%)" },
    font: "Inter",
    fontUrl: "https://fonts.googleapis.com/css2?family=Inter:wght@400;700",
    logoSrc: "data:image/png;base64,AAAA",
  };

  it("sets the brand colours and font as CSS variables, and loads the webfont under a scoped CSP", () => {
    const html = buildPageHtml(pageInput(), brand);
    expect(html).toContain("--primary: hsl(235 55% 42%)");
    expect(html).toContain("--accent: hsl(183 68% 30%)");
    expect(html).toContain('"Inter", system-ui');
    expect(html).toContain('<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;700">');
    expect(html).toMatch(/style-src 'unsafe-inline' https:\/\/fonts\.googleapis\.com;/);
    expect(html).toMatch(/font-src file: data: https:;/);
    expect(html).toMatch(/script-src 'none'/);
  });

  it("falls back to the neutral palette and no font link without a brand", () => {
    const html = buildPageHtml(pageInput());
    expect(html).toContain("--primary: hsl(235 55% 42%)");
    expect(html).not.toContain("<link");
    expect(html).toMatch(/font-src file: data:;/);
  });

  it("turns 'N. Title' step headings into number badges", () => {
    const html = buildPageHtml(pageInput({ markdown: "# T\n\nSummary.\n\n#### 2. Click Save\n\nClick it.\n" }));
    expect(html).toContain('<h4 class="step-h"><span class="step-num">2</span><span>Click Save</span></h4>');
    expect(html).toContain('<p class="lede">Summary.</p>');
  });

  it("puts the logo, product name, title and date on the manual cover", () => {
    const html = buildCoverHtml("Help guide", "2026-10-26", brand, { guideCount: 4 });
    expect(html).toContain("data:image/png;base64,AAAA");
    expect(html).toContain("Acme Events");
    expect(html).toContain("Help guide");
    expect(html).toContain("26 October 2026");
    expect(html).toContain("@page { margin: 0; }");
  });

  it("brands the quick-reference card's header strip", () => {
    const html = buildCardHtml("Record a payment", [{ number: 1, title: "Open", text: "Open it." }], brand, {});
    expect(html).toContain('class="strip"');
    expect(html).toContain("Quick reference");
    expect(html).toContain("Acme Events");
    expect(html).toContain("data:image/png;base64,AAAA");
  });

  it("uses the walkthrough's product name on the card when the brand has none", () => {
    const html = buildCardHtml("Record a payment", [], undefined, { productName: "Widget" });
    expect(html).toContain("<span>Widget</span>");
  });

  it("groups the contents by library section when walkthroughs have one", () => {
    const html = buildTocHtml([
      { title: "Record a payment", reader: "Office staff", section: "Payments / Fees", summary: "Take a fee.", page: 3 },
      { title: "Add a competitor", reader: "Office staff", page: 5 },
    ]);
    expect(html).toContain("<h2><span>Payments › Fees</span>");
    expect(html).toContain("<h2><span>Office staff</span>");
    expect(html).toContain('<p class="toc-sum">Take a fee.</p>');
  });
});
