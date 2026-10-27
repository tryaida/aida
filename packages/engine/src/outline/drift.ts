// Outline drift (M29): compare the on-screen names an outline card promises with the names a
// capture actually found, and keep the card's `drift` list up to date. Pure functions; the
// file-writing side is in record.ts.
import { targetNames } from "../capture/target-names.js";
import type { CaptureManifest, ManifestStep } from "../capture/types.js";
import type { Walkthrough } from "../walkthrough/index.js";
import type { DriftEntry, OutlineCard } from "./schema.js";

/**
 * A name a capture saw, and the step it was seen in. `source` says how we know: `screen` is a real
 * accessible name or heading the capture read off the page (manifest `seen`); `target` is only
 * the walkthrough's own target string (manifests written before `seen` existed), which Playwright
 * matched as a substring, so the real name may be longer. Absent means `screen`.
 */
export interface SeenName {
  name: string;
  step?: string;
  source?: "screen" | "target";
}

/** A `{{...}}` template is demo data filled in at capture time, never an on-screen name. */
const isTemplated = (s: string) => s.includes("{{");

/** Strings in straight or curly double quotes: `Record a "Cash" payment` -> ["Cash"]. Quoted
 * `{{...}}` templates are skipped. */
export function quotedStrings(text: string | undefined): string[] {
  if (!text) return [];
  const out: string[] = [];
  for (const m of text.matchAll(/"([^"\n]+)"|“([^”\n]+)”/g)) {
    const s = (m[1] ?? m[2]).trim();
    if (s && !isTemplated(s)) out.push(s);
  }
  return out;
}

