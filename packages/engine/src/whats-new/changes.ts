// What changed in a release, step by step where the evidence allows (decision 45; M48). Three
// rules, tried in this order for each publishable guide:
//   - "screenshots": its published step screenshots (`public/screenshots/<id>/step-NN.png`) are
//     compared with the same steps' screenshots at the base ref in git — matched by step id
//     through the walkthrough as it was at the base ref, so inserting or deleting a step doesn't
//     make every later step look changed — and a step counts as changed only past the share of
//     pixels capture already treats as a real change (`capture.frameDiffThreshold`, with the ci
//     diff's per-channel tolerance), so anti-aliasing noise isn't a release;
//   - "new": the guide had no published screenshots at the base ref — every step is new;
//   - "impact": screenshots can't be compared (the help app isn't in git, the base ref isn't in
//     its history, or the guide has no published screenshots) — the impact map says whether the
//     app diff touched the guide, and every step is picked.
// Deterministic: the same files and refs always give the same answer.
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { gitBaselineSource, resolveBaselineLookup, type BaselineSource } from "../ci/baseline.js";
import { writeChangedStep } from "../ci/diff.js";
import { diffPngBuffers } from "../capture/index.js";
import { DEFAULT_CAPTURE_SETTINGS } from "../config/types.js";
import { loadWalkthroughText } from "../walkthrough/loader.js";
import { stepList } from "./release-text.js";

export type ChangeRule = "screenshots" | "new" | "impact";

export interface GuideChange {
  id: string;
  rule: ChangeRule;
  /** Page step numbers (1-based) picked, in order. */
  steps: number[];
  /** Why, in plain words, e.g. "steps 3 and 4 look different since v2.3". */
  reason: string;
  /** Rule "new": "guide" when the walkthrough didn't exist at the base ref; "published" when it
   * did, or that can't be read, but it had no published screenshots then. */
  newKind?: "guide" | "published";
  /** The guide's id and title at the base ref, when it had another id then (renamed). */
  renamedFrom?: { id: string; title: string };
  /** Set when steps were matched to the base ref's screenshots by position: why. */
  byPosition?: string;
}

export interface UndecidedGuide {
  id: string;
  reason: string;
}

/** The impact map's answer for the base ref: the walkthrough ids the app diff touches (every
 * one, when it can't tell), or undefined when it couldn't run at all. */
export type AffectedLookup = () => Promise<{ ids: string[]; note?: string } | undefined>;

/** A walkthrough as it was at the base ref. */
export interface BaseWalkthrough {
  id: string;
  title: string;
  /** Step ids in page order (undefined for a step with none). */
  stepIds: (string | undefined)[];
}

/** The walkthrough at the base ref for a guide: `null` when it didn't exist then, `undefined`
 * when that can't be read (no git, the ref isn't in the walkthroughs' history, a parse error). */
export type BaseWalkthroughLookup = (guide: { id: string; file?: string }) => BaseWalkthrough | null | undefined;

export interface DetectChangesOptions {
  /** Publishable guides only: their step ids in page order, and their walkthrough file. */
  guides: { id: string; stepIds: (string | undefined)[]; file?: string }[];
  /** The help app's `public/` folder. */
  publicDir: string;
  base: string;
  /** `capture.frameDiffTolerance`, as `aida ci` uses it. */
  tolerance: number;
  /** Least share of pixels (0-1) that makes a step changed: `capture.frameDiffThreshold`. */
  threshold?: number;
  /** Where the before/after/diff images of changed steps go. */
  diffDir: string;
  /** Impact-map fallback; without it, a guide whose screenshots can't be compared is undecided. */
  affected?: AffectedLookup;
  /** Baseline override (tests); default: git at `base` in the repo holding `publicDir`. */
  source?: BaselineSource;
  /** Base walkthrough override (tests); default: git at `base` in the repo holding each file. */
  baseWalkthroughs?: BaseWalkthroughLookup;
}

export interface DetectChangesResult {
  changes: GuideChange[];
  /** Guides the evidence couldn't settle either way. */
  undecided: UndecidedGuide[];
  /** False when the base ref's screenshots couldn't be read at all. */
  screenshotsCompared: boolean;
}

