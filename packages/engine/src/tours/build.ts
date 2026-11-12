// Builds `<publicDir>/tours/<id>.json` (M46): the same walkthrough as an in-app tour that points
// at each step's element in the reader's own browser while the reader does the work.
//
// A tour exists only for a walkthrough that is publishable and whose main capture passed and
// recorded tour hints, and only lists steps seen working (scope.md "Truthfulness"). v1 covers
// the main path on the primary device: alternate `paths` and steps the primary device never ran
// (phone-only) are left out.
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { usableDeviceCapture } from "../capture/secondary.js";
import { alignManifestToSteps } from "../capture/align.js";
import { cleanHints, masksField, underBlur } from "../capture/hints.js";
import { maskSecretFieldValues, redactSnapshot } from "../capture/redact.js";
import type { Box, CaptureManifest, ElementHints, ManifestStep, TourActionHints } from "../capture/types.js";
import { stripMarkdown } from "../index-search/index.js";
import { taskRouteBlur } from "../render/clips.js";
import { blurWindowsByScreen } from "../render/timeline.js";
import { matchRoutePattern, normalizePathname, routePatternFor, routeToPattern } from "../routes/pattern.js";
import { displayWalkthrough, libraryPlacement, resolveDisplayText, stepInstruction, type Action, type Step, type Walkthrough } from "../walkthrough/index.js";
import { TOUR_VERSION, type BuildToursResult, type Tour, type TourAction, type TourAdvance, type TourSkip, type TourStep } from "./types.js";

/** The tour id tour.js accepts (`aida-tour=<id>`); a walkthrough id that isn't one gets no tour. */
export const TOUR_ID = /^[a-z0-9][a-z0-9-]*$/;
const EXAMPLE_CAP = 200;

export interface BuildToursOptions {
  /** Each publishable walkthrough this run built, with its own (primary, main-path) capture dir —
   * the same list `buildProcedures` gets. */
  sources: { wf: Walkthrough; captureDir: string }[];
  /** The help app's `public/`: tours are written to `tours/<id>.json` in it. */
  publicDir: string;
  /** Every walkthrough id this run attempted (publishable or not). A tour file for one of these
   * that this run didn't write is removed. Defaults to `sources`' ids. */
  attemptedIds?: string[];
  /** Every walkthrough id on disk. A tour file for any other id is removed. Omit to skip. */
  validIds?: string[];
  /** The app's routes (framework form or patterns), relative to `basePath`, when known, for
   * `routePatternFor`. */
  knownRoutes?: string[];
  /** The path part of the app's base URL ("/app" for `http://localhost:3000/app`), as
   * `buildHelpMap` takes it. Capture records full pathnames; every screen pattern, link pattern
   * and `start.path` in a tour is made relative to this (tour.js strips the same prefix: its
   * script tag's `data-base-path`, or `start({ basePath })`). A walkthrough that passes a screen
   * outside it gets no tour. */
  basePath?: string;
}

function toursDir(publicDir: string): string {
  return join(publicDir, "tours");
}

/** Ids of the tour files in `<publicDir>/tours/`, sorted. */
export function tourIds(publicDir: string): string[] {
  const dir = toursDir(publicDir);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json") && TOUR_ID.test(f.slice(0, -5)))
    .map((f) => f.slice(0, -5))
    .sort();
}

// --- screens --------------------------------------------------------------------------------

/** "/app/" -> "/app"; "", "/" and anything unusable -> undefined (no base path). */
function cleanBasePath(basePath: string | undefined): string | undefined {
  if (!basePath) return undefined;
  const path = normalizePathname(basePath);
  return path === "/" ? undefined : path;
}

/** `path` relative to `base`, or undefined when it lies outside it. */
function underBase(path: string, base: string | undefined): string | undefined {
  const pathname = normalizePathname(path);
  if (!base) return pathname;
  if (pathname === base) return "/";
  return pathname.startsWith(`${base}/`) ? pathname.slice(base.length) : undefined;
}

function slugOf(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Every printable demo value in a walkthrough's `data`, lowercased and as a slug (the help map
 * reads them the same way, help-map/build.ts): a record the run created goes by these. */
function demoValues(wf: Walkthrough): Set<string> {
  const out = new Set<string>();
  const data = wf.data;
  if (!data) return out;
  const visit = (value: unknown, depth: number): void => {
    if (depth > 6) return;
    if (typeof value === "string" || typeof value === "number") {
      const text = resolveDisplayText(String(value), data).trim();
      // One or two characters ("a", "en") are too likely to turn up in a real name by chance.
      if (text.length < 3) return;
      out.add(text.toLowerCase());
      const slug = slugOf(text);
      if (slug.length >= 3) out.add(slug);
    } else if (Array.isArray(value)) value.forEach((v) => visit(v, depth + 1));
    else if (value && typeof value === "object") Object.values(value).forEach((v) => visit(v, depth + 1));
  };
  visit(data, 0);
  return out;
}

