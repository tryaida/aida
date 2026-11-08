// M42a (decision 39): plain-text transcripts written next to a rendered video.
import { describe, expect, it } from "vitest";
import { buildPathTranscript, buildTranscript } from "../../src/render/transcript.js";
import type { Walkthrough } from "../../src/walkthrough/index.js";

function wf(overrides: Partial<Walkthrough> = {}): Walkthrough {
  return {
    walkthrough: "record-payment",
    title: "Record a payment",
    steps: [
      { id: "open", title: "Open the payment form", say: "First, open the payment form.", actions: [] },
      { id: "save", title: "Save the payment", say: "Then save the payment.", actions: [] },
    ],
    ...overrides,
  };
}

describe("buildTranscript", () => {
  it("writes the title, intro, one section per step in order, and the outro", () => {
    const text = buildTranscript(wf({ intro: { say: "Here's how to record a payment." } }));
    expect(text.startsWith("# Record a payment\n")).toBe(true);
    const introAt = text.indexOf("Here's how to record a payment.");
    const step1At = text.indexOf("## 1. Open the payment form");
    const step2At = text.indexOf("## 2. Save the payment");
    expect(introAt).toBeGreaterThan(-1);
    expect(step1At).toBeGreaterThan(introAt);
    expect(step2At).toBeGreaterThan(step1At);
    expect(text).toContain("First, open the payment form.");
    expect(text).toContain("Then save the payment.");
    // A sensible default outro line even with no outro written (walkthrough/cards.ts default).
    expect(text).toContain("You're done");
  });

  it("uses `say`, not the on-screen caption, for a step's narration", () => {
    const text = buildTranscript(wf({ steps: [{ id: "open", title: "Open", say: "Spoken words.", caption: "On-screen caption.", actions: [] }] }));
    expect(text).toContain("Spoken words.");
    expect(text).not.toContain("On-screen caption.");
  });

  it("prints {{data}} resolved for display, not the raw placeholder", () => {
    const text = buildTranscript(wf({ data: { customer: "Acme" }, intro: { say: "Recording a payment for {{customer}}." } }));
    expect(text).toContain("Recording a payment for Acme.");
    expect(text).not.toMatch(/\{\{/);
  });

  it("still gives every step a heading even when it has no `say` (a silent step)", () => {
    const text = buildTranscript(wf({ steps: [{ id: "s1", title: "A silent step", actions: [] }] }));
    expect(text).toContain("## 1. A silent step");
  });
});

describe("buildPathTranscript", () => {
  it("writes the path's title, its opening steps' narration, and the closing card", () => {
    const written = wf({
      paths: [
        {
          id: "from-attendee",
          title: "From the attendee's page",
          when: "Use this when paying for several bookings at once.",
          start: { page: "/attendees/7" },
          steps: [{ id: "open-attendee", title: "Open the attendee's payments", say: "Open the attendee's payments page.", actions: [] }],
          joins: "save",
        },
      ],
    });
    const text = buildPathTranscript(written, written.paths![0]);
    expect(text.startsWith("# From the attendee's page\n")).toBe(true);
    expect(text).toContain("## 1. Open the attendee's payments");
    expect(text).toContain("Open the attendee's payments page.");
    expect(text).toContain("Then continue from step 2");
  });

  it("says Done for a path that runs to its own end", () => {
    const written = wf({
      paths: [
        {
          id: "self-contained",
          title: "A way that finishes itself",
          when: "Use this sometimes.",
          start: { page: "/somewhere" },
          steps: [{ id: "only-step", title: "Only step", say: "Do the only thing.", actions: [] }],
        },
      ],
    });
    const text = buildPathTranscript(written, written.paths![0]);
    expect(text).toContain("Done.");
  });
});
