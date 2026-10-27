import path from "node:path";
import { describe, expect, it } from "vitest";
import { markdownToHtml, renderInline, resolveImageSrc } from "../../src/pdf/markdown.js";

describe("resolveImageSrc", () => {
  it("resolves a relative path against baseDir into a file:// URL", () => {
    const src = resolveImageSrc("screenshots/step-01.png", "/tmp/page");
    expect(src).toBe(`file://${path.resolve("/tmp/page", "screenshots/step-01.png")}`);
  });

  // Regression (review finding pdf/markdown.ts:17): this HTML is loaded by Chromium straight off
  // `file://` with no sandbox of its own, so an unrestricted image src is a path to local-file
  // disclosure (e.g. a caption containing `![x](file:///home/u/.env)`) or outbound network access.
  it("rejects a file: URL even if it points inside baseDir", () => {
    expect(() => resolveImageSrc("file:///home/u/.env", "/tmp/page")).toThrow(/not allowed/);
  });

  it("rejects http(s):/data: URLs by default", () => {
    expect(() => resolveImageSrc("https://example.com/x.png", "/tmp/page")).toThrow(/not allowed/);
    expect(() => resolveImageSrc("data:image/png;base64,abc", "/tmp/page")).toThrow(/not allowed/);
  });

  it("allows http(s):/data: URLs when allowRemote is set", () => {
    expect(resolveImageSrc("https://example.com/x.png", "/tmp/page", { allowRemote: true })).toBe("https://example.com/x.png");
    expect(resolveImageSrc("data:image/png;base64,abc", "/tmp/page", { allowRemote: true })).toBe("data:image/png;base64,abc");
  });

  it("rejects an absolute filesystem path", () => {
    expect(() => resolveImageSrc("/etc/passwd", "/tmp/page")).toThrow(/not allowed/);
  });

  it("rejects a relative path that escapes baseDir via ../", () => {
    expect(() => resolveImageSrc("../../etc/passwd", "/tmp/page")).toThrow(/escapes the page directory/);
  });
});

describe("renderInline", () => {
  it("renders bold, italic, code and links", () => {
    const html = renderInline("Click **Save** then *confirm* using `Enter` or [this link](https://x.test)", "/tmp");
    expect(html).toContain("<strong>Save</strong>");
    expect(html).toContain("<em>confirm</em>");
    expect(html).toContain("<code>Enter</code>");
    expect(html).toContain('<a href="https://x.test">this link</a>');
  });

  it("escapes HTML-sensitive characters first", () => {
    expect(renderInline("a < b & c", "/tmp")).toBe("a &lt; b &amp; c");
  });

  it("resolves an inline image", () => {
    const html = renderInline("See ![a screenshot](screenshots/step-02.png) above", "/tmp/page");
    expect(html).toContain(`src="file://${encodeURI(path.resolve("/tmp/page", "screenshots/step-02.png"))}"`);
  });

  // Regression (review finding pdf/html.ts / markdown.ts:17): a caption containing a literal
  // `<iframe src=file:///...>` must come out as inert escaped text, not a live tag Chromium would
  // actually load from file://.
  it("renders a literal <iframe> payload as escaped text, never a live tag", () => {
    const html = renderInline('<iframe src="file:///home/u/.env"></iframe>', "/tmp");
    expect(html).not.toContain("<iframe");
    expect(html).toContain("&lt;iframe");
  });

  it("a quote in a link href can't break out of the attribute (the whole text is escaped before hrefs are extracted)", () => {
    const html = renderInline('[x](https://a.test/"onmouseover=alert(1))', "/tmp");
    expect(html).not.toMatch(/href="[^"]*"[^>]*"/); // no second, injected attribute
    expect(html).toContain("&quot;onmouseover=alert(1");
  });
});

describe("markdownToHtml", () => {
  const baseDir = "/tmp/page";

  it("renders headings, paragraphs, lists, blockquotes and an hr", () => {
    const md = [
      "# Title",
      "",
      "Some **intro** text.",
      "",
      "## Before you start",
      "",
      "- First thing",
      "- Second thing",
      "",
      "> Not verified. Something went wrong.",
      "",
      "---",
      "",
      "*Steps verified on 2026-01-01.*",
    ].join("\n");
    const html = markdownToHtml(md, baseDir);
    expect(html).toContain("<h1>Title</h1>");
    expect(html).toContain("<h2>Before you start</h2>");
    expect(html).toContain("<ul><li>First thing</li><li>Second thing</li></ul>");
    expect(html).toContain("<blockquote>Not verified. Something went wrong.</blockquote>");
    expect(html).toContain("<hr />");
  });

  it("renders a step heading followed by text and a standalone screenshot image", () => {
    const md = ["#### 1. Open Competitors", "", "Click **Competitors** in the menu.", "", "![Open Competitors](screenshots/step-01.png)"].join(
      "\n",
    );
    const html = markdownToHtml(md, baseDir);
    expect(html).toContain("<h4>1. Open Competitors</h4>");
    expect(html).toContain("<strong>Competitors</strong>");
    expect(html).toContain(`src="file://${encodeURI(path.resolve(baseDir, "screenshots/step-01.png"))}"`);
  });
});
