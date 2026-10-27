// Keeps the app's own `next build` working after `aida init` puts the help app inside it
// (build-plan.md M25). A Next.js tsconfig includes every `**/*.ts(x)` under the app, so without
// this the app's typecheck would walk into help/ and fail on its `@/` imports, which point at the
// help app's own root, not the app's. Adds the help folder to the app tsconfig's `exclude`.
//
// tsconfig files are JSONC (comments, trailing commas). They're read with a small scanner that
// blanks comments out at the same length, so every offset still points into the user's file and
// the edit is a pure text insertion: formatting and comments stay exactly as they were. The
// engine doesn't ship TypeScript at runtime (it's a dev dependency), so this doesn't use
// `ts.parseConfigFileTextToJson`.
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export interface ExcludeHelpResult {
  file: string;
  /** "added": written; "present": already excluded; "manual": couldn't edit safely (the file
   * doesn't parse, or `exclude` isn't an array), so the user should add it; "none": no
   * tsconfig, or help isn't inside the app. */
  status: "added" | "present" | "manual" | "none";
  /** The entry for `exclude`, relative to the app, e.g. "help". */
  entry: string;
  /** Something the user should check, e.g. an `extends` base aida couldn't read. */
  note?: string;
}

/** TypeScript's own `exclude` when a config (and everything it extends) sets none. */
export const TS_DEFAULT_EXCLUDE = ["node_modules", "bower_components", "jspm_packages"];

/** `text` with every comment replaced by spaces (newlines kept), so offsets are unchanged. */
export function blankJsonComments(text: string): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"' && text[j] !== "\n") j += text[j] === "\\" ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j + 1;
    } else if (c === "/" && text[i + 1] === "/") {
      let j = i;
      while (j < text.length && text[j] !== "\n") j++;
      out += " ".repeat(j - i);
      i = j;
    } else if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      const j = end === -1 ? text.length : end + 2;
      out += text.slice(i, j).replace(/[^\n]/g, " ");
      i = j;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

/** Parses JSONC (comments and trailing commas), or undefined when it isn't valid. */
export function parseJsonc(text: string): unknown {
  const blanked = blankJsonComments(text);
  // Drop trailing commas, outside strings only.
  let json = "";
  for (let i = 0; i < blanked.length; i++) {
    const c = blanked[i];
    if (c === '"') {
      let j = i + 1;
      while (j < blanked.length && blanked[j] !== '"') j += blanked[j] === "\\" ? 2 : 1;
      json += blanked.slice(i, j + 1);
      i = j;
    } else if (c === "," && /^\s*[}\]]/.test(blanked.slice(i + 1))) {
      json += " ";
    } else {
      json += c;
    }
  }
  try {
    return JSON.parse(json);
  } catch {
    return undefined;
  }
}

/** End offset (exclusive) of the string starting at `i` in comment-blanked text. */
function stringEnd(s: string, i: number): number {
  let j = i + 1;
  while (j < s.length && s[j] !== '"') j += s[j] === "\\" ? 2 : 1;
  return j + 1;
}

