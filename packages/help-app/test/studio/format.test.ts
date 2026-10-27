import { describe, expect, it } from "vitest";
import { captionCues, describeEntry, groupLibrary, placeOf, relativeTime, undoState } from "../../components/studio/format";
import type { WalkthroughSummary } from "../../components/studio/types";

const wt = (id: string, section?: string): WalkthroughSummary => ({ id, file: "", title: id, stepCount: 1, section, status: "passed" });

describe("Studio library grouping", () => {
  it("places sections per Contract 3", () => {
    expect(placeOf(undefined)).toEqual({ category: "how-do-i", group: "" });
    expect(placeOf("Payments")).toEqual({ category: "how-do-i", group: "Payments" });
    expect(placeOf("Entries / Late entries")).toEqual({ category: "how-do-i", group: "Entries / Late entries" });
    expect(placeOf("getting started")).toEqual({ category: "getting-started", group: "" });
    expect(placeOf("Troubleshooting and FAQ / Sign-in")).toEqual({ category: "troubleshooting-and-faq", group: "Sign-in" });
    expect(placeOf("How do I... / Payments")).toEqual({ category: "how-do-i", group: "Payments" });
  });

  it("groups in site order and filters by query", () => {
    const lib = groupLibrary([wt("record-a-payment", "Payments"), wt("first-steps", "Getting started"), wt("invite")]);
    expect(lib.map((g) => g.title)).toEqual(["Getting started", "How do I…"]);
    expect(lib[1].groups.map((g) => g.name)).toEqual(["", "Payments"]);
    expect(groupLibrary([wt("record-a-payment", "Payments"), wt("invite")], "payment")[0].count).toBe(1);
  });
});

describe("Studio display helpers", () => {
  it("formats relative times", () => {
    const now = Date.parse("2026-10-26T12:00:00Z");
    expect(relativeTime("2026-10-26T11:59:50Z", now)).toBe("just now");
    expect(relativeTime("2026-10-26T11:55:00Z", now)).toBe("5 min ago");
    expect(relativeTime("2026-10-25T12:00:00Z", now)).toBe("yesterday");
  });

  it("describes history entries in plain words", () => {
    const d = describeEntry({ at: "", by: "person", action: "setStepField", target: "record-a-payment#open-payments.caption", before: "a", after: "b" });
    expect(d).toMatchObject({ what: "changed the caption", walkthroughId: "record-a-payment", stepId: "open-payments", before: "a", after: "b" });
  });

  it("describes undo entries and tracks what is left to undo", () => {
    const edit = { at: "", by: "agent" as const, action: "addCallout", target: "w#s", before: null, after: {} };
    const undoEntry = { at: "", by: "agent" as const, action: "undo:addCallout", target: "w#s", before: {}, after: null, undoOf: 0 };
    expect(describeEntry(undoEntry).what).toBe("undid “added a callout”");
    expect(undoState([edit])).toMatchObject({ canUndo: true, canUndoAgent: true });
    const after = undoState([edit, undoEntry]);
    expect(after.undone.has(0)).toBe(true);
    expect(after.canUndo).toBe(false);
  });

  it("counts caption cues with the renderer's 42-character wrap", () => {
    expect(captionCues("Short caption.").cues).toBe(1);
    expect(captionCues("word ".repeat(40)).cues).toBeGreaterThan(1);
  });
});
