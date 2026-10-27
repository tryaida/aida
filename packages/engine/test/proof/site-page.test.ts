// M36: the proof sheet's help-site panel is the built page as the site lays it out — whole, not
// a print layout cut off at a fixed height.
import { describe, expect, it } from "vitest";
import { sitePageBody, sitePageHtml } from "../../src/proof/site-page.js";
import type { PdfPageInput } from "../../src/pdf/types.js";

const MD = `# Add an order

Create an order for a customer at Acme.

## Before you start

- Sign in as **office staff**.

## Steps

### Part 1: Add it

#### 1. Open Orders

Click **Orders**.

#### 2. New order

Click **New order**.

#### 3. Save

Click **Save**.

## Other ways to do this

### From the customer

#### 1. Open the customer
`;

describe("help-site panel (proof)", () => {
  it("shows the opening steps whole, then says how many more there are", () => {
    const { html, toc, more } = sitePageBody(MD, "/tmp", 2);
    expect(html).toContain('<span class="badge">1</span><span>Open Orders</span>');
    expect(html).toContain("New order");
    expect(html).not.toContain("Save</span>");
    expect(more).toBe(1);
    // No title or intro (the header shows them), no lone "Part 1", no other ways.
    expect(html).not.toContain("<h1>");
    expect(html).not.toContain("Create an order");
    expect(html).not.toContain("Part 1");
    expect(html).not.toContain("From the customer");
    expect(toc).toEqual(["Before you start", "Steps", "1. Open Orders", "2. New order", "3. Save"]);
  });

  it("lays the page out with the site's brand variables, header facts and the more-steps line", () => {
    const input = { id: "add-order", title: "Add an order", summary: "Create an order.", markdown: MD, baseDir: "/tmp", section: "How do I… / Orders", cardSteps: [] } as unknown as PdfPageInput;
    const html = sitePageHtml(input, { name: "Acme" }, {
      brandCss: ":root { --color-fd-primary: hsl(10 50% 40%); }",
      facts: { steps: 3, for: "Office staff", passed: true, pdf: true },
      siblings: ["Find an order"],
    });
    expect(html).toContain("--color-fd-primary: hsl(10 50% 40%)");
    expect(html).toContain("<h1>Add an order</h1>");
    expect(html).toContain("3 steps");
    expect(html).toContain("For office staff");
    expect(html).toContain("Download PDF");
    expect(html).toContain("… and 1 more step on the page.");
    expect(html).toContain('<a class="active">Add an order</a>');
  });
});

describe("site brand CSS for the panel (M36 review)", () => {
  it("keeps only the first rule's custom properties, dropping anything that could load or inject", async () => {
    const { brandVars } = await import("../../src/proof/index.js");
    const css = `/* header */
:root {
  --brand-primary: hsl(235 55% 42%);
  --font-sans: "Inter", system-ui, sans-serif;
  --color-fd-accent: color-mix(in oklab, var(--brand-primary) 10%, var(--color-fd-background));
  --evil: url(https://example.com/x.png);
  --worse: red; } body { background: url(file:///etc/passwd);
  color: red;
}
.dark { --brand-primary: hsl(236 72% 71%); }`;
    const vars = brandVars(css);
    expect(vars).toContain("--brand-primary: hsl(235 55% 42%);");
    expect(vars).toContain('--font-sans: "Inter", system-ui, sans-serif;');
    expect(vars.some((v) => v.startsWith("--color-fd-accent"))).toBe(true);
    expect(vars.join("\n")).not.toMatch(/url|passwd|236 72%/);
    expect(vars.every((v) => v.startsWith("--"))).toBe(true);
  });
});
