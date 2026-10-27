// M32 (decision 36): print layout decisions — focus crop vs full screen, ring placement, split vs
// stacked steps, the single-part heading, the QR code, the card grid and font-face parsing.
import { describe, expect, it } from "vitest";
import {
  buildCardHtml,
  buildPageHtml,
  cardLayout,
  figureView,
  isSinglePart,
  printMode,
  stepLayout,
  SPLIT_TEXT_MAX_CHARS,
} from "../../src/pdf/html.js";
import { guideUrl, qrSvg } from "../../src/pdf/qr.js";
import { fontFaceCss, parseFontFaces } from "../../src/pdf/fonts.js";
import type { CardStepInput, PdfPageInput, PrintFigure } from "../../src/pdf/types.js";

function figure(over: Partial<PrintFigure> = {}): PrintFigure {
  return {
    step: 2,
    full: "/tmp/acme/print/step-02.full.png",
    crop: "/tmp/acme/print/step-02.crop.png",
    cropBox: { x: 800, y: 0, w: 560, h: 350 },
    viewport: { width: 1440, height: 810 },
    targets: [{ x: 1100, y: 100, w: 150, h: 40 }],
    callouts: [],
    newScreen: false,
    ...over,
  };
}

describe("figureView / printMode", () => {
  it("prints the crop for a step on a screen the reader has seen, the full screen for a new one", () => {
    expect(printMode(figure())).toBe("crop");
    expect(printMode(figure({ newScreen: true }))).toBe("full");
    expect(printMode(figure({ crop: undefined, cropBox: undefined }))).toBe("full");
  });

  it("maps a target (plus its ring padding) into the crop's percentages", () => {
    const v = figureView(figure(), "crop");
    expect(v.src).toContain("crop.png");
    expect(v.aspect).toBeCloseTo(1.6, 2);
    expect(v.rings).toHaveLength(1);
    const r = v.rings[0];
    expect(r.left).toBeCloseTo(((1100 - 8 - 800) / 560) * 100, 1);
    expect(r.top).toBeCloseTo(((100 - 8) / 350) * 100, 1);
    expect(r.width).toBeCloseTo(((150 + 16) / 560) * 100, 1);
  });

  it("maps the same target against the whole viewport in full mode", () => {
    const v = figureView(figure(), "full");
    expect(v.src).toContain("full.png");
    expect(v.rings[0].left).toBeCloseTo(((1100 - 8) / 1440) * 100, 1);
  });

  it("drops a target that falls outside the crop", () => {
    const v = figureView(figure({ targets: [{ x: 10, y: 600, w: 50, h: 20 }] }), "crop");
    expect(v.rings).toEqual([]);
  });
});

describe("stepLayout", () => {
  it("puts a short step beside its focus crop, a long one above it, and a full screen stacked", () => {
    expect(stepLayout(figure(), 80)).toBe("split");
    expect(stepLayout(figure(), SPLIT_TEXT_MAX_CHARS + 1)).toBe("stack");
    expect(stepLayout(figure({ newScreen: true }), 80)).toBe("stack");
    expect(stepLayout(undefined, 80)).toBe("stack");
  });
});

const MARKDOWN_ONE_PART = `# Add an order

Create an order for a customer.

## Before you start

- Sign in as **sales staff**.

## Steps

### Part 1: Add the order

#### 1. Open Orders

Click **Orders**.

#### 2. New order

Click **New order**.

## Good to know

- Orders save as drafts.

---

*Steps verified against the real app on 2026-10-20.*
`;

function pageInput(over: Partial<PdfPageInput> = {}): PdfPageInput {
  return {
    id: "add-an-order",
    title: "Add an order",
    markdown: MARKDOWN_ONE_PART,
    baseDir: "/tmp",
    passed: true,
    publishable: true,
    cardSteps: [
      { number: 1, title: "Open Orders", text: "Click Orders." },
      { number: 2, title: "New order", text: "Click New order." },
    ],
    sitePath: "/how-do-i/orders/add-an-order",
    ...over,
  };
}