/** Offset of the bracket closing the one at `open`, skipping strings. */
function matchClose(s: string, open: number): number {
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    const c = s[i];
    if (c === '"') {
      i = stringEnd(s, i) - 1;
    } else if (c === "{" || c === "[") {
      depth++;
    } else if (c === "}" || c === "]") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

interface TopLevel {
  open: number;
  close: number;
  /** Top-level key -> offset of its value's first character (in the blanked text). */
  keys: Map<string, number>;
}

function topLevel(blanked: string): TopLevel | undefined {
  const open = blanked.search(/\S/);
  if (open === -1 || blanked[open] !== "{") return undefined;
  const close = matchClose(blanked, open);
  if (close === -1) return undefined;
  const keys = new Map<string, number>();
  let i = open + 1;
  while (i < close) {
    const c = blanked[i];
    if (c === '"') {
      const end = stringEnd(blanked, i);
      const colon = blanked.slice(end).match(/^\s*:\s*/);
      if (colon) {
        keys.set(JSON.parse(blanked.slice(i, end)) as string, end + colon[0].length);
        const v = end + colon[0].length;
        // Skip the value.
        if (blanked[v] === "{" || blanked[v] === "[") i = matchClose(blanked, v) + 1;
        else if (blanked[v] === '"') i = stringEnd(blanked, v);
        else i = v + 1;
        continue;
      }
      i = end;
    } else {
      i++;
    }
  }
  return { open, close, keys };
}

/** Where `extends` points: a path relative to the config, or a package in node_modules. */
function resolveExtends(spec: string, fromDir: string): string | undefined {
  const asFile = (p: string): string | undefined => {
    for (const candidate of [p, `${p}.json`]) {
      if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
    }
    return undefined;
  };
  if (spec.startsWith(".") || isAbsolute(spec)) return asFile(resolve(fromDir, spec));
  for (let dir = fromDir; ; dir = dirname(dir)) {
    const target = join(dir, "node_modules", spec);
    const file = asFile(target);
    if (file) return file;
    const pkgJson = join(target, "package.json");
    if (existsSync(pkgJson)) {
      try {
        const field = (JSON.parse(readFileSync(pkgJson, "utf8")) as { tsconfig?: string }).tsconfig;
        const viaField = field ? asFile(join(target, field)) : undefined;
        if (viaField) return viaField;
      } catch {
        // fall through to tsconfig.json
      }
    }
    const inDir = asFile(join(target, "tsconfig.json"));
    if (inDir) return inDir;
    if (dir === dirname(dir)) return undefined;
  }
}

function toPosix(p: string): string {
  return p.split(sep).join("/");
}

/** A base config's exclude pattern, made relative to `appDir` (TypeScript resolves an inherited
 * `exclude` against the config that declares it). */
function rebase(pattern: string, baseDir: string, appDir: string): string {
  if (isAbsolute(pattern)) return pattern;
  return toPosix(relative(appDir, resolve(baseDir, pattern))) || ".";
}

type Inherited = { exclude: string[] } | { unresolved: string } | undefined;

/** The `exclude` the app's config inherits through `extends` (undefined: none anywhere in the
 * chain, so TypeScript's defaults apply), or which base couldn't be read. */
function inheritedExclude(config: Record<string, unknown>, configDir: string, appDir: string, seen: Set<string>): Inherited {
  const ext = config.extends;
  const specs = typeof ext === "string" ? [ext] : Array.isArray(ext) ? ext.filter((e): e is string => typeof e === "string") : [];
  // With several bases, later ones override earlier ones.
  for (const spec of [...specs].reverse()) {
    const file = resolveExtends(spec, configDir);
    if (!file || seen.has(file)) return { unresolved: spec };
    seen.add(file);
    const base = parseJsonc(readFileSync(file, "utf8"));
    if (!base || typeof base !== "object" || Array.isArray(base)) return { unresolved: spec };
    const b = base as Record<string, unknown>;
    if (Array.isArray(b.exclude)) {
      return { exclude: b.exclude.filter((e): e is string => typeof e === "string").map((e) => rebase(e, dirname(file), appDir)) };
    }
    const deeper = inheritedExclude(b, dirname(file), appDir, seen);
    if (deeper) return deeper;
  }
  return undefined;
}

function sameEntry(a: string, entry: string): boolean {
  return a.replace(/^\.\//, "").replace(/\/+$/, "") === entry;
}

/** Adds the help folder to `<appDir>/tsconfig.json`'s `exclude` by inserting text, so the rest
 * of the file (formatting, comments) stays exactly as it was. Without an `exclude`, one is added
 * holding what the app already excluded: the `extends` base's effective `exclude` (rebased to the
 * app) or TypeScript's defaults, then the help folder. */
export function excludeHelpFromAppTsconfig(appDir: string, helpDir: string): ExcludeHelpResult {
  const file = join(appDir, "tsconfig.json");
  const rel = relative(appDir, helpDir);
  const entry = toPosix(rel);
  if (!existsSync(file) || rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
    return { file, status: "none", entry };
  }
  const raw = readFileSync(file, "utf8");
  const quoted = JSON.stringify(entry);
  const parsed = parseJsonc(raw);
  const blanked = blankJsonComments(raw);
  const top = topLevel(blanked);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || !top) return { file, status: "manual", entry };
  const config = parsed as Record<string, unknown>;

  const valueAt = top.keys.get("exclude");
  if (valueAt !== undefined) {
    if (!Array.isArray(config.exclude) || blanked[valueAt] !== "[") return { file, status: "manual", entry };
    if (config.exclude.some((e) => typeof e === "string" && sameEntry(e, entry))) return { file, status: "present", entry };
    const close = matchClose(blanked, valueAt);
    const inner = blanked.slice(valueAt + 1, close);
    const lastSig = inner.trimEnd().length; // offset in `inner` just past the last item (or its comma)
    const multiLine = inner.includes("\n");
    let next: string;
    if (inner.trim() === "") {
      next = raw.slice(0, valueAt + 1) + quoted + raw.slice(valueAt + 1);
    } else {
      const comma = inner[lastSig - 1] === "," ? "" : ",";
      const lineStart = inner.lastIndexOf("\n", lastSig - 1) + 1;
      const indent = inner.slice(lineStart).match(/^[ \t]*/)![0];
      const afterLast = valueAt + 1 + lastSig;
      // Multi-line: the new item goes on its own line, after any comment trailing the last one.
      const lineEnd = multiLine ? blanked.indexOf("\n", afterLast) : -1;
      const insertAt = lineEnd !== -1 && lineEnd < close ? lineEnd : afterLast;
      const item = multiLine ? `\n${indent}${quoted}` : ` ${quoted}`;
      next = raw.slice(0, afterLast) + comma + raw.slice(afterLast, insertAt) + item + raw.slice(insertAt);
    }
    writeFileSync(file, next, "utf8");
    return { file, status: "added", entry };
  }

  // No `exclude` here: adding one replaces whatever the app had, so carry that over.
  let note: string | undefined;
  let carried: string[];
  const inherited = inheritedExclude(config, appDir, appDir, new Set([resolve(file)]));
  if (inherited && "exclude" in inherited) {
    carried = inherited.exclude;
  } else {
    carried = [...TS_DEFAULT_EXCLUDE];
    const outDir = (config.compilerOptions as { outDir?: unknown } | undefined)?.outDir;
    if (typeof outDir === "string") carried.push(toPosix(relative(appDir, resolve(appDir, outDir))) || ".");
    if (inherited && "unresolved" in inherited) {
      note =
        `tsconfig.json extends ${JSON.stringify(inherited.unresolved)}, which aida couldn't read, so the new "exclude" ` +
        `holds TypeScript's defaults and "${entry}". If that base sets its own "exclude", copy its entries in too ` +
        `(relative to the app), since an "exclude" here replaces the inherited one.`;
    }
  }
  if (carried.some((e) => sameEntry(e, entry))) return { file, status: "present", entry };
  const list = [...carried.filter((e, i) => carried.indexOf(e) === i), entry].map((e) => JSON.stringify(e)).join(", ");

  // Insert after the last top-level member: its comma right after it, the new member at the end
  // of that line (so a trailing comment stays with the member it describes).
  const body = blanked.slice(top.open + 1, top.close);
  const lastSig = body.trimEnd().length;
  const indent = raw.match(/^[ \t]+(?=")/m)?.[0] ?? "  ";
  const member = `"exclude": [${list}]`;
  let next: string;
  if (body.trim() === "") {
    next = `${raw.slice(0, top.open + 1)}\n${indent}${member}\n${raw.slice(top.close)}`;
  } else {
    const afterLast = top.open + 1 + lastSig;
    const hasComma = blanked[afterLast - 1] === ",";
    const lineEnd = blanked.indexOf("\n", afterLast);
    const insertAt = lineEnd !== -1 && lineEnd < top.close ? lineEnd : afterLast;
    const comma = hasComma ? "" : ",";
    const closeOnSameLine = insertAt === afterLast;
    next =
      raw.slice(0, afterLast) +
      comma +
      raw.slice(afterLast, insertAt) +
      `\n${indent}${member}` +
      (closeOnSameLine ? "\n" : "") +
      raw.slice(insertAt);
  }
  writeFileSync(file, next, "utf8");
  return { file, status: "added", entry, ...(note ? { note } : {}) };
}
