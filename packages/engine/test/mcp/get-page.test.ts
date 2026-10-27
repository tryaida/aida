import { describe, expect, it } from "vitest";
import { LLMS_TXT_SECTION_DELIMITER } from "../../src/build/index-stage.js";
import { getPageFromLlmsTxt, parseLlmsTxt } from "../../src/mcp/get-page.js";

// Shaped like real output (a built help site's public/llms.txt): each section's body
// can itself contain a bare `---` line — a leftover frontmatter-style rule or a Markdown
// horizontal rule — which must not be mistaken for the delimiter between sections.
const llmsTxt = [
  ["# add-competitor", "", "# Add a competitor", "", "Click Add competitor.", "", "---", "", "*Verified.*"].join(
    "\n",
  ),
  ["# invoices", "", "# Invoices", "", "List payments."].join("\n"),
].join(LLMS_TXT_SECTION_DELIMITER);

describe("parseLlmsTxt / getPageFromLlmsTxt", () => {
  it("splits sections keyed by walkthrough id", () => {
    const sections = parseLlmsTxt(llmsTxt);
    expect([...sections.keys()]).toEqual(["add-competitor", "invoices"]);
  });

  it("gets a page by slug with or without a leading slash", () => {
    expect(getPageFromLlmsTxt(llmsTxt, "/add-competitor")).toContain("Click Add competitor.");
    expect(getPageFromLlmsTxt(llmsTxt, "invoices")).toContain("List payments.");
  });

  it("keeps a body's own bare `---` line intact instead of splitting the section there (regression: old delimiter was a bare `---` line, identical to a Markdown horizontal rule and to a page's own frontmatter fence)", () => {
    const content = getPageFromLlmsTxt(llmsTxt, "add-competitor");
    expect(content).toContain("Click Add competitor.");
    expect(content).toContain("*Verified.*");
  });

  it("returns undefined for an unknown slug", () => {
    expect(getPageFromLlmsTxt(llmsTxt, "/nope")).toBeUndefined();
  });

  it("returns undefined for a section whose body is empty instead of an empty string", () => {
    const withEmpty = `${llmsTxt}${LLMS_TXT_SECTION_DELIMITER}# empty-page\n\n`;
    expect(getPageFromLlmsTxt(withEmpty, "empty-page")).toBeUndefined();
  });

  it("returns undefined for an empty llms.txt", () => {
    expect(getPageFromLlmsTxt("", "add-competitor")).toBeUndefined();
  });
  it("resolves a nested library URL (and a URL with an anchor) by its last segment, the walkthrough id", () => {
    expect(getPageFromLlmsTxt(llmsTxt, "/how-do-i/competitors/add-competitor")).toContain("Click Add competitor.");
    expect(getPageFromLlmsTxt(llmsTxt, "/how-do-i/payments/invoices#steps")).toContain("List payments.");
    expect(getPageFromLlmsTxt(llmsTxt, "/how-do-i/payments/unknown")).toBeUndefined();
  });
});