const STEP_SHOT = /^step-(\d+)\.png$/;
const shotName = (n: number): string => `step-${String(n).padStart(2, "0")}.png`;

function publishedShots(publicDir: string, id: string): string[] {
  const dir = join(publicDir, "screenshots", id);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((n) => STEP_SHOT.test(n))
    .sort();
}

/** A ref a git command can't mistake for an option. */
export function refLooksSafe(ref: string): boolean {
  return ref.length > 0 && !ref.startsWith("-") && !/[\0\n\r]/.test(ref);
}

/** The commit `ref` names in `repoRoot`, or undefined (quietly: an unknown ref is a normal
 * answer). `--end-of-options` keeps a ref from ever being read as an option. */
export function resolveCommit(repoRoot: string, ref: string): string | undefined {
  if (!refLooksSafe(ref)) return undefined;
  try {
    return execFileSync("git", ["rev-parse", "--verify", "--quiet", "--end-of-options", `${ref}^{commit}`], {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim() || undefined;
  } catch {
    return undefined;
  }
}

function git(repoRoot: string, args: string[]): string | undefined {
  try {
    return execFileSync("git", args, { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 16 * 1024 * 1024 });
  } catch {
    return undefined;
  }
}

/**
 * Reads walkthroughs at `base` from git, in whichever repo holds each file: the file at the same
 * path, else the file git sees it renamed from. Repos and their commits are looked up once.
 */
export function gitBaseWalkthroughs(base: string): BaseWalkthroughLookup {
  const repos = new Map<string, { root: string; sha?: string } | undefined>();
  const repoOf = (dir: string) => {
    if (!repos.has(dir)) {
      const root = git(dir, ["rev-parse", "--show-toplevel"])?.trim();
      repos.set(dir, root ? { root, sha: resolveCommit(root, base) } : undefined);
    }
    return repos.get(dir);
  };
  const parse = (root: string, sha: string, rel: string): BaseWalkthrough | undefined => {
    const text = git(root, ["show", `${sha}:${rel}`]);
    if (text === undefined) return undefined;
    try {
      const wf = loadWalkthroughText(text, rel);
      return { id: wf.walkthrough, title: wf.title, stepIds: wf.steps.map((s) => s.id) };
    } catch {
      return undefined;
    }
  };
  return ({ file }) => {
    if (!file || !existsSync(file)) return undefined;
    const real = realpathSync(file);
    const repo = repoOf(dirname(real));
    if (!repo?.sha) return undefined;
    const rel = relative(repo.root, real).split(sep).join("/");
    if (git(repo.root, ["cat-file", "-e", `${repo.sha}:${rel}`]) !== undefined) return parse(repo.root, repo.sha, rel) ?? undefined;
    // Not at this path then: renamed (git's own rename detection, base against the working tree)?
    const relDir = relative(repo.root, dirname(real)).split(sep).join("/") || ".";
    const status = git(repo.root, ["diff", "--name-status", "-M", repo.sha, "--", relDir]);
    if (status === undefined) return undefined;
    for (const line of status.split("\n")) {
      const [kind, from, to] = line.split("\t");
      if (kind?.startsWith("R") && to === rel && from) return parse(repo.root, repo.sha, from) ?? undefined;
    }
    // "Didn't exist" only when git kept walkthroughs in that folder then; otherwise it can't say.
    const listed = git(repo.root, ["ls-tree", "--name-only", repo.sha, "--", relDir === "." ? "." : `${relDir}/`]);
    return listed?.trim() ? null : undefined;
  };
}

const allSteps = (n: number): number[] => Array.from({ length: n }, (_, i) => i + 1);

export async function detectReleaseChanges(opts: DetectChangesOptions): Promise<DetectChangesResult> {
  const threshold = opts.threshold ?? DEFAULT_CAPTURE_SETTINGS.frameDiffThreshold;
  let source = opts.source;
  let compared = Boolean(source);
  if (!source && refLooksSafe(opts.base)) {
    const lookup = resolveBaselineLookup(opts.publicDir);
    // A ref the help app's repo doesn't know reads as "no baseline" for every guide, which
    // would call them all new: only compare when the ref resolves there, and then by commit.
    const sha = resolveCommit(lookup.repoRoot, opts.base);
    if (sha) {
      source = gitBaselineSource(lookup, sha);
      compared = true;
    }
  }
  const baseOf = opts.baseWalkthroughs ?? gitBaseWalkthroughs(opts.base);
  const baselineIds = source ? new Set(source.listWalkthroughIds()) : new Set<string>();

  const changes: GuideChange[] = [];
  const undecided: UndecidedGuide[] = [];
  const fallback: { id: string; stepCount: number; why: string }[] = [];

  for (const guide of opts.guides) {
    const stepCount = guide.stepIds.length;
    const shots = publishedShots(opts.publicDir, guide.id);
    if (!source || shots.length === 0) {
      fallback.push({ id: guide.id, stepCount, why: !source ? `screenshots at ${opts.base} can't be read` : "no published screenshots" });
      continue;
    }
    const baseWf = baseOf(guide);
    const baseId = baseWf?.id ?? guide.id;
    const renamedFrom = baseWf && baseWf.id !== guide.id ? { id: baseWf.id, title: baseWf.title } : undefined;
    if (!baselineIds.has(baseId)) {
      // Nothing published under its id (or its old one) then. "New guide" only when the
      // walkthrough itself didn't exist; otherwise it's just new on the help site.
      const newKind = baseWf === null ? "guide" : "published";
      changes.push({
        id: guide.id,
        rule: "new",
        steps: allSteps(stepCount),
        newKind,
        ...(renamedFrom ? { renamedFrom } : {}),
        reason: newKind === "guide" ? `new since ${opts.base}` : `not on the help site at ${opts.base}`,
      });
      continue;
    }

    const byPosition = baseWf ? undefined : `its walkthrough at ${opts.base} can't be read`;
    const steps: number[] = [];
    let positional = false;
    for (const name of shots) {
      const n = Number(STEP_SHOT.exec(name)?.[1]);
      if (!Number.isInteger(n) || n < 1 || n > stepCount) continue;
      const stepId = guide.stepIds[n - 1];
      let baseN: number | undefined = n;
      if (baseWf && stepId) {
        const i = baseWf.stepIds.indexOf(stepId);
        baseN = i >= 0 ? i + 1 : undefined;
      } else positional = true;
      const after = readFileSync(join(opts.publicDir, "screenshots", guide.id, name));
      const before = baseN !== undefined ? source.getScreenshot(baseId, shotName(baseN)) : undefined;
      if (!before) {
        // A step the base ref didn't have: new, so changed.
        writeChangedStep(opts.diffDir, guide.id, name, undefined, after, 1, opts.tolerance);
        steps.push(n);
        continue;
      }
      const diff = diffPngBuffers(before, after, opts.tolerance);
      if (!diff.dimensionsMatch || (diff.changedFraction > 0 && diff.changedFraction >= threshold)) {
        writeChangedStep(opts.diffDir, guide.id, name, before, after, diff.changedFraction, opts.tolerance);
        steps.push(n);
      }
    }
    steps.sort((a, b) => a - b);
    if (steps.length === 0) continue;
    const why = byPosition ?? (positional ? "some steps have no id" : undefined);
    changes.push({
      id: guide.id,
      rule: "screenshots",
      steps,
      reason: [
        `${stepList(steps)} look${steps.length === 1 ? "s" : ""} different since ${opts.base}`,
        renamedFrom ? `; renamed from ${renamedFrom.id}` : "",
        why ? ` (matched by position: ${why})` : "",
      ].join(""),
      ...(renamedFrom ? { renamedFrom } : {}),
      ...(why ? { byPosition: why } : {}),
    });
  }

  if (fallback.length > 0) {
    const affected = opts.affected ? await opts.affected().catch(() => undefined) : undefined;
    for (const guide of fallback) {
      if (!affected) {
        undecided.push({ id: guide.id, reason: `${guide.why}, and the impact map couldn't run` });
        continue;
      }
      if (!affected.ids.includes(guide.id)) continue;
      const note = affected.note ? `: ${affected.note}` : "";
      changes.push({ id: guide.id, rule: "impact", steps: allSteps(guide.stepCount), reason: `${guide.why}; the impact map says the app changed under it${note}` });
    }
  }

  return { changes, undecided, screenshotsCompared: compared };
}
