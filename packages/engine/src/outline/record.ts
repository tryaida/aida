// Writing drift and notes back to `outline.yaml`: after a capture (`recordCaptureDrift`, called
// by `aida capture` and `aida build`), from the latest capture manifests on disk
// (`checkOutline`, `aida outline check`) and by hand (`noteCard`, `aida outline note`).
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { CaptureManifest, ValidationResult } from "../capture/types.js";
import { readPathCaptures } from "../capture/path-files.js";
import { loadWalkthroughFile, type Walkthrough } from "../walkthrough/index.js";
import { computeDrift, describeDrift, quotedStrings, seenNames, type DriftResult } from "./drift.js";
import {
  addCard,
  appendNote,
  findCard,
  outlinePath,
  setDrift,
  setStatus,
  updateOutline,
  OutlineError,
  type LoadedOutline,
  type OutlineConfigLike,
} from "./file.js";
import { CARD_ID_PATTERN, type DriftEntry, type OutlineCard } from "./schema.js";

const sameJson = (a: unknown, b: unknown) => JSON.stringify(a ?? []) === JSON.stringify(b ?? []);

/** True when every step of the walkthrough ran and passed (database checks aside: drift is about the screen). */
function stepsPassed(walkthrough: Walkthrough, validation: Pick<ValidationResult, "steps">): boolean {
  return validation.steps.length === walkthrough.steps.length && validation.steps.every((s) => s.ok);
}

/** Applies one passing capture to a card in the loaded document. Returns whether anything changed. */
function applyCapture(
  loaded: LoadedOutline,
  card: OutlineCard,
  manifest: CaptureManifest,
  walkthrough: Walkthrough,
  at: string,
  pathManifests: CaptureManifest[] = [],
): { changed: boolean; result: DriftResult } {
  // A label may be on any way in (decision 34): the main run's screens and every passing path's.
  const seen = [...seenNames(manifest, walkthrough), ...pathManifests.flatMap((m) => seenNames(m))];
  const result = computeDrift(card, seen, at);
  let changed = false;
  if (card.status !== "captured") {
    setStatus(loaded.doc, card.id, "captured");
    card.status = "captured";
    changed = true;
  }
  if (!sameJson(card.drift, result.drift)) {
    setDrift(loaded.doc, card.id, result.drift);
    card.drift = result.drift.length > 0 ? result.drift : undefined;
    changed = true;
  }
  return { changed, result };
}

/** The one line a capture prints about drift, or null when there's nothing worth saying. */
export function driftLine(id: string, result: DriftResult): string | null {
  if (result.drift.length > 0) {
    const n = result.drift.length;
    return `outline: ${id}: ${n} name${n === 1 ? "" : "s"} on the card ${n === 1 ? "differs" : "differ"} from the screen: ${result.drift.map(describeDrift).join("; ")}`;
  }
  if (result.cleared.length > 0) return `outline: ${id}: card matches the screen now (${result.cleared.length} difference${result.cleared.length === 1 ? "" : "s"} cleared)`;
  return null;
}

export interface CaptureDriftInput {
  config: OutlineConfigLike;
  walkthrough: Walkthrough;
  manifest: CaptureManifest;
  validation: Pick<ValidationResult, "steps">;
  /** Manifests of the walkthrough's paths that passed this run (decision 34). */
  pathManifests?: CaptureManifest[];
  now?: Date;
}

/**
 * After a capture: record drift on the walkthrough's card and mark it captured. Quiet (null) when
 * there's no outline file, no card for this walkthrough, the card is dropped, or the capture
 * didn't pass. Never throws: a broken outline file gives a one-line note instead, so drift can
 * never fail a capture.
 */
