// Groups filtered merge entries by the walkthrough they affect, via an injectable
// `WalkthroughMapper` — the hook a future `packages/engine/src/impact/` (diff -> walkthrough
// mapping, a separate builder's M17) plugs into without this module depending on it existing
// yet (build-plan.md M21 step 4: "leave a clear hook"). With no mapper, every entry is
// "general" (unmapped) — grouped separately from per-walkthrough entries, never silently
// dropped.
import { toPlainWords } from "./plain-words.js";
import type { GroupedEntry, MergeEntry, WalkthroughMapper } from "./types.js";

export function groupByWalkthrough(entries: MergeEntry[], mapper?: WalkthroughMapper): GroupedEntry[] {
  return entries.map((entry) => ({
    ...entry,
    text: toPlainWords(entry.subject),
    walkthroughIds: mapper?.(entry) ?? [],
  }));
}

/** Splits grouped entries into per-walkthrough buckets (sorted by id) plus a trailing "general"
 * bucket for entries with no mapped walkthrough — the shape `renderPage` expects. */
export function bucketByWalkthrough(entries: GroupedEntry[]): { walkthroughId?: string; entries: GroupedEntry[] }[] {
  const byId = new Map<string, GroupedEntry[]>();
  const general: GroupedEntry[] = [];
  for (const entry of entries) {
    if (entry.walkthroughIds.length === 0) {
      general.push(entry);
      continue;
    }
    for (const id of entry.walkthroughIds) {
      if (!byId.has(id)) byId.set(id, []);
      byId.get(id)!.push(entry);
    }
  }
  const buckets: { walkthroughId?: string; entries: GroupedEntry[] }[] = [...byId.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([walkthroughId, bucketEntries]) => ({ walkthroughId, entries: bucketEntries }));
  if (general.length > 0) buckets.push({ entries: general });
  return buckets;
}