/** A pattern with wildcards and no literal segment matches nearly every screen. */
function tooBroad(pattern: string): boolean {
  const segments = pattern.split("/").filter(Boolean);
  return segments.length > 0 && segments.every((s) => s === "*" || s === "**");
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/**
 * The screen pattern for an app-relative path: the most specific known route, else record ids and
 * the walkthrough's own demo values as `*`. A demo value only stands for a record right after a
 * literal segment ("/teams/acme/settings": "teams" names the collection, "acme" the record).
 */
function screenPattern(path: string, knownRoutes: string[], demo: Set<string>): string {
  const routes = knownRoutes.map(routeToPattern).filter((p) => !tooBroad(p));
  if (routes.some((p) => matchRoutePattern(p, path))) return routePatternFor(path, routes);
  const plain = routePatternFor(path).split("/").filter(Boolean);
  if (!demo.size) return `/${plain.join("/")}`;
  const raw = normalizePathname(path).split("/").filter(Boolean);
  const out: string[] = [];
  raw.forEach((segment, i) => {
    const decoded = decodeSegment(segment).toLowerCase();
    const isDemo = demo.has(decoded) || demo.has(slugOf(decoded));
    const afterLiteral = i === 0 || (out[i - 1] !== "*" && out[i - 1] !== "**");
    out.push(plain[i] === "*" || (isDemo && afterLiteral) ? "*" : segment);
  });
  const pattern = `/${out.join("/")}`;
  return tooBroad(pattern) ? `/${plain.join("/")}` : pattern;
}

// --- what a tour may know about an element --------------------------------------------------

/** True when an attribute value holds one of the run's demo values (`customer-jane-smith`): it
 * names the record the walkthrough made, which the reader doesn't have. */
function holdsDemoValue(value: string, demo: Set<string>): boolean {
  const v = value.toLowerCase();
  const slug = slugOf(value);
  for (const d of demo) if (v.includes(d) || slug.includes(d)) return true;
  return false;
}

/**
 * The hints as a tour file carries them: ids, test ids and `name` attributes that hold a demo
 * value dropped, a link's path made app-relative and a screen pattern (dropped when it leaves the
 * base path). Undefined when nothing identifying is left.
 */
function tourTarget(h: ElementHints, demo: Set<string>, toPattern: (path: string) => string | undefined, container = false): ElementHints | undefined {
  const out: ElementHints = { ...h };
  for (const key of ["id", "testId", "nameAttr"] as const) {
    const v = out[key];
    if (v !== undefined && holdsDemoValue(v, demo)) delete out[key];
  }
  if (out.href !== undefined) {
    const pattern = toPattern(out.href);
    if (pattern) out.href = pattern;
    else delete out.href;
  }
  delete out.within;
  if (!container && h.within) {
    const w = tourTarget(h.within, demo, toPattern, true);
    if (w) out.within = w;
  }
  const identifying = out.testId || out.id || out.name || out.label || out.text || out.placeholder || out.nameAttr || out.href;
  return identifying ? out : undefined;
}

// --- blur, per screen, as the video applies it ----------------------------------------------

/** A step's own `blur:` boxes as this run resolved them (render/timeline.ts reads them the same). */
function resolvedBlur(step: Step, cap: ManifestStep | undefined): Box[] {
  if (!cap || !step.blur || step.blur.length === 0) return [];
  const resolved = new Map((cap.doc.blur ?? []).map((b) => [b.id, b.box] as const));
  return step.blur.map((b) => resolved.get(b.id)).filter((b): b is Box => b !== undefined);
}

/**
 * The blur on screen during each display step, exactly as the video draws it: every step's boxes
 * unioned per screen, across every capture of the task, as full-height bands on a screen that
 * scrolls (render/timeline.ts `blurWindowsByScreen`, render/clips.ts `taskRouteBlur`). Asked of the
 * renderer itself, so a tour and the video can't disagree about what is hidden.
 */
function blurByStep(display: Walkthrough, manifest: CaptureManifest, captureDir: string, aligned: ({ mStep: ManifestStep } | undefined)[]): Box[][] {
  const n = display.steps.length;
  const windows = display.steps.map((step, i) => ({ t0: i, t1: i + 1, boxes: resolvedBlur(step, aligned[i]?.mStep) }));
  const out: Box[][] = display.steps.map(() => []);
  // Each window keeps its step's `t0` (the first is stretched back to 0, which is step 0 anyway).
  for (const w of blurWindowsByScreen(display, manifest, windows, n, taskRouteBlur(display, manifest, captureDir))) {
    const i = Math.round(w.t0);
    if (i >= 0 && i < n) out[i] = w.boxes;
  }
  return out;
}

/** The action's element with whatever the screen's blur covers taken out (`cleanHints` with
 * `hidden`), and whether anything was. Position unknown (an older manifest) counts as covered. */
function unblurred(h: TourActionHints, blur: Box[], docScroll: { x: number; y: number } | undefined): { target: ElementHints | undefined; hidden: boolean } {
  if (blur.length === 0) return { target: h.target, hidden: false };
  const at = h.at;
  const hidden = at ? underBlur(at.boxes, blur, at.scroll, docScroll) : true;
  const withinHidden = h.target.within ? (at?.within ? underBlur(at.within, blur, at.scroll, docScroll) : true) : false;
  if (!hidden && !withinHidden) return { target: h.target, hidden: false };
  return { target: cleanHints(h.target, { hidden, withinHidden }), hidden };
}

// --- examples -------------------------------------------------------------------------------

/** The demo value to show beside a field, or undefined when it may not be shown. */
function exampleFor(value: string, data: Walkthrough["data"], target: ElementHints, masked: boolean): string | undefined {
  if (masked || target.type === "password") return undefined;
  const v = resolveDisplayText(value, data).replace(/\s+/g, " ").trim();
  if (!v || v.includes("{{") || v.length > EXAMPLE_CAP) return undefined;
  // A field whose name says its value is a secret (password, PIN, card number, ...) shows none,
  // by the same rule capture's reports mask such fields with.
  const fieldName = target.label ?? target.name ?? target.placeholder ?? "";
  const line = `- textbox ${JSON.stringify(fieldName)}: x`;
  if (maskSecretFieldValues(line) !== line) return undefined;
  if (redactSnapshot(v) !== v) return undefined;
  return v;
}

/** True when masking may hide this field's value on screen: capture said so, or the step's
 * `mask` names it by any name it goes by. A field with nothing to compare, on a step that masks
 * something, counts as masked: when in doubt, no example. */
function fieldMasked(step: Step, action: Action, h: TourActionHints, target: ElementHints): boolean {
  if (h.masked) return true;
  const t = "target" in action ? action.target : undefined;
  if (masksField(step.mask, target.label, target.name, target.placeholder, h.target.label, h.target.name, t?.label, t?.name, t?.placeholder)) return true;
  return (step.mask?.length ?? 0) > 0 && !target.label && !target.name;
}

function kindAndAdvance(a: Action, target: ElementHints): { kind: TourAction["kind"]; advance: TourAdvance } | undefined {
  switch (a.do) {
    case "click":
      return { kind: "click", advance: "click" };
    case "type":
      return { kind: "type", advance: "change" };
    case "select":
      // A custom dropdown changes nothing tour.js can see without reading it: Next.
      return { kind: "select", advance: target.tag === "select" ? "change" : "manual" };
    case "press":
      return a.target ? { kind: "press", advance: "manual" } : undefined;
    case "hover":
    case "focus":
    case "point":
      return { kind: a.do, advance: "manual" };
    default:
      return undefined;
  }
}

/** One walkthrough's tour, or the reason it has none. */
export function buildTour(
  wf: Walkthrough,
  captureDir: string,
  knownRoutes: string[] = [],
  basePath?: string,
): { tour: Tour } | { reason: string } {
  const id = wf.walkthrough;
  if (!TOUR_ID.test(id)) return { reason: `id "${id}" isn't lower-case letters, digits and dashes` };
  const usable = usableDeviceCapture(captureDir);
  if (!usable) return { reason: "no passing capture" };
  const { manifest, validation } = usable;
  if (!manifest.steps.some((s) => s.tour)) return { reason: "captured before tours existed: capture it again" };

  const display = displayWalkthrough(wf);
  const aligned = alignManifestToSteps<ManifestStep>(manifest.steps, display.steps.length);
  const base = cleanBasePath(basePath);
  const demo = demoValues(wf);
  // Captured paths are full pathnames: relative to the base path first, then a pattern.
  const toPattern = (path: string): string | undefined => {
    const relative = underBase(path, base);
    return relative === undefined ? undefined : screenPattern(relative, knownRoutes, demo);
  };
  const outside = (path: string) => ({ reason: `screen ${path} is outside the app's base path ${base}` });
  // The start page is already relative to the base URL (capture opens `baseUrl + page`).
  const startPage = display.start?.page ? resolveDisplayText(display.start.page, wf.data) : undefined;
  const firstPath = aligned.find((a) => a?.mStep.tour?.path)?.mStep.tour?.path;
  let startPath: string;
  if (startPage && !startPage.includes("{{")) startPath = normalizePathname(startPage);
  else if (firstPath) {
    const relative = underBase(firstPath, base);
    if (relative === undefined) return outside(firstPath);
    startPath = relative;
  } else startPath = "/";
  const blur = blurByStep(display, manifest, captureDir, aligned);

  const steps: TourStep[] = [];
  let lastScreen = screenPattern(startPath, knownRoutes, demo);
  let pointsAtSomething = false;
  for (let i = 0; i < display.steps.length; i++) {
    const step = display.steps[i]!;
    const a = aligned[i];
    // A step the primary device never ran (phone-only) is left out: nobody saw it work here.
    if (!a) continue;
    if (validation.steps[a.index] && !validation.steps[a.index]!.ok) return { reason: `step ${i + 1} didn't pass` };
    const hints = a.mStep.tour;
    let screen = lastScreen;
    if (hints?.path) {
      const p = toPattern(hints.path);
      if (p === undefined) return outside(hints.path);
      screen = p;
    }
    lastScreen = screen;
    const actions: TourAction[] = [];
    for (const h of hints?.actions ?? []) {
      const action = step.actions[h.action];
      if (!action) continue;
      const actionScreen = toPattern(h.path);
      if (actionScreen === undefined) return outside(h.path);
      const shown = unblurred(h, blur[i] ?? [], hints?.scroll);
      const target = shown.target ? tourTarget(shown.target, demo, toPattern) : undefined;
      if (!target) continue;
      const ka = kindAndAdvance(action, target);
      if (!ka) continue;
      const masked = shown.hidden || fieldMasked(step, action, h, target);
      const raw = action.do === "type" ? action.text : action.do === "select" ? action.option : undefined;
      const example = raw !== undefined ? exampleFor(raw, wf.data, target, masked) : undefined;
      actions.push({
        kind: ka.kind,
        target,
        ...(example ? { example } : {}),
        advance: ka.advance,
        ...(actionScreen !== screen ? { screen: actionScreen } : {}),
      });
      lastScreen = actionScreen;
    }
    if (actions.length > 0) pointsAtSomething = true;
    steps.push({
      id: step.id ?? `step-${i + 1}`,
      title: step.title ?? `Step ${i + 1}`,
      text: stripMarkdown(stepInstruction(step, wf.data)),
      screen,
      actions,
    });
  }
  if (!pointsAtSomething) return { reason: "no step has an element to point at" };

  return {
    tour: {
      version: TOUR_VERSION,
      id,
      title: display.title,
      guideUrl: libraryPlacement(wf.section, id).url,
      start: { path: startPath, pattern: screenPattern(startPath, knownRoutes, demo) },
      steps,
    },
  };
}

/**
 * Writes a tour file for each source that qualifies, removes tour files for walkthroughs this run
 * attempted that no longer qualify (and, with `validIds`, for deleted ones), and leaves every
 * other tour file alone, so a scoped build keeps the rest.
 */
export function buildTours(opts: BuildToursOptions): BuildToursResult {
  const dir = toursDir(opts.publicDir);
  const written: string[] = [];
  const skipped: TourSkip[] = [];
  const sourceIds = new Set(opts.sources.map((s) => s.wf.walkthrough));
  for (const source of opts.sources) {
    const id = source.wf.walkthrough;
    const result = buildTour(source.wf, source.captureDir, opts.knownRoutes, opts.basePath);
    if ("reason" in result) {
      skipped.push({ id, reason: result.reason });
      continue;
    }
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${id}.json`), `${JSON.stringify(result.tour)}\n`, "utf8");
    written.push(id);
  }
  for (const id of opts.attemptedIds ?? []) {
    if (!sourceIds.has(id)) skipped.push({ id, reason: "not publishable" });
  }

  const attempted = new Set(opts.attemptedIds ?? sourceIds);
  for (const id of sourceIds) attempted.add(id);
  const valid = opts.validIds ? new Set(opts.validIds) : undefined;
  const keep = new Set(written);
  for (const id of tourIds(opts.publicDir)) {
    if (keep.has(id)) continue;
    if (attempted.has(id) || (valid && !valid.has(id))) rmSync(join(dir, `${id}.json`), { force: true });
  }
  return { written: written.sort(), skipped: skipped.sort((a, b) => a.id.localeCompare(b.id)), ids: tourIds(opts.publicDir) };
}