export function recordCaptureDrift(input: CaptureDriftInput): string | null {
  try {
    if (!stepsPassed(input.walkthrough, input.validation)) return null;
    // Read, change and write under the outline lock, so a capture never overwrites a writer's
    // `outline note` made at the same moment (or the other way round).
    return updateOutline(outlinePath(input.config), (loaded) => {
      if (!loaded) return null;
      const card = findCard(loaded.outline, input.walkthrough.walkthrough);
      if (!card || card.status === "dropped") return null;
      const { result } = applyCapture(loaded, card, input.manifest, input.walkthrough, (input.now ?? new Date()).toISOString(), input.pathManifests);
      return driftLine(card.id, result);
    });
  } catch (err) {
    return `outline: not updated: ${((err as Error).message ?? String(err)).split("\n")[0]}`;
  }
}

export type CheckState = "checked" | "not-written" | "not-captured" | "capture-failed" | "dropped";

export interface CheckedCard {
  id: string;
  status: OutlineCard["status"];
  state: CheckState;
  drift: DriftEntry[];
  cleared: DriftEntry[];
}

function readJson<T>(file: string): T | undefined {
  if (!existsSync(file)) return undefined;
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch {
    return undefined;
  }
}

/** Finds a walkthrough by id: `<id>.yaml` first, else any file that loads with that id. */
export function findWalkthrough(dir: string, id: string): Walkthrough | undefined {
  if (!existsSync(dir)) return undefined;
  for (const name of [`${id}.yaml`, `${id}.yml`]) {
    const file = join(dir, name);
    if (existsSync(file)) {
      try {
        return loadWalkthroughFile(file);
      } catch {
        return undefined;
      }
    }
  }
  for (const name of readdirSync(dir).filter((f) => /\.ya?ml$/i.test(f))) {
    try {
      const w = loadWalkthroughFile(join(dir, name));
      if (w.walkthrough === id) return w;
    } catch {
      // A walkthrough that doesn't load isn't this card's concern; validate reports it.
    }
  }
  return undefined;
}

/** Ids of every walkthrough in `dir`: the id a file loads with, or its file name when it doesn't
 * load (it's still a walkthrough someone wrote; validate reports why it's broken). */
export function walkthroughIds(dir: string): Set<string> {
  const ids = new Set<string>();
  if (!existsSync(dir)) return ids;
  for (const name of readdirSync(dir).filter((f) => /\.ya?ml$/i.test(f))) {
    try {
      ids.add(loadWalkthroughFile(join(dir, name)).walkthrough);
    } catch {
      ids.add(name.replace(/\.ya?ml$/i, ""));
    }
  }
  return ids;
}

/**
 * `aida outline check`: recomputes drift for the named cards (default: every card that isn't
 * dropped) from each walkthrough's latest capture in `<buildDir>/<id>/capture/`, marks cards
 * whose walkthrough now exists as written, and writes the outline once.
 */
export function checkOutline(
  config: OutlineConfigLike & { buildDir: string },
  ids: string[],
  now = new Date(),
): { file: string; exists: boolean; cards: CheckedCard[] } {
  const file = outlinePath(config);
  return updateOutline(file, (loaded) => (loaded ? checkLoaded(loaded, config, ids, now) : { file, exists: false, cards: [] }));
}

function checkLoaded(
  loaded: LoadedOutline,
  config: OutlineConfigLike & { buildDir: string },
  ids: string[],
  now: Date,
): { file: string; exists: boolean; cards: CheckedCard[] } {
  for (const id of ids) if (!findCard(loaded.outline, id)) throw new OutlineError(`no card "${id}" in the outline (aida outline list)`);
  const cards = ids.length > 0 ? ids.map((id) => findCard(loaded.outline, id)!) : loaded.outline.cards;
  const at = now.toISOString();
  const out: CheckedCard[] = [];

  for (const card of cards) {
    const row = (state: CheckState, cleared: DriftEntry[] = []): CheckedCard => ({ id: card.id, status: card.status, state, drift: card.drift ?? [], cleared });
    if (card.status === "dropped") {
      out.push(row("dropped"));
      continue;
    }
    const walkthrough = findWalkthrough(config.walkthroughsDir, card.id);
    if (!walkthrough) {
      out.push(row("not-written"));
      continue;
    }
    if (card.status === "planned") {
      setStatus(loaded.doc, card.id, "written");
      card.status = "written";
    }
    const captureDir = join(config.buildDir, card.id, "capture");
    const manifest = readJson<CaptureManifest>(join(captureDir, "manifest.json"));
    const validation = readJson<ValidationResult>(join(captureDir, "validation.json"));
    if (!manifest || !validation) {
      out.push(row("not-captured"));
      continue;
    }
    if (!stepsPassed(walkthrough, validation)) {
      out.push(row("capture-failed"));
      continue;
    }
    const pathManifests = readPathCaptures(captureDir, walkthrough)
      .filter((p) => p.manifest && p.validation?.ok)
      .map((p) => p.manifest!);
    const applied = applyCapture(loaded, card, manifest, walkthrough, at, pathManifests);
    out.push(row("checked", applied.result.cleared));
  }

  // updateOutline writes the document back if anything above changed it.
  return { file: loaded.file, exists: true, cards: out };
}

