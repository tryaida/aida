import { describe, expect, it } from "vitest";
import { parseInline, parsePage, previewImageSource, safeHref } from "../../components/studio/markdown";

const PAGE = `---
title: "Record a payment"
passed: true
---

{/* aida:begin header */}
# Record a payment

Record an entry fee.
{/* aida:end header */}

{/* aida:begin step-open-payments */}
#### 1. Open Payments

Click **Payments** in the <strong>left-hand</strong> menu, then press <kbd>Enter</kbd>.

![Open Payments](screenshots/step-01.png)
{/* aida:end step-open-payments */}

Hand-written note with a [link](/record-a-payment) and \\{braces\\}.
`;

describe("Studio page preview parser", () => {
  it("strips frontmatter and aida markers, keeping each block's key", () => {
    const page = parsePage(PAGE);
    expect(page.frontmatter.title).toBe("Record a payment");
    expect(page.sections.map((s) => s.key)).toEqual(["header", "step-open-payments", undefined]);
    const json = JSON.stringify(page);
    expect(json).not.toContain("aida:begin");
    expect(json).not.toContain("title: ");
  });

  it("renders inline HTML and Markdown emphasis as nodes, not literal tags", () => {
    const step = parsePage(PAGE).sections[1];
    expect(step.blocks[0]).toMatchObject({ type: "heading", level: 4 });
    const para = step.blocks[1];
    expect(para.type).toBe("paragraph");
    const types = para.type === "paragraph" ? para.children.map((c) => c.type) : [];
    expect(types).toEqual(["text", "strong", "text", "strong", "text", "kbd", "text"]);
    expect(JSON.stringify(para)).not.toContain("<strong>");
    expect(step.blocks[2]).toEqual({ type: "image", alt: "Open Payments", src: "screenshots/step-01.png" });
  });

  it("unescapes MDX escapes and keeps links", () => {
    const last = parsePage(PAGE).sections[2].blocks[0];
    expect(JSON.stringify(last)).toContain('"href":"/record-a-payment"');
    expect(JSON.stringify(last)).toContain("{braces}");
  });

  it("parses ordered and nested lists", () => {
    const page = parsePage("1. One\n2. Two\n   - nested\n3. Three\n");
    const list = page.sections[0].blocks[0];
    expect(list).toMatchObject({ type: "list", ordered: true });
    if (list.type !== "list") throw new Error("expected list");
    expect(list.items).toHaveLength(3);
    expect(list.items[1][1]).toMatchObject({ type: "list", ordered: false });
  });

  it("leaves snake_case alone and refuses unsafe links", () => {
    expect(parseInline("a_b_c")).toEqual([{ type: "text", text: "a_b_c" }]);
    expect(safeHref("javascript:alert(1)")).toBeUndefined();
    expect(parseInline("[x](javascript:alert(1))")).toEqual([{ type: "text", text: "x" }]);
  });

  it("maps page screenshots to the guarded page-asset route only", () => {
    expect(previewImageSource("record-a-payment", "./screenshots/step-01.png")).toEqual({
      kind: "guarded",
      url: "/studio/api/page-asset?id=record-a-payment&file=step-01.png",
    });
    expect(previewImageSource("x", "/screenshots/x/step-01.png")?.kind).toBe("direct");
    expect(previewImageSource("x", "../other/secret.png")).toBeUndefined();
  });
});
