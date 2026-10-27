// The file side of walkthrough paths (decision 34), kept free of the browser runner so pages,
// procedures, outline drift and `aida affected` can read path captures without loading Playwright:
// where a path's capture lives, reading it back, and the write keys capture compares.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Walkthrough } from "../walkthrough/index.js";
import type { CaptureManifest, ImpactRequest, PathDiff, ValidationResult } from "./types.js";

/** `<captureDir>/paths/<pathId>`: one path's manifest, frames and validation. */
export function pathCaptureDir(captureDir: string, pathId: string): string {
  return join(captureDir, "paths", pathId);
}

const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** True for a path segment that names one record rather than a kind of thing: a number, a UUID,
 * a long hex string, or a long id with a digit in it (cuid, nanoid, a slug with a number). */
function isIdSegment(segment: string): boolean {
  if (/^\d+$/.test(segment)) return true;
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(segment)) return true;
  if (/^[0-9a-f]{12,}$/i.test(segment)) return true;
  return /^[A-Za-z0-9_-]{16,}$/.test(segment) && /\d/.test(segment);
}

/** A request path as a route pattern: record ids as `:id`, fragment dropped, and the query
 * reduced to its parameter names, sorted (`?mode=split&id=7` -> `?id&mode`): a different
 * parameter can mean a different save, a different value usually doesn't. */
export function routePattern(path: string): string {
  const [beforeHash] = path.split("#");
  const [pathname, query] = [beforeHash!.split("?")[0]!, beforeHash!.split("?").slice(1).join("?")];
  const pattern = pathname
    .split("/")
    .map((s) => {
      let decoded = s;
      try {
        decoded = decodeURIComponent(s);
      } catch {
        // keep as written
      }
      return s && isIdSegment(decoded) ? ":id" : s;
    })
    .join("/");
  const names = query ? [...new Set([...new URLSearchParams(query).keys()])].sort() : [];
  return names.length > 0 ? `${pattern}?${names.join("&")}` : pattern;
}

/** What a request saved, as a comparable key — `POST /api/payments/:id`, `POST action <id>` for
 * a server action, `POST /graphql mutation CreatePayment` — or undefined for a read: GET, HEAD and
 * OPTIONS never save, nor does a request capture saw save nothing (`read`: a server action that
 * revalidated nothing, a GraphQL query; decision 37). */
export function writeKey(request: ImpactRequest): string | undefined {
  const method = request.method.toUpperCase();
  if (READ_METHODS.has(method)) return undefined;
  if (request.read) return undefined;
  if (request.action) return `${method} action ${request.action}`;
  const key = `${method} ${routePattern(request.path)}`;
  return request.operation ? `${key} ${request.operation}` : key;
}

/** Every write a capture made, as keys, sorted, one entry per request (a save made twice is
 * listed twice). Steps from `fromStep` (0-based) on. */
export function writeKeys(manifest: Pick<CaptureManifest, "steps">, fromStep = 0): string[] {
  const keys: string[] = [];
  for (const step of manifest.steps.slice(fromStep)) {
    for (const r of step.impact?.requests ?? []) {
      const key = writeKey(r);
      if (key) keys.push(key);
    }
  }
  return keys.sort();
}

/** Every server action id a capture called, saves and reads alike, sorted and unique. A server
 * action that revalidated nothing is taken for a read, but it may still save (returning data, the
 * client refreshing itself), so which actions ran is compared too (decision 37). */
export function actionIds(manifest: Pick<CaptureManifest, "steps">, fromStep = 0): string[] {
  const ids = new Set<string>();
  for (const step of manifest.steps.slice(fromStep)) {
    for (const r of step.impact?.requests ?? []) if (r.action && !READ_METHODS.has(r.method.toUpperCase())) ids.add(r.action);
  }
  return [...ids].sort();
}

function counts(keys: string[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const k of keys) out.set(k, (out.get(k) ?? 0) + 1);
  return out;
}

/** `POST /api/x`, or `POST /api/x ×2` for a save made more than once. */
function counted(key: string, n: number): string {
  return n > 1 ? `${key} ×${n}` : key;
}

/** "once", "twice", "3 times". */
function times(n: number): string {
  return n === 1 ? "once" : n === 2 ? "twice" : `${n} times`;
}

