// `aida export playwright`: every (or each named) walkthrough as `<id>.spec.ts` in one folder.
// Nothing is written when any spec would overwrite a file aida didn't generate (unless forced),
// so a refused run never leaves the folder half updated. A spec is only ever written as a regular
// file inside `--out`: never through a symlink, forced or not.
import { closeSync, constants, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, writeSync, type Stats } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { loadConfig, type ResolvedConfig } from "../config/index.js";
import { loadWalkthroughFile, type Walkthrough } from "../walkthrough/index.js";
import { devicesFor } from "../devices/index.js";
import { briefPath, loadBrief } from "../brief/consumers.js";
import { isGeneratedSpec, walkthroughToSpec, type SpecContext } from "./playwright.js";

export { GENERATED_HEADER, isGeneratedSpec, walkthroughToSpec, type SpecContext } from "./playwright.js";
export { locatorCode } from "./locator.js";
export { LABEL_HELPER, SELECT_HELPER, TEXT_HELPER, helperCode } from "./helpers.js";
export { CodeContext } from "./code.js";

export interface ExportPlaywrightOptions {
  configPath: string;
  /** Walkthrough ids or files; empty: every walkthrough in `walkthroughsDir`. */
  walkthroughs: string[];
  outDir: string;
  /** Overwrite a spec that doesn't carry the generated header. */
  force?: boolean;
}

export interface ExportedSpec {
  walkthrough: string;
  file: string;
  /** "unchanged": the file already held exactly this spec. */
  status: "written" | "unchanged";
}

export interface ExportPlaywrightResult {
  ok: boolean;
  outDir: string;
  specs: ExportedSpec[];
  /** Walkthroughs that couldn't be exported, or files that weren't overwritten; nothing is
   * written when there are any. */
  errors: { walkthrough: string; error: string }[];
}

function walkthroughFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => /\.(ya?ml)$/i.test(f))
    .map((f) => join(dir, f))
    .sort();
}

/** The output path's own entry (a symlink isn't followed), or undefined when there's none. */
function entryAt(path: string): Stats | undefined {
  try {
    return lstatSync(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
}

/** The nearest existing folder of `dir`, symlinks resolved, with the rest appended. */
function realFolder(dir: string): string {
  let existing = dir;
  const rest: string[] = [];
  while (!existsSync(existing)) {
    const parent = resolve(existing, "..");
    if (parent === existing) break;
    rest.unshift(relative(parent, existing));
    existing = parent;
  }
  return join(realpathSync(existing), ...rest);
}

/** Creates or replaces a regular file without following a symlink put there since the check. */
function writeRegularFile(path: string, text: string): void {
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | (constants.O_NOFOLLOW ?? 0), 0o644);
  try {
    writeSync(fd, text);
  } finally {
    closeSync(fd);
  }
}

function firstLine(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).split("\n")[0];
}

function specContext(wt: Walkthrough, file: string, config: ResolvedConfig, all: Walkthrough[], brief: ReturnType<typeof loadBrief>): SpecContext {
  const providers: Record<string, string[]> = {};
  for (const other of all) {
    if (other.walkthrough === wt.walkthrough) continue;
    for (const state of other.leaves ?? []) (providers[state] ??= []).push(other.walkthrough);
  }
  for (const list of Object.values(providers)) list.sort();
  return {
    source: relative(config.configDir, file).split(sep).join("/"),
    signIn: Boolean(config.signIn),
    stateSetups: new Set(Object.entries(config.states ?? {}).filter(([, s]) => Boolean(s?.setup)).map(([name]) => name)),
    providers,
    device: devicesFor(wt, config, brief)[0] ?? "desktop",
    databaseReset: Boolean(config.database),
  };
}