/** A card's promised on-screen names: `labels`, plus quoted strings in its title and purpose. */
export function cardLabels(card: Pick<OutlineCard, "labels" | "title" | "purpose">): string[] {
  const all = [...(card.labels ?? []), ...quotedStrings(card.title), ...quotedStrings(card.purpose)];
  const seen = new Set<string>();
  return all.filter((l) => {
    const key = l.trim().toLowerCase();
    if (!key || isTemplated(key) || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function tokens(s: string): string[] {
  return s
    .normalize("NFKC")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

/**
 * Case-insensitive match: the label's words appear, in order and next to each other, in the seen
 * name. So "Add session" matches a button named "Add session" or "+ Add session", but "Register
 * again" doesn't match "Register".
 */
export function labelMatches(label: string, name: string): boolean {
  const l = tokens(label);
  const n = tokens(name);
  if (l.length === 0) return label.trim().toLowerCase() === name.trim().toLowerCase();
  for (let i = 0; i + l.length <= n.length; i++) {
    if (l.every((t, j) => n[i + j] === t)) return true;
  }
  return false;
}

function levenshtein(a: string, b: string): number {
  const prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const up = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = up;
    }
  }
  return prev[b.length];
}

/** 0..1: half character edit distance, half shared words. */
export function similarity(a: string, b: string): number {
  const ta = tokens(a);
  const tb = tokens(b);
  const sa = ta.join(" ");
  const sb = tb.join(" ");
  const longest = Math.max(sa.length, sb.length);
  const chars = longest === 0 ? 0 : 1 - levenshtein(sa, sb) / longest;
  const setB = new Set(tb);
  const shared = new Set(ta.filter((t) => setB.has(t))).size;
  const words = ta.length + tb.length === 0 ? 0 : (2 * shared) / (new Set(ta).size + setB.size);
  return 0.5 * chars + 0.5 * words;
}

/** Below this, nothing on screen is close enough to suggest as the card's real name: the drift
 * entry gets no `seen`. Deliberately high: a wrong rename suggestion is worse than none. */
export const MIN_SIMILARITY = 0.55;

/** The on-screen name most like `label`, if one is close enough to suggest. Only real screen
 * names count: a walkthrough's own target string is never offered as a rename. */
export function closestName(label: string, seen: readonly SeenName[]): SeenName | undefined {
  let best: SeenName | undefined;
  let bestScore = MIN_SIMILARITY;
  for (const s of seen) {
    if (s.source === "target") continue;
    const score = similarity(label, s.name);
    if (score > bestScore) {
      best = s;
      bestScore = score;
    }
  }
  return best;
}

/** A manifest step's `seen` (the real accessible names of the elements its actions resolved, plus
 * the step's h1-h3 headings); undefined in a manifest written before the field existed. */
function stepSeen(step: ManifestStep): string[] | undefined {
  return Array.isArray(step.seen) ? step.seen.filter((s): s is string => typeof s === "string") : undefined;
}

/**
 * Every name a capture saw, by step. Prefers the manifest's per-step `seen` (real on-screen names,
 * `source: "screen"`). A manifest without `seen` falls back to the walkthrough's target strings
 * (`source: "target"`): the step's recorded `targets`, or for a manifest older than that, the
 * walkthrough's own targets for the steps the manifest recorded.
 */
export function seenNames(manifest: CaptureManifest, walkthrough?: Walkthrough): SeenName[] {
  const out: SeenName[] = [];
  if (manifest.steps.some((s) => stepSeen(s) !== undefined)) {
    for (const step of manifest.steps) {
      for (const name of stepSeen(step) ?? []) out.push({ name, ...(step.id ? { step: step.id } : {}), source: "screen" });
    }
    return out;
  }
  const recorded = manifest.steps.some((s) => Array.isArray(s.targets));
  manifest.steps.forEach((step, i) => {
    let names = step.targets;
    if (!recorded && walkthrough) {
      const source = (step.id ? walkthrough.steps.find((w) => w.id === step.id) : undefined) ?? walkthrough.steps[i];
      names = targetNames(source?.actions);
    }
    for (const name of names ?? []) out.push({ name, ...(step.id ? { step: step.id } : {}), source: "target" });
  });
  return out;
}

export interface DriftResult {
  drift: DriftEntry[];
  /** Entries new this time. */
  added: DriftEntry[];
  /** Entries whose expected name now appears on screen. */
  cleared: DriftEntry[];
}

const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/**
 * Whether a card label was on a captured screen. It was if a seen name contains the label's words
 * (`labelMatches`), which covers the case where a walkthrough target is only part of the label
 * (target `name: "Save"`, Playwright substring-matched the button "Save session") and the real
 * name recorded in `seen` equals the label. A walkthrough target string alone only confirms a
 * label it contains; it never rules a label out.
 */
export function labelSeen(label: string, seen: readonly SeenName[]): boolean {
  return seen.some((s) => labelMatches(label, s.name));
}

/**
 * The card's drift after a capture that saw `seen`:
 * - any entry (capture or writer) whose `expected` name now appears is cleared;
 * - each card label with no match gets a capture entry, `seen` set to the closest real screen
 *   name when one is close (never a walkthrough target string);
 *   an existing entry keeps its `at`;
 * - capture entries for labels no longer on the card are dropped; writer entries stay.
 */
export function computeDrift(card: OutlineCard, seen: readonly SeenName[], at: string): DriftResult {
  const labels = cardLabels(card);
  const found = (label: string) => labelSeen(label, seen);
  const existing = card.drift ?? [];
  const cleared: DriftEntry[] = [];
  const added: DriftEntry[] = [];
  const drift: DriftEntry[] = [];

  for (const entry of existing) {
    if (found(entry.expected)) {
      cleared.push(entry);
      continue;
    }
    if (entry.source === "writer") drift.push(entry);
    // Capture entries are rebuilt below from the card's current labels.
  }

  for (const label of labels) {
    if (found(label)) continue;
    if (drift.some((d) => d.source === "writer" && same(d.expected, label))) continue;
    const close = closestName(label, seen);
    const before = existing.find((d) => d.source === "capture" && same(d.expected, label));
    const entry: DriftEntry = {
      expected: label,
      ...(close ? { seen: close.name } : {}),
      ...(close?.step ? { step: close.step } : {}),
      at: before?.at ?? at,
      source: "capture",
    };
    if (!before) added.push(entry);
    drift.push(entry);
  }

  return { drift, added, cleared };
}

/** `"Save session" (saw "Add session" at step add)` */
export function describeDrift(d: DriftEntry): string {
  const where = d.step ? ` at step ${d.step}` : "";
  if (d.seen) return `"${d.expected}" (saw "${d.seen}"${where})`;
  return `"${d.expected}" (${d.source === "writer" ? "writer: not on screen" : "not seen on any captured screen"}${where})`;
}
