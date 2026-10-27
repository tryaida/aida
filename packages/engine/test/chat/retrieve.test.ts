import { describe, expect, it } from "vitest";
import { retrieve } from "../../src/chat/retrieve.js";
import type { SearchIndexEntry } from "../../src/index-search/index.js";
import type { Procedure } from "../../src/procedures/index.js";

const entries: SearchIndexEntry[] = [
  { url: "/add-competitor", title: "Add a competitor", text: "Click Add competitor to create a new competitor record." },
  { url: "/add-competitor", title: "Add a competitor", heading: "Search first", text: "Search competitors before adding a duplicate." },
  { url: "/invoices", title: "Invoices", text: "Invoices list every payment received this show." },
];

const procedures: Procedure[] = [
  {
    id: "add-competitor",
    title: "Add a competitor",
    start: { page: "/competitors", role: "office-staff" },
    steps: [{ n: 1, title: "Open competitors", instruction: "Click Competitors.", screenshot: "/screenshots/add-competitor/step-01.png" }],
    impactRoutes: ["/competitors"],
  },
];

describe("retrieve", () => {
  it("returns the best page first, whole, and leaves out pages that don't match", () => {
    const result = retrieve("how do I add a competitor", entries, procedures);
    expect(result.pages[0].url).toBe("/add-competitor");
    expect(result.pages[0].sections).toHaveLength(2);
    expect(result.pages[0].procedure?.id).toBe("add-competitor");
    expect(result.pages.some((p) => p.url === "/invoices")).toBe(false);
  });

  it("boosts pages matching the current in-app page", () => {
    const score = (r: ReturnType<typeof retrieve>) => r.pages.find((p) => p.url === "/add-competitor")?.score ?? 0;
    expect(score(retrieve("competitor", entries, procedures, { currentPath: "/competitors" }))).toBeGreaterThan(
      score(retrieve("competitor", entries, procedures)),
    );
  });

  it("returns a zero top score and no pages for a question nothing matches", () => {
    const result = retrieve("gibberish nonsense zzzzz", entries, procedures);
    expect(result.topScore).toBe(0);
    expect(result.pages).toEqual([]);
  });

  it("falls back to the walkthrough for the reader's current screen when nothing matches", () => {
    const result = retrieve("gibberish nonsense zzzzz", entries, procedures, { currentPath: "/competitors" });
    expect(result.pages.map((p) => p.procedure?.id)).toEqual(["add-competitor"]);
  });

  it("gives a question spanning two tasks both guides, even when one guide has many matching sections", () => {
    const sections = ["Steps", "Part 1: Filter", "Good to know", "Before you start"];
    const twoGuides: SearchIndexEntry[] = [
      { url: "/payments/filter-unpaid", title: "Filter unpaid entries", text: "Find unpaid entries with the payment status filter." },
      ...sections.map((h) => ({
        url: `/payments/filter-unpaid#${h.toLowerCase().replace(/\W+/g, "-")}`,
        title: "Filter unpaid entries",
        heading: h,
        text: "Choose Unpaid under Payment Status to find unpaid entries.",
      })),
      { url: "/payments/record-a-payment", title: "Record a payment", text: "Record a payment a competitor made." },
      { url: "/payments/record-a-payment#part-1", title: "Record a payment", heading: "Part 1: Record", text: "Click New Payment." },
    ];
    const result = retrieve("How do I find unpaid entries and record their payments?", twoGuides, [], { limit: 4 });
    expect(result.pages.map((p) => p.url).sort()).toEqual(["/payments/filter-unpaid", "/payments/record-a-payment"]);
  });

  it("matches a procedure to nested, anchored hit URLs, falling back to the walkthrough id", () => {
    const nestedEntries: SearchIndexEntry[] = [
      { url: "/how-do-i/competitors/add-competitor", title: "Add a competitor", text: "Click Add competitor to create a new competitor record." },
      { url: "/how-do-i/competitors/add-competitor#search-first", title: "Add a competitor", heading: "Search first", text: "Search competitors before adding." },
    ];
    const nestedProcedures: Procedure[] = [{ ...procedures[0], url: "/how-do-i/competitors/add-competitor" }];
    expect(retrieve("search competitors", nestedEntries, nestedProcedures).pages[0].procedure?.id).toBe("add-competitor");
    // A procedures.json without `url` still matches a nested page by the walkthrough id.
    expect(retrieve("search competitors", nestedEntries, procedures).pages[0].procedure?.id).toBe("add-competitor");
  });
});
