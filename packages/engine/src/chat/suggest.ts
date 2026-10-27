// `aida suggest`: groups unanswered questions into suggested new walkthroughs by simple
// keyword overlap — no model call (build-plan.md M15 step 5: "simple clustering by keywords;
// no model call"; scope.md "Token efficiency": judgement-only spend, this isn't judgement).
import { tokenize } from "../index-search/index.js";
import type { UnansweredEntry } from "./unanswered.js";

export interface SuggestedWalkthrough {
  /** A short slug guessed from the cluster's most common significant words. */
  slug: string;
  /** Example questions in this cluster. */
  questions: string[];
  count: number;
}

/** Jaccard similarity of two questions' token sets — simple, fast, no embeddings needed for a
 * handful of unanswered questions between runs. */
function similarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const t of a) if (b.has(t)) intersection += 1;
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

function slugFor(tokens: string[]): string {
  const counts = new Map<string, number>();
  for (const t of tokens) counts.set(t, (counts.get(t) ?? 0) + 1);
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([t]) => t);
  return top.join("-") || "general";
}

/**
 * Single-link clusters `entries` by token overlap (threshold 0.2, chosen empirically to group
 * paraphrases of the same question without merging unrelated ones). Sorted by cluster size,
 * largest (most asked) first — the most useful signal for which walkthrough to write next.
 */
export function clusterUnanswered(entries: UnansweredEntry[], threshold = 0.2): SuggestedWalkthrough[] {
  const tokenSets = entries.map((e) => new Set(tokenize(e.question)));
  const parent = entries.map((_, i) => i);

  function find(i: number): number {
    while (parent[i] !== i) i = parent[i];
    return i;
  }
  function union(a: number, b: number): void {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  }

  for (let i = 0; i < entries.length; i++) {
    for (let j = i + 1; j < entries.length; j++) {
      if (similarity(tokenSets[i], tokenSets[j]) >= threshold) union(i, j);
    }
  }

  const groups = new Map<number, number[]>();
  for (let i = 0; i < entries.length; i++) {
    const root = find(i);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root)!.push(i);
  }

  const suggestions: SuggestedWalkthrough[] = [...groups.values()].map((indices) => {
    const allTokens = indices.flatMap((i) => [...tokenSets[i]]);
    return {
      slug: slugFor(allTokens),
      questions: indices.map((i) => entries[i].question),
      count: indices.length,
    };
  });

  return suggestions.sort((a, b) => b.count - a.count);
}
