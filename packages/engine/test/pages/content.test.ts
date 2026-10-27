// Regression tests for two content leaks found on a real pilot page (build-plan M5/M6):
// 1. `start.notes` (internal capture/environment context — demo database paths, "data is
//    synthetic" asides) showing up verbatim in the reader-facing "Before you start" section.
// 2. The raw persona role id (`office_staff`) shown to readers instead of a human name.
import { describe, expect, it } from "vitest";
import {
  buildFrontmatterBlock,
  buildBeforeYouStartBlock,
  buildGoodToKnowBlock,
  buildHeaderBlock,
  buildStepBlock,
  escapeMdxText,
  readerNameForRole,
} from "../../src/pages/content.js";
import type { Walkthrough } from "../../src/walkthrough/index.js";

function wf(overrides: Partial<Walkthrough> = {}): Walkthrough {
  return {
    walkthrough: "wf",
    title: "T",
    steps: [],
    ...overrides,
  };
}

describe("readerNameForRole", () => {
  it("reuses the matching phrase from the walkthrough's `for` sentence, case preserved", () => {
    const name = readerNameForRole("office_staff", {
      for: "Show office staff and secretaries taking entries at the office or over the phone",
    });
    expect(name).toBe("office staff");
  });

  it("falls back to a configured reader name when `for` doesn't mention it", () => {
    const name = readerNameForRole("office_staff", { for: undefined }, ["office-staff", "judges"]);
    expect(name).toBe("office staff");
  });

  it("falls back to a humanised form of the id when nothing else matches", () => {
    const name = readerNameForRole("office_staff", {});
    expect(name).toBe("office staff");
  });

  it("uses config roles first, in either form, as written (M26)", () => {
    const roles = { admin: "an organiser", office_staff: { name: "office staff" } };
    expect(readerNameForRole("admin", { for: "Admins setting up the show" }, ["admin"], roles)).toBe("an organiser");
    expect(readerNameForRole("office_staff", {}, undefined, roles)).toBe("office staff");
    // A role with no entry keeps the old fallbacks.
    expect(readerNameForRole("show_manager", {}, undefined, roles)).toBe("show manager");
  });

  it("only reads the role map's own keys, so `constructor` isn't Object (M26)", () => {
    const roles = { admin: "an organiser" };
    expect(readerNameForRole("constructor", {}, undefined, roles)).toBe("constructor");
    expect(readerNameForRole("toString", {}, undefined, roles)).toBe("tostring");
    expect(readerNameForRole("__proto__", {}, undefined, roles)).toBe("proto");
  });

  it("never returns the raw id with its underscores/dashes intact", () => {
    expect(readerNameForRole("office_staff", {})).not.toContain("_");
    expect(readerNameForRole("show-manager", {})).not.toContain("-");
  });
});

describe("buildBeforeYouStartBlock", () => {
  it("never includes start.notes (internal environment/capture context, not reader-facing)", () => {
    const walkthrough = wf({
      start: {
        signed_in_as: "office_staff",
        show: "Riverbend Show 2026",
        notes: "Runs against the isolated demo database (scripts/demo-env). All names, emails and phone numbers are synthetic.",
      },
    });

    const block = buildBeforeYouStartBlock(walkthrough);
    expect(block).toBeDefined();
    expect(block!.content).not.toContain("isolated demo database");
    expect(block!.content).not.toContain("demo-env");
    expect(block!.content).not.toContain("synthetic");
  });

  it("maps the raw role id to a reader-friendly name", () => {
    const walkthrough = wf({
      for: "Show office staff and secretaries taking entries at the office or over the phone",
      start: { signed_in_as: "office_staff" },
    });

    const block = buildBeforeYouStartBlock(walkthrough);
    expect(block!.content).toContain("Sign in as **office staff**.");
    expect(block!.content).not.toContain("office_staff");
  });

  it("falls back to persona.role when signed_in_as is absent", () => {
    const walkthrough = wf({ start: { persona: { role: "show_manager" } } });
    const block = buildBeforeYouStartBlock(walkthrough);
    expect(block!.content).toContain("show manager");
  });

  it("returns undefined when there is nothing reader-facing to say", () => {
    const walkthrough = wf({ start: { notes: "internal only" } });
    expect(buildBeforeYouStartBlock(walkthrough)).toBeUndefined();
  });
});

// Regression: raw page_text/caption/title/summary/recap text went straight into the generated
// .mdx body. MDX parses `{...}` as a JS expression and `<...>` as JSX, so a step that happened
// to mention "{name} token" or "a < b" either broke `next build` or ran as code.
describe("escapeMdxText", () => {
  it("escapes curly braces and angle brackets", () => {
    expect(escapeMdxText("{name} token")).toBe("\\{name\\} token");
    expect(escapeMdxText("a < b")).toBe("a \\< b");
  });

  it("leaves intended Markdown (bold, links) untouched", () => {
    expect(escapeMdxText("Click **Save**.")).toBe("Click **Save**.");
    expect(escapeMdxText("See [the docs](https://example.com/docs).")).toBe(
      "See [the docs](https://example.com/docs).",
    );
  });
});

describe("MDX-unsafe text in generated blocks", () => {
  it("escapes the page title and summary", () => {
    const walkthrough = wf({ title: "Add a {thing}", summary: "Click a < b to continue." });
    const block = buildHeaderBlock(walkthrough);
    expect(block.content).toContain("Add a \\{thing\\}");
    expect(block.content).toContain("a \\< b");
  });

  it("escapes a step's title and page_text", () => {
    const step = { id: "s1", title: "Open {Settings}", page_text: "a < b and **bold** stays bold.", actions: [] };
    const block = buildStepBlock(step, 1, { ok: true });
    expect(block.content).toContain("Open \\{Settings\\}");
    expect(block.content).toContain("a \\< b");
    expect(block.content).toContain("**bold**");
  });

  it("escapes recap bullets", () => {
    const walkthrough = wf({ outro: { recap: ["Watch for {errors}", "a < b matters"] } });
    const block = buildGoodToKnowBlock(walkthrough);
    expect(block!.content).toContain("\\{errors\\}");
    expect(block!.content).toContain("a \\< b");
  });
});

describe("buildFrontmatterBlock", () => {
  it("writes kind, description, section and step count for the library (Contract 3)", () => {
    const block = buildFrontmatterBlock({
      title: "Record a payment",
      description: "Record an entry fee.",
      for: "Office staff",
      walkthrough: "record-a-payment",
      section: "How do I… / Payments",
      steps: 6,
      passed: true,
      links: { video: "../../videos/record-a-payment/record-a-payment.mp4" },
    });
    expect(block.content.split("\n")).toEqual([
      "---",
      'title: "Record a payment"',
      'description: "Record an entry fee."',
      "kind: walkthrough",
      'for: "Office staff"',
      'walkthrough: "record-a-payment"',
      'section: "How do I… / Payments"',
      "steps: 6",
      "passed: true",
      'video: "../../videos/record-a-payment/record-a-payment.mp4"',
      "---",
    ]);
  });
});
