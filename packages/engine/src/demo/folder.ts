// The demo folder: where `aida demo` writes the sample app, its help app and every output. It
// only ever writes into a folder that doesn't exist yet, an empty one, or one an earlier
// `aida demo` made (it leaves a marker file, `.aida-demo.json`), and it never deletes anything.
//
// The marker also records a hash of every file the demo copied in. On a later run a file is
// refreshed from the engine's copy only while it still has the hash the demo wrote: a file the
// person has edited is kept as they left it.
//
// A marker is only a claim: anyone can write one. So the demo runs code (the sample app, the
// config it loads) only when every such file still has the hash the demo recorded for it, and a
// marker that doesn't record the sample app it says is there is refused outright.
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { aidaInvocation, shellWord } from "./invocation.js";

export const MARKER_FILE = ".aida-demo.json";

export interface DemoMarker {
  aidaDemo: 1;
  /** What this file is, for a person who opens it. */
  note: string;
  /** Files the demo wrote: path relative to the demo folder (forward slashes) -> sha256. */
  files: Record<string, string>;
}

export type DemoFolderState = { kind: "new" | "empty" } | { kind: "demo"; marker: DemoMarker };

export class DemoFolderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DemoFolderError";
  }
}

/** The file the sample app starts from: a marker that records no hash for it describes no sample
 * app aida demo copied. */
const APP_ENTRY = "server.mjs";
/** Files the demo writes under here belong to the help app; the rest of the folder is the sample app. */
const HELP_PREFIX = "help/";

const MARKER_NOTE = "Written by `aida demo`. It marks this folder as a demo folder that `aida demo` may write into again. Delete the whole folder when you're done with it.";

function readMarker(file: string): DemoMarker | undefined {
  try {
    const st = lstatSync(file);
    if (!st.isFile()) return undefined;
    const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<DemoMarker>;
    if (parsed?.aidaDemo !== 1) return undefined;
    const files = parsed.files && typeof parsed.files === "object" ? parsed.files : {};
    return { aidaDemo: 1, note: MARKER_NOTE, files: Object.fromEntries(Object.entries(files).filter(([, v]) => typeof v === "string")) };
  } catch {
    return undefined;
  }
}

/** Whether `aida demo` may write into `dir`, without changing anything. Throws `DemoFolderError`
 * with the reason when it may not. */
export function checkDemoFolder(dir: string): DemoFolderState {
  let st;
  try {
    st = lstatSync(dir);
  } catch {
    return { kind: "new" };
  }
  const pick = `Pick another folder: ${aidaInvocation()} demo <dir>`;
  if (st.isSymbolicLink()) throw new DemoFolderError(`${dir} is a symbolic link; aida demo won't write through it. ${pick}`);
  if (!st.isDirectory()) throw new DemoFolderError(`${dir} exists and isn't a folder. ${pick}`);
  const marker = readMarker(join(dir, MARKER_FILE));
  if (marker) {
    const problem = markerProblem(dir, marker);
    if (problem) throw new DemoFolderError(`${problem} ${pick}`);
    return { kind: "demo", marker };
  }
  if (readdirSync(dir).length === 0) return { kind: "empty" };
  throw new DemoFolderError(
    `${dir} already exists and isn't a demo folder (it has no ${MARKER_FILE}). aida demo only writes into a new or empty folder, or one an earlier aida demo made. ${pick}`,
  );
}

/** Why `marker` doesn't describe `dir` as a demo folder, else undefined. A first run stopped
 * between claiming the folder and copying into it leaves the marker alone in it: that's fine. */
function markerProblem(dir: string, marker: DemoMarker): string | undefined {
  const others = readdirSync(dir).filter((f) => f !== MARKER_FILE && f !== `${MARKER_FILE}.partial`);
  if (Object.keys(marker.files).length === 0 && others.length === 0) return undefined;
  if (!marker.files[APP_ENTRY]) {
    return `${dir} has a ${MARKER_FILE} that doesn't record the sample app aida demo copies there, so aida demo won't write into it or run anything in it.`;
  }
  const appFiles = Object.keys(marker.files).filter((rel) => !rel.startsWith(HELP_PREFIX));
  if (!appFiles.some((rel) => existsSync(join(dir, ...rel.split("/"))))) {
    return `None of the sample-app files ${dir}/${MARKER_FILE} records (${APP_ENTRY} and others) is there, so it isn't the demo folder aida demo made.`;
  }
  return undefined;
}

/**
 * Throws `DemoFolderError` naming the first of `rels` that isn't byte for byte the copy the demo
 * wrote (its hash in `marker`), or that the demo never wrote. Called before the demo runs any of
 * them: it only ever starts the sample app and loads the config it put there itself.
 */