/** "A once", "A once and B twice", "A once, B twice and C once"; "nothing" for none. */
function describeSaves(entries: [string, number][]): string {
  if (entries.length === 0) return "nothing";
  const parts = entries.map(([key, n]) => `${key} ${times(n)}`);
  return parts.length === 1 ? parts[0]! : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

/** What the end checks (decision 37) found after one run: the final step's checks and the
 * walkthrough's `validate.database` checks, by name. */
export interface EndChecks {
  ok: boolean;
  /** Names of the checks that failed (empty when `ok`). */
  failed: string[];
}

/** The end checks of one run, from its validation: the last step's checks (a path that joins
 * shares the main's final step; a path that runs alone has its own) and every database check. */
export function endChecks(validation: Pick<ValidationResult, "steps" | "dbChecks">, totalSteps?: number): EndChecks {
  const failed: string[] = [];
  const last = validation.steps[validation.steps.length - 1];
  const ranAll = totalSteps === undefined || validation.steps.length === totalSteps;
  if (!last || !ranAll) failed.push("final step didn't run");
  else if (!last.ok || last.checks.some((c) => !c.ok)) failed.push(`final step ${last.id ?? validation.steps.length}`);
  for (const c of validation.dbChecks ?? []) if (!c.ok) failed.push(c.name);
  return { ok: failed.length === 0, failed };
}

/**
 * How a path's run differs from the main run's, or undefined when it doesn't: its saves (write
 * keys compared per key with counts, order ignored: a path saving the same thing twice differs);
 * with `actions`, the server actions each run called, saves and reads alike (an action id only one
 * run called is flagged: a read by its headers may still save); and with `checks`, its end checks
 * (decision 37: a path whose end checks fail where the main run's pass, or the other way round,
 * leaves different data).
 */
export function comparePathWrites(
  pathId: string,
  main: string[],
  path: string[],
  checks?: { main: EndChecks; path: EndChecks },
  actions?: { main: string[]; path: string[] },
): PathDiff | undefined {
  const mainCounts = counts(main);
  const pathCounts = counts(path);
  const onlyInPath: string[] = [];
  const onlyInMain: string[] = [];
  const pathSide: [string, number][] = [];
  const mainSide: [string, number][] = [];
  for (const key of [...new Set([...mainCounts.keys(), ...pathCounts.keys()])].sort()) {
    const m = mainCounts.get(key) ?? 0;
    const p = pathCounts.get(key) ?? 0;
    if (m === p) continue;
    if (p > 0) {
      onlyInPath.push(counted(key, p));
      pathSide.push([key, p]);
    }
    if (m > 0) {
      onlyInMain.push(counted(key, m));
      mainSide.push([key, m]);
    }
  }
  const savesDiffer = onlyInPath.length > 0 || onlyInMain.length > 0;
  // Action ids already told apart as saves above aren't repeated here.
  const savedIds = new Set([...main, ...path].map((k) => /^\S+ action (\S+)$/.exec(k)?.[1]).filter(Boolean));
  const mainIds = new Set(actions?.main ?? []);
  const pathIds = new Set(actions?.path ?? []);
  const actionsOnlyInPath = [...pathIds].filter((id) => !mainIds.has(id) && !savedIds.has(id)).sort();
  const actionsOnlyInMain = [...mainIds].filter((id) => !pathIds.has(id) && !savedIds.has(id)).sort();
  const actionsDiffer = actionsOnlyInPath.length > 0 || actionsOnlyInMain.length > 0;
  const dataDiffers = checks !== undefined && checks.main.ok !== checks.path.ok;
  if (!savesDiffer && !actionsDiffer && !dataDiffers) return undefined;
  const sentences: string[] = [];
  if (savesDiffer) sentences.push(`path ${pathId} saves ${describeSaves(pathSide)}; main path saves ${describeSaves(mainSide)}`);
  if (actionsDiffer) {
    const list = (ids: string[]) => ids.map((id) => `server action ${id}`).join(", ");
    const parts = [
      ...(actionsOnlyInPath.length > 0 ? [`path ${pathId} calls ${list(actionsOnlyInPath)}, which the main path doesn't`] : []),
      ...(actionsOnlyInMain.length > 0 ? [`the main path calls ${list(actionsOnlyInMain)}, which path ${pathId} doesn't`] : []),
    ];
    sentences.push(`${parts.join("; ")} (it revalidated nothing, so it looked like a read, but it may still save)`);
  }
  if (dataDiffers) {
    const failing = checks!.path.ok ? checks!.main.failed : checks!.path.failed;
    const which = checks!.path.ok
      ? `end checks pass where the main path's fail (${failing.join(", ")})`
      : `end checks fail where the main path's pass (${failing.join(", ")})`;
    sentences.push(`path ${pathId} leaves different data: ${which}`);
  }
  return {
    path: pathId,
    main,
    pathWrites: path,
    onlyInPath,
    onlyInMain,
    ...(actionsDiffer ? { actionsOnlyInPath, actionsOnlyInMain } : {}),
    reasons: [...(savesDiffer ? (["saves"] as const) : []), ...(actionsDiffer ? (["actions"] as const) : []), ...(dataDiffers ? (["data"] as const) : [])],
    ...(checks ? { endChecks: { main: checks.main, path: checks.path } } : {}),
    message: sentences.join(". "),
  };
}

/** Distinct frame images a manifest references. */
export function countFrames(manifest: Pick<CaptureManifest, "steps">): number {
  const names = new Set<string>();
  for (const step of manifest.steps) {
    for (const e of step.events) {
      if (e.type === "frame") names.add(e.image);
      if (e.type === "scrollFrames" || e.type === "typeFrames") {
        for (const img of e.images) names.add(img);
      }
    }
  }
  return names.size;
}

function readJson<T>(file: string): T | undefined {
  if (!existsSync(file)) return undefined;
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch {
    return undefined;
  }
}

/** One path's latest capture on disk. */
export interface PathCapture {
  pathId: string;
  dir: string;
  manifest?: CaptureManifest;
  validation?: ValidationResult;
}

/** Every path's latest capture under `captureDir` (missing files left undefined). */
export function readPathCaptures(captureDir: string, walkthrough: Pick<Walkthrough, "paths">): PathCapture[] {
  return (walkthrough.paths ?? []).map((p) => {
    const dir = pathCaptureDir(captureDir, p.id);
    return {
      pathId: p.id,
      dir,
      manifest: readJson<CaptureManifest>(join(dir, "manifest.json")),
      validation: readJson<ValidationResult>(join(dir, "validation.json")),
    };
  });
}

