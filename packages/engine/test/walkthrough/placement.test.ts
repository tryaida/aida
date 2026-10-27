import { describe, expect, it } from "vitest";
import {
  libraryPlacement,
  loadWalkthroughText,
  sectionProblems,
  sectionSlug,
  WalkthroughValidationError,
} from "../../src/walkthrough/index.js";

describe("libraryPlacement", () => {
  it("puts a walkthrough with no section straight into How do I…", () => {
    expect(libraryPlacement(undefined, "record-a-payment")).toEqual({
      category: { slug: "how-do-i", title: "How do I…" },
      groups: [],
      dir: "how-do-i/record-a-payment",
      url: "/how-do-i/record-a-payment",
      displayPath: "How do I…",
    });
  });

  it("treats a section that isn't a category as a feature group inside How do I…", () => {
    const p = libraryPlacement("Payments", "record-a-payment");
    expect(p.category.slug).toBe("how-do-i");
    expect(p.groups).toEqual([{ slug: "payments", title: "Payments" }]);
    expect(p.dir).toBe("how-do-i/payments/record-a-payment");
    expect(p.url).toBe("/how-do-i/payments/record-a-payment");
    expect(p.displayPath).toBe("How do I… / Payments");
  });

  it("nests groups with ' / '", () => {
    const p = libraryPlacement("Entries / Late entries", "late-entry");
    expect(p.dir).toBe("how-do-i/entries/late-entries/late-entry");
    expect(p.displayPath).toBe("How do I… / Entries / Late entries");
  });

  it("matches a top-level category by title or slug, in any case", () => {
    expect(libraryPlacement("Getting started", "sign-in").dir).toBe("getting-started/sign-in");
    expect(libraryPlacement("getting-started", "sign-in").dir).toBe("getting-started/sign-in");
    expect(libraryPlacement("TROUBLESHOOTING AND FAQ", "reset").dir).toBe("troubleshooting-and-faq/reset");
    expect(libraryPlacement("What's new", "x").category).toEqual({ slug: "whats-new", title: "What's new" });
    expect(libraryPlacement("How do I...", "x").dir).toBe("how-do-i/x");
    expect(libraryPlacement("How do I… / Payments", "x").dir).toBe("how-do-i/payments/x");
  });

  it("keeps groups below a named category", () => {
    const p = libraryPlacement("Screens and settings / Show setup", "show-settings");
    expect(p.dir).toBe("screens-and-settings/show-setup/show-settings");
    expect(p.displayPath).toBe("Screens and settings / Show setup");
  });

  it("is lenient about spacing around the separator", () => {
    expect(libraryPlacement("Entries/Late entries", "x").dir).toBe("how-do-i/entries/late-entries/x");
  });
});

describe("sectionSlug", () => {
  it("makes plain URL slugs", () => {
    expect(sectionSlug("Late entries")).toBe("late-entries");
    expect(sectionSlug("Café & bar")).toBe("cafe-bar");
    expect(sectionSlug("Competitor's details")).toBe("competitors-details");
  });
});

describe("sectionProblems", () => {
  it("accepts plain words", () => {
    expect(sectionProblems("Payments")).toEqual([]);
    expect(sectionProblems("Entries / Late entries")).toEqual([]);
    expect(sectionProblems("Fees & charges (GST)")).toEqual([]);
  });

  it("rejects empty values, empty parts, markup and 'index'", () => {
    expect(sectionProblems("  ")).toHaveLength(1);
    expect(sectionProblems("Entries / ")).toHaveLength(1);
    expect(sectionProblems("<b>Payments</b>").length).toBeGreaterThan(0);
    expect(sectionProblems("{Payments}")).toHaveLength(1);
    expect(sectionProblems("Index")).toHaveLength(1);
  });
});

describe("walkthrough `section:`", () => {
  const base = (section: string) => `
walkthrough: record-a-payment
title: Record a payment
section: ${section}
steps:
  - do: click "Payments" link
`;

  it("loads onto the typed walkthrough", () => {
    expect(loadWalkthroughText(base("Payments")).section).toBe("Payments");
    expect(loadWalkthroughText(base("Payments").replace("section: Payments\n", "")).section).toBeUndefined();
  });

  it("fails validation with a line number for a bad value", () => {
    try {
      loadWalkthroughText(base('"Payments / "'), "w.yaml");
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(WalkthroughValidationError);
      const e = (err as WalkthroughValidationError).errors[0];
      expect(e.path).toBe("section");
      expect(e.line).toBe(4);
      expect(e.message).toContain("empty part");
    }
  });
});