export function verifyDemoCode(dir: string, marker: DemoMarker, rels: string[]): void {
  for (const rel of rels) {
    const file = join(dir, ...rel.split("/"));
    const recorded = marker.files[rel];
    let current: string | undefined;
    try {
      current = lstatSync(file).isFile() ? sha256(readFileSync(file)) : undefined;
    } catch {
      current = undefined;
    }
    if (recorded && current === recorded) continue;
    const what = !current ? "is missing or isn't a plain file" : recorded ? "has changed since aida demo wrote it" : "wasn't written by aida demo";
    throw new DemoFolderError(
      `${rel} in ${dir} ${what}, so aida demo won't run the sample app or load its config: it only runs the files it copied in itself. ` +
        `Delete ${rel} and run ${aidaInvocation()} demo again for a fresh copy, or pick another folder. ` +
        `To run your own changes, start the app yourself and use ${aidaInvocation()} build --config ${shellWord(join(dir, "help", "aida.config.ts"))}.`,
    );
  }
}

/** Creates the folder when needed and writes the marker, so even an interrupted first run leaves
 * a folder the next run recognises. */
export function claimDemoFolder(dir: string): DemoMarker {
  const state = checkDemoFolder(dir);
  if (state.kind === "demo") return state.marker;
  mkdirSync(dir, { recursive: true });
  const marker: DemoMarker = { aidaDemo: 1, note: MARKER_NOTE, files: {} };
  writeMarker(dir, marker);
  return marker;
}

export function writeMarker(dir: string, marker: DemoMarker): void {
  const file = join(dir, MARKER_FILE);
  const partial = `${file}.partial`;
  writeFileSync(partial, `${JSON.stringify({ ...marker, note: MARKER_NOTE }, null, 2)}\n`, "utf8");
  renameSync(partial, file);
}

export function sha256(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** One file the demo puts in its folder: copied from `src`, or written from `content`. */
export interface DemoFileEntry {
  /** Path inside the demo folder, forward slashes. */
  rel: string;
  src?: string;
  content?: string;
}

export interface SyncReport {
  /** New files written. */
  written: string[];
  /** Files the demo wrote before and nobody changed since, refreshed to the engine's copy. */
  updated: string[];
  /** Files left as they are: changed since the demo wrote them, or never written by it. */
  kept: string[];
  /** Already the same as the engine's copy. */
  unchanged: string[];
}

/** Why `rel` can't be written safely inside `dir` (escapes it, or passes through a symbolic
 * link), else undefined. */
function unsafePath(dir: string, rel: string): string | undefined {
  const dest = resolve(dir, rel);
  const inside = relative(dir, dest);
  if (inside === "" || inside.startsWith("..") || inside.split(sep).includes("..")) return `${rel} is outside the demo folder`;
  let current = dir;
  for (const part of inside.split(sep)) {
    current = join(current, part);
    try {
      if (lstatSync(current).isSymbolicLink()) return `${relative(dir, current)} is a symbolic link`;
    } catch {
      return undefined; // the rest doesn't exist yet
    }
  }
  return undefined;
}

/**
 * Brings the demo's own files up to date in `dir` and records them in `marker` (written back by
 * the caller): writes missing files, refreshes files that still have the hash the demo wrote, and
 * keeps every file someone changed.
 */
export function syncDemoFiles(dir: string, marker: DemoMarker, entries: DemoFileEntry[]): SyncReport {
  const report: SyncReport = { written: [], updated: [], kept: [], unchanged: [] };
  for (const entry of entries) {
    const bytes = entry.src !== undefined ? readFileSync(entry.src) : Buffer.from(entry.content ?? "", "utf8");
    const wanted = sha256(bytes);
    if (unsafePath(dir, entry.rel)) {
      report.kept.push(entry.rel);
      continue;
    }
    const dest = join(dir, ...entry.rel.split("/"));
    if (!existsSync(dest)) {
      mkdirSync(dirname(dest), { recursive: true });
      writeFileSync(dest, bytes);
      marker.files[entry.rel] = wanted;
      report.written.push(entry.rel);
      continue;
    }
    if (!lstatSync(dest).isFile()) {
      report.kept.push(entry.rel);
      continue;
    }
    const current = sha256(readFileSync(dest));
    if (current === wanted) {
      marker.files[entry.rel] = wanted;
      report.unchanged.push(entry.rel);
    } else if (marker.files[entry.rel] === current) {
      writeFileSync(dest, bytes);
      marker.files[entry.rel] = wanted;
      report.updated.push(entry.rel);
    } else {
      report.kept.push(entry.rel);
    }
  }
  return report;
}

/** Every file under `root`, relative to it with forward slashes, sorted. */
export function listFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (rel: string): void => {
    for (const entry of readdirSync(join(root, rel), { withFileTypes: true })) {
      const child = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(child);
      else if (entry.isFile()) out.push(child);
    }
  };
  walk("");
  return out.sort();
}
