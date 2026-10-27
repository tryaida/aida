// Pure display helpers for the Studio (no React) — unit-tested in test/studio/format.test.ts.
import { wrapCaption } from "aida/dist/render/captions.js";
import type { CaptureStatus, HistoryEntry, WalkthroughSummary } from "./types";

/** "just now", "5 min ago", "3 hours ago", "yesterday", "4 days ago", else a short date. */
export function relativeTime(iso: string | number | undefined, now: number = Date.now()): string {
  if (iso === undefined) return "";
  const t = typeof iso === "number" ? iso : Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const s = Math.round((now - t) / 1000);
  if (s < 45) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} hour${h === 1 ? "" : "s"} ago`;
  const d = Math.round(h / 24);
  if (d === 1) return "yesterday";
  if (d < 14) return `${d} days ago`;
  return new Date(t).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

export const STATUS_LABEL: Record<CaptureStatus, string> = {
  passed: "Passed",
  failed: "Failed",
  captured: "Captured, not checked",
  "not-captured": "Not captured yet",
};

// Contract 3's top-level help library categories, in site order. A walkthrough's `section`
// whose first segment names one (title or slug, case-insensitive) sits there; any other section
// is a feature group inside "How do I…", which is also where walkthroughs without one go.
export const CATEGORIES: { slug: string; title: string }[] = [
  { slug: "getting-started", title: "Getting started" },
  { slug: "how-do-i", title: "How do I…" },
  { slug: "screens-and-settings", title: "Screens and settings" },
  { slug: "words-we-use", title: "Words we use" },
  { slug: "troubleshooting-and-faq", title: "Troubleshooting and FAQ" },
  { slug: "whats-new", title: "What's new" },
];

function normalise(s: string): string {
  return s
    .toLowerCase()
    .replace(/…|\.\.\./g, "")
    .replace(/[’']/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

/** Where a walkthrough sits: its top-level category and the feature-group path inside it
 * ("" when it sits directly in the category). */
export function placeOf(section: string | undefined): { category: string; group: string } {
  const parts = (section ?? "")
    .split("/")
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length === 0) return { category: "how-do-i", group: "" };
  const first = normalise(parts[0]);
  const cat = CATEGORIES.find((c) => c.slug === first || normalise(c.title) === first);
  if (cat) return { category: cat.slug, group: parts.slice(1).join(" / ") };
  return { category: "how-do-i", group: parts.join(" / ") };
}

export interface LibraryGroup {
  category: string;
  title: string;
  groups: { name: string; items: WalkthroughSummary[] }[];
  count: number;
}

/** Groups walkthroughs into the help library's categories → feature groups, in site order,
 * filtered by `query` (title, id, section or summary; case-insensitive). Empty categories drop. */
export function groupLibrary(walkthroughs: WalkthroughSummary[], query = ""): LibraryGroup[] {
  const q = query.trim().toLowerCase();
  const matches = (w: WalkthroughSummary) =>
    !q || [w.title, w.id, w.section ?? "", w.summary ?? ""].some((f) => f.toLowerCase().includes(q));
  const out: LibraryGroup[] = [];
  for (const cat of CATEGORIES) {
    const byGroup = new Map<string, WalkthroughSummary[]>();
    for (const w of walkthroughs) {
      if (!matches(w)) continue;
      const place = placeOf(w.section);
      if (place.category !== cat.slug) continue;
      const list = byGroup.get(place.group) ?? [];
      list.push(w);
      byGroup.set(place.group, list);
    }
    if (byGroup.size === 0) continue;
    // Walkthroughs directly in the category first, then feature groups A–Z.
    const groups = [...byGroup.entries()]
      .sort(([a], [b]) => (a === "" ? -1 : b === "" ? 1 : a.localeCompare(b)))
      .map(([name, items]) => ({ name, items: items.sort((x, y) => x.title.localeCompare(y.title)) }));
    out.push({ category: cat.slug, title: cat.title, groups, count: groups.reduce((n, g) => n + g.items.length, 0) });
  }
  return out;
}

const FIELD_WORDS: Record<string, string> = {
  say: "narration",
  caption: "caption",
  page_text: "page text",
  title: "title",
  hold: "hold time",
  do: "action",
  check: "check",
};

const ACTION_WORDS: Record<string, string> = {
  reorderSteps: "reordered the steps",
  removeStep: "removed a step",
  insertStep: "added a step",
  setStepActions: "changed a step's actions",
  setPageBlock: "edited the page text",
  addCallout: "added a callout",
  updateCallout: "changed a callout",
  removeCallout: "removed a callout",
  reorderCallouts: "reordered callouts",
  addBlur: "added a blur box",
  updateBlur: "changed a blur box",
  removeBlur: "removed a blur box",
  lock: "locked",
  unlock: "unlocked",
  setData: "changed sample data",
};

/** A history entry in plain words: what changed, on which walkthrough/step, and a short
 * before → after when both sides are short text. */
export function describeEntry(e: HistoryEntry): { what: string; walkthroughId?: string; stepId?: string; before?: string; after?: string } {
  const [wt, rest = ""] = e.target.split("#");
  const [stepId, field] = rest.split(".");
  const undoOf = e.action.startsWith("undo:") ? e.action.slice(5) : undefined;
  const action = undoOf ?? e.action;
  let what: string;
  if (action === "setStepField") what = `changed the ${FIELD_WORDS[field] ?? field ?? "step"}`;
  else what = ACTION_WORDS[action] ?? action.replace(/([A-Z])/g, " $1").toLowerCase().trim();
  if (undoOf) what = `undid “${what}”`;
  const short = (v: unknown) =>
    typeof v === "string" || typeof v === "number" ? (String(v).length > 120 ? `${String(v).slice(0, 117)}…` : String(v)) : undefined;
  return {
    what,
    walkthroughId: wt || undefined,
    stepId: stepId || undefined,
    before: action === "setStepField" ? short(e.before) : undefined,
    after: action === "setStepField" ? short(e.after) : undefined,
  };
}

/** How a caption will be split into on-screen cues — the renderer's own wrap (render/captions.ts
 * wrapCaption: 42 characters a line, 2 lines a cue), so the Studio's hint can't drift from it. */
export function captionCues(text: string): { lines: number; cues: number } {
  const cues = wrapCaption({ t0: 0, t1: 1, text });
  return { lines: cues.reduce((n, c) => n + c.text.split("\n").length, 0), cues: cues.length };
}

/** Rough spoken length of a step: ~14 characters a second of narration plus its hold, floored
 * at 1.5 s — a stand-in for timeline widths until narration is synthesized. */
export function estimateSeconds(step: { say?: string; hold?: number }): number {
  return Math.max(1.5, (step.say ?? "").length / 14) + (step.hold ?? 0);
}

/** Which history entries (by their position in the file's oldest-first order) an `undo:` entry
 * has already reverted, and whether anything — or anything by an agent — is left to undo. Mirrors
 * the engine's own findLastUndoable (edit/history.ts) so the Undo buttons only enable when the
 * engine would actually find something. */
export function undoState(oldestFirst: HistoryEntry[]): { undone: Set<number>; canUndo: boolean; canUndoAgent: boolean } {
  const undone = new Set<number>();
  for (const e of oldestFirst) if (e.action.startsWith("undo:") && typeof e.undoOf === "number") undone.add(e.undoOf);
  const open = oldestFirst.filter((e, i) => !e.action.startsWith("undo:") && !undone.has(i));
  return { undone, canUndo: open.length > 0, canUndoAgent: open.some((e) => e.by === "agent") };
}