export async function exportPlaywright(opts: ExportPlaywrightOptions): Promise<ExportPlaywrightResult> {
  const config = await loadConfig(opts.configPath);
  const outDir = resolve(opts.outDir);
  const files = walkthroughFiles(config.walkthroughsDir);
  const errors: ExportPlaywrightResult["errors"] = [];

  // Every walkthrough that loads, to say which one leaves the data another needs.
  const loaded = new Map<string, Walkthrough>();
  for (const file of files) {
    try {
      loaded.set(file, loadWalkthroughFile(file));
    } catch (err) {
      if (opts.walkthroughs.length === 0) errors.push({ walkthrough: file, error: firstLine(err) });
    }
  }

  let chosen: string[];
  if (opts.walkthroughs.length === 0) {
    chosen = [...loaded.keys()];
  } else {
    chosen = [];
    for (const want of opts.walkthroughs) {
      const asFile = resolve(want);
      const byFile = files.find((f) => f === asFile);
      const withId = [...loaded.entries()].filter(([, wt]) => wt.walkthrough === want).map(([f]) => f);
      if (!byFile && withId.length > 1) {
        errors.push({ walkthrough: want, error: `walkthrough id "${want}" is in more than one file: ${withId.map((f) => relative(config.configDir, f)).join(" and ")}` });
        continue;
      }
      const byId = withId[0];
      const file = byFile ?? byId ?? (existsSync(asFile) && /\.(ya?ml)$/i.test(asFile) ? asFile : undefined);
      if (!file) {
        errors.push({ walkthrough: want, error: `no walkthrough "${want}" in ${config.walkthroughsDir}` });
        continue;
      }
      if (!loaded.has(file)) {
        try {
          loaded.set(file, loadWalkthroughFile(file));
        } catch (err) {
          errors.push({ walkthrough: want, error: firstLine(err) });
          continue;
        }
      }
      if (!chosen.includes(file)) chosen.push(file);
    }
  }

  // Two files with one id would both write `<id>.spec.ts`, and the last would win unseen.
  const byId = new Map<string, string[]>();
  for (const file of chosen) {
    const id = loaded.get(file)!.walkthrough;
    byId.set(id, [...(byId.get(id) ?? []), file]);
  }
  for (const [id, list] of byId) {
    if (list.length > 1) errors.push({ walkthrough: id, error: `walkthrough id "${id}" is in more than one file: ${list.map((f) => relative(config.configDir, f)).join(" and ")}: give each its own id` });
  }
  chosen = chosen.filter((file) => byId.get(loaded.get(file)!.walkthrough)!.length === 1);

  const all = [...loaded.values()];
  const brief = loadBrief(briefPath(config));
  const realOut = realFolder(outDir);
  const planned: { walkthrough: string; file: string; real: string; text: string; status: ExportedSpec["status"] }[] = [];
  for (const file of chosen) {
    const wt = loaded.get(file)!;
    let text: string;
    try {
      text = walkthroughToSpec(wt, specContext(wt, file, config, all, brief));
    } catch (err) {
      errors.push({ walkthrough: wt.walkthrough, error: firstLine(err) });
      continue;
    }
    const out = join(outDir, `${wt.walkthrough}.spec.ts`);
    const real = join(realOut, `${wt.walkthrough}.spec.ts`);
    const inside = relative(realOut, real);
    if (inside.startsWith("..") || isAbsolute(inside) || inside.includes(sep)) {
      errors.push({ walkthrough: wt.walkthrough, error: `${out} is outside ${outDir}` });
      continue;
    }
    let status: ExportedSpec["status"] = "written";
    const entry = entryAt(real);
    if (entry && !entry.isFile()) {
      const what = entry.isSymbolicLink() ? "a symlink" : "not a regular file";
      errors.push({ walkthrough: wt.walkthrough, error: `${out} is ${what}: aida export playwright only writes regular files, so move it (--force doesn't change this)` });
      continue;
    }
    if (entry) {
      const existing = readFileSync(real, "utf8");
      if (existing === text) status = "unchanged";
      else if (!isGeneratedSpec(existing) && !opts.force) {
        errors.push({ walkthrough: wt.walkthrough, error: `${out} exists and wasn't generated by aida export playwright: move it, or pass --force to overwrite it` });
        continue;
      }
    }
    planned.push({ walkthrough: wt.walkthrough, file: out, real, text, status });
  }

  if (errors.length > 0) return { ok: false, outDir, specs: [], errors };
  mkdirSync(outDir, { recursive: true });
  for (const p of planned) if (p.status === "written") writeRegularFile(p.real, p.text);
  return { ok: true, outDir, specs: planned.map(({ walkthrough, file, status }) => ({ walkthrough, file, status })), errors };
}
