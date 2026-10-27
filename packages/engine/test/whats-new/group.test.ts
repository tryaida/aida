import { describe, expect, it } from "vitest";
import { bucketByWalkthrough, groupByWalkthrough } from "../../src/whats-new/group.js";
import type { MergeEntry } from "../../src/whats-new/types.js";

const entries: MergeEntry[] = [
  { id: "1", subject: "feat: add competitor export", date: "2026-01-01T00:00:00Z" },
  { id: "2", subject: "fix: broken login redirect", date: "2026-01-02T00:00:00Z" },
  { id: "3", subject: "feat: add invoices page", date: "2026-01-03T00:00:00Z" },
];

describe("groupByWalkthrough / bucketByWalkthrough", () => {
  it("defaults to no mapper: every entry unmapped (general)", () => {
    const grouped = groupByWalkthrough(entries);
    expect(grouped.every((e) => e.walkthroughIds.length === 0)).toBe(true);
    const buckets = bucketByWalkthrough(grouped);
    expect(buckets).toHaveLength(1);
    expect(buckets[0].walkthroughId).toBeUndefined();
    expect(buckets[0].entries).toHaveLength(3);
  });

  it("buckets per mapped walkthrough id, sorted, with unmapped entries trailing as general", () => {
    const mapper = (e: MergeEntry) => (e.subject.includes("login") ? ["login"] : e.subject.includes("invoices") ? ["invoices"] : undefined);
    const grouped = groupByWalkthrough(entries, mapper);
    const buckets = bucketByWalkthrough(grouped);
    expect(buckets.map((b) => b.walkthroughId)).toEqual(["invoices", "login", undefined]);
    expect(buckets.find((b) => b.walkthroughId === "login")?.entries).toHaveLength(1);
  });

  it("puts one entry into multiple buckets when the mapper names several walkthroughs", () => {
    const mapper = () => ["a", "b"];
    const grouped = groupByWalkthrough(entries.slice(0, 1), mapper);
    const buckets = bucketByWalkthrough(grouped);
    expect(buckets.map((b) => b.walkthroughId)).toEqual(["a", "b"]);
  });
});