describe("buildPageHtml layout", () => {
  it("drops the 'Part 1' heading when the guide has only one part", () => {
    expect(isSinglePart(buildPageHtml(pageInput()))).toBe(false);
    expect(buildPageHtml(pageInput())).not.toContain("Part 1: Add the order");
  });

  it("keeps part headings when there are several", () => {
    const md = MARKDOWN_ONE_PART.replace("#### 2. New order", "### Part 2: Save it\n\n#### 2. New order");
    const html = buildPageHtml(pageInput({ markdown: md }));
    expect(html).toContain("Part 1: Add the order");
    expect(html).toContain("Part 2: Save it");
  });

  it("boxes 'Before you start' and 'Good to know', and sets the verified line as a footnote", () => {
    const html = buildPageHtml(pageInput());
    expect(html).toMatch(/<section class="box box-before"><h2>Before you start<\/h2>/);
    expect(html).toMatch(/<section class="box box-note"><h2>Good to know<\/h2>/);
    expect(html).toContain('<p class="verified">Steps verified against the real app on 2026-10-20.</p>');
  });

  it("wraps each step as one unbreakable block with its number badge", () => {
    const html = buildPageHtml(pageInput());
    expect(html.match(/<div class="step stack">/g)).toHaveLength(2);
    expect(html).toContain('<span class="step-num">2</span>');
    expect(html).toMatch(/\.step \{ break-inside: avoid;/);
  });

  it("adds a QR code to the guide's page only when a site URL is known", () => {
    expect(buildPageHtml(pageInput())).not.toContain('class="qr"');
    const html = buildPageHtml(pageInput(), undefined, false, { siteUrl: "https://help.example.com" });
    expect(html).toContain('class="gh-qr"');
    expect(html).toContain("<svg class=\"qr\"");
  });

  it("swaps a step's site screenshot for its print figure, with a vector ring and badge", () => {
    const md = MARKDOWN_ONE_PART.replace("Click **New order**.", "Click **New order**.\n\n![New order](screenshots/step-02.png)");
    const html = buildPageHtml(pageInput({ markdown: md, figures: [figure()] }));
    expect(html).toContain('<div class="step split">');
    expect(html).toContain("file:///tmp/acme/print/step-02.crop.png");
    expect(html).not.toContain("screenshots/step-02.png");
    expect(html).toContain('class="ring"');
    expect(html).toMatch(/class="pin"[^>]*>2</);
  });
});

describe("guideUrl / qrSvg", () => {
  it("joins the site root and the guide path, keeping a sub-path", () => {
    expect(guideUrl("https://help.example.com", "/how-do-i/x")).toBe("https://help.example.com/how-do-i/x");
    expect(guideUrl("https://example.com/help/", "/how-do-i/x")).toBe("https://example.com/help/how-do-i/x");
  });

  it("refuses anything that isn't an absolute http(s) URL", () => {
    expect(guideUrl(undefined, "/x")).toBeUndefined();
    expect(guideUrl("javascript:alert(1)", "/x")).toBeUndefined();
    expect(guideUrl("help.example.com", "/x")).toBeUndefined();
  });

  it("draws a QR code as a single vector path", () => {
    const svg = qrSvg("https://help.example.com/how-do-i/x");
    expect(svg).toMatch(/^<svg class="qr"/);
    expect(svg.match(/<path /g)).toHaveLength(1);
  });
});

describe("cardLayout", () => {
  it("fills one page for short guides, two balanced pages for long ones, and cuts off past that", () => {
    expect(cardLayout(2)).toMatchObject({ cols: 1, rows: 2, pages: 1 });
    expect(cardLayout(6)).toMatchObject({ cols: 2, rows: 3, pages: 1 });
    expect(cardLayout(8)).toMatchObject({ cols: 2, rows: 4, pages: 1 });
    expect(cardLayout(14)).toMatchObject({ cols: 2, rows: 4, pages: 2, perPage: 7 });
    expect(cardLayout(20)).toMatchObject({ cols: 3, pages: 2 });
    expect(cardLayout(20).truncateAt).toBeUndefined();
    expect(cardLayout(30).truncateAt).toBe(24);
  });

  it("never plans more than two pages, and always has room for every shown step", () => {
    for (let n = 1; n <= 40; n++) {
      const l = cardLayout(n);
      expect(l.pages).toBeLessThanOrEqual(2);
      expect(l.cols * l.rows).toBeGreaterThanOrEqual(l.perPage);
      expect(l.perPage * l.pages).toBeGreaterThanOrEqual(l.truncateAt ?? n);
    }
  });
});

describe("buildCardHtml grid", () => {
  const steps: CardStepInput[] = [1, 2, 3, 4, 5, 6].map((n) => ({
    number: n,
    title: `Step ${n}`,
    text: `Do thing ${n}.`,
    figure: figure({ step: n }),
  }));

  it("lays steps with figures out as a grid that fills the page", () => {
    const html = buildCardHtml("Add an order", steps, undefined, { paper: "A4" });
    expect(html.match(/<div class="cell">/g)).toHaveLength(6);
    expect(html).toContain("grid-template-columns: repeat(2, minmax(0, 1fr))");
    expect(html).toContain("grid-template-rows: repeat(3, minmax(0, 1fr))");
    expect(html).toMatch(/\.card-page \{ height: 272mm;/);
    expect(html).toContain('class="ring"');
  });

  it("splits a long guide over two card pages", () => {
    const many = Array.from({ length: 12 }, (_, i) => ({ ...steps[0], number: i + 1, title: `Step ${i + 1}` }));
    const html = buildCardHtml("Add an order", many, undefined, {});
    expect(html.match(/<section class="card-page">/g)).toHaveLength(2);
    expect(html).toContain("(continued)");
  });

  it("falls back to the text list without images", () => {
    const html = buildCardHtml("Add an order", steps, undefined, { withThumbnails: false });
    expect(html).not.toContain('class="cell"');
    expect(html).toContain('class="card-step"');
  });

  it("prints the guide's link and QR code in the footer when known", () => {
    const html = buildCardHtml("Add an order", steps, undefined, { guideUrl: "https://help.example.com/how-do-i/orders/add-an-order" });
    expect(html).toContain("help.example.com/how-do-i/orders/add-an-order");
    expect(html).toContain('<svg class="qr"');
  });
});

describe("parseFontFaces / fontFaceCss", () => {
  const CSS = `@font-face {
  font-family: 'Inter';
  font-style: normal;
  font-weight: 400;
  src: url(https://fonts.example.com/inter-400.ttf) format('truetype');
}
@font-face {
  font-family: 'Inter';
  font-style: normal;
  font-weight: 700;
  src: url(https://fonts.example.com/inter-700.ttf) format('truetype');
}
@font-face { font-family: 'Bad</style><script>'; font-weight: 400; src: url(https://x.example.com/a.ttf); }
@font-face { font-family: 'Plain'; font-weight: 400; src: url(http://insecure.example.com/a.ttf); }`;

  it("keeps well-formed https faces and rejects anything that could break out of the CSS", () => {
    const faces = parseFontFaces(CSS);
    expect(faces.map((f) => [f.family, f.weight, f.format])).toEqual([
      ["Inter", "400", "truetype"],
      ["Inter", "700", "truetype"],
    ]);
  });

  it("writes @font-face rules that load the cached local files", () => {
    const css = fontFaceCss([{ family: "Inter", style: "normal", weight: "400", file: "/cache/a b.ttf", format: "truetype" }]);
    expect(css).toContain("font-family: 'Inter'");
    expect(css).toContain('url("file:///cache/a%20b.ttf") format("truetype")');
  });
});