export interface NoteOptions {
  /** The name the card promised. Default: the text's only quoted string, if it has exactly one. */
  expected?: string;
  /** What the screen has instead, if anything. */
  seen?: string;
  step?: string;
  /** Where to look for the walkthrough when the card is missing and has to be added. */
  walkthroughsDir?: string;
}

export interface NoteResult {
  /** The writer drift entry recorded, when the note names an expected label. */
  drift?: DriftEntry;
  /** The card added because the walkthrough had none (e.g. a walkthrough CI wrote without a plan). */
  added?: OutlineCard;
}

/**
 * The minimal card for a walkthrough that has none: its id, the walkthrough's title (or the id,
 * when there's no walkthrough file yet), status `written` (`planned` without a walkthrough).
 */
function minimalCard(id: string, walkthroughsDir: string | undefined): OutlineCard {
  if (!CARD_ID_PATTERN.test(id)) throw new OutlineError(`no card "${id}" in the outline, and "${id}" isn't a walkthrough id (kebab-case)`);
  const walkthrough = walkthroughsDir ? findWalkthrough(walkthroughsDir, id) : undefined;
  return { id, title: walkthrough?.title?.trim() || id, status: walkthrough ? "written" : "planned" };
}

/**
 * `aida outline note`: a writer records a difference capture can't catch (a button that isn't
 * there at all). The text goes to the card's notes; with an expected name it's also a writer drift
 * entry, replacing an earlier one for the same name. A walkthrough with no card gets a minimal one
 * first (`added` in the result). Changes the document only; write it with `updateOutline`.
 */
export function noteCard(loaded: LoadedOutline, id: string, text: string, opts: NoteOptions = {}, now = new Date()): NoteResult {
  let card = findCard(loaded.outline, id);
  let added: OutlineCard | undefined;
  if (!card) {
    added = minimalCard(id, opts.walkthroughsDir);
    addCard(loaded.doc, added);
    card = { ...added };
    loaded.outline.cards.push(card);
  }
  appendNote(loaded.doc, id, text);
  const quoted = quotedStrings(text);
  const expected = opts.expected ?? (quoted.length === 1 ? quoted[0] : undefined);
  let entry: DriftEntry | undefined;
  if (expected) {
    entry = {
      expected,
      ...(opts.seen ? { seen: opts.seen } : {}),
      ...(opts.step ? { step: opts.step } : {}),
      at: now.toISOString(),
      source: "writer",
    };
    const rest = (card.drift ?? []).filter((d) => d.expected.trim().toLowerCase() !== expected.trim().toLowerCase());
    setDrift(loaded.doc, id, [...rest, entry]);
  }
  return { ...(entry ? { drift: entry } : {}), ...(added ? { added } : {}) };
}

/** `noteCard` as one locked read-modify-write of the config's outline file. `null` when there's
 * no outline file. */
export function noteOutline(
  config: OutlineConfigLike,
  id: string,
  text: string,
  opts: Omit<NoteOptions, "walkthroughsDir"> = {},
  now = new Date(),
): NoteResult | null {
  return updateOutline(outlinePath(config), (loaded) =>
    loaded ? noteCard(loaded, id, text, { ...opts, walkthroughsDir: config.walkthroughsDir }, now) : null,
  );
}
