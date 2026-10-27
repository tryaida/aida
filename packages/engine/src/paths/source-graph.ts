// The import graph `aida paths` reads to tell which pages render a call site (M35). Like
// impact/import-graph.ts it is a regex scanner over import specifiers (no TypeScript at runtime),
// with what finding call sites needs on top:
//   - path aliases from `tsconfig.json` or `jsconfig.json` `compilerOptions.paths`/`baseUrl`, read
//     as JSONC and following relative `extends` (each `baseUrl`/`paths` relative to the config
//     that sets it);
//   - `./x.js` specifiers that name a `./x.ts` source (TypeScript ESM style);
//   - barrel files (`index.ts` re-exporting components): an import names what it takes, and only
//     the re-exports that provide those names are followed. A page importing `Button` from
//     `@/components` doesn't reach `PaymentForm` just because the same barrel re-exports it.
// A module that isn't a pure barrel (it has code of its own) counts as reached whole.
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { parseJsonc } from "../init/app-tsconfig.js";

export interface AliasConfig {
  /** Absolute dir `paths` targets resolve against. */
  baseUrl: string;
  paths: Record<string, string[]>;
}

const ALL = "*";
type Names = typeof ALL | Set<string>;

interface ImportEdge {
  spec: string;
  /** Names taken (`default` for a default import), or ALL (namespace, side effect, require). */
  names: Names;
}

interface ReexportEdge {
  spec: string;
  /** Exported name -> name in the target module; ALL for `export * from`. */
  map: typeof ALL | Map<string, string>;
}

interface ModuleInfo {
  imports: ImportEdge[];
  reexports: ReexportEdge[];
  /** Names this module declares itself (`export function X`, `export { a as b }`, `default`). */
  own: Set<string>;
  /** Only re-exports and imports: the module itself renders nothing. */
  barrel: boolean;
}

const EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"];

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

/** True when `file` — symlinks resolved — is `root` or under it (`root` resolved too). Every
 * file the graph reads (an import, an alias target, an `extends`, a layout) must pass: a symlink or
 * `../` out of the app never pulls in, or reads, anything outside it. */
export function isInsideRoot(root: string, file: string): boolean {
  try {
    const realRoot = realpathSync(root);
    const real = realpathSync(file);
    return real === realRoot || real.startsWith(realRoot.endsWith(sep) ? realRoot : realRoot + sep);
  } catch {
    return false;
  }
}

/** `base` as a source file: as written, with an extension added, a `.js` written for a `.ts`
 * source, or a directory's `index.*`. */
export function resolveSourceFile(base: string): string | undefined {
  if (isFile(base)) return base;
  for (const ext of EXTENSIONS) if (isFile(base + ext)) return base + ext;
  const js = /\.(m|c)?jsx?$/.exec(base);
  if (js) {
    const stem = base.slice(0, -js[0].length);
    const tsExts = js[1] === "m" ? [".mts", ".ts"] : js[1] === "c" ? [".cts", ".ts"] : [".ts", ".tsx"];
    for (const ext of tsExts) if (isFile(stem + ext)) return stem + ext;
  }
  for (const ext of EXTENSIONS) {
    const idx = join(base, `index${ext}`);
    if (isFile(idx)) return idx;
  }
  return undefined;
}

function readConfig(file: string, root: string, depth = 0): { baseUrl?: string; paths?: Record<string, string[]>; pathsDir?: string } {
  if (depth > 8 || !isFile(file) || !isInsideRoot(root, file)) return {};
  let json: { extends?: unknown; compilerOptions?: { baseUrl?: unknown; paths?: unknown } } | undefined;
  try {
    json = parseJsonc(readFileSync(file, "utf8")) as typeof json;
  } catch {
    return {};
  }
  if (!json || typeof json !== "object") return {};
  const dir = dirname(file);
  let out: { baseUrl?: string; paths?: Record<string, string[]>; pathsDir?: string } = {};
  // Only relative bases inside the app: a package base (`@acme/tsconfig`) rarely carries app
  // aliases, and an absolute one or one outside the app root is never read.
  const bases = (Array.isArray(json.extends) ? json.extends : [json.extends]).filter(
    (e): e is string => typeof e === "string" && e.startsWith("."),
  );
  for (const ext of bases) {
    let target = resolve(dir, ext);
    if (!isFile(target) && isFile(`${target}.json`)) target = `${target}.json`;
    out = { ...out, ...readConfig(target, root, depth + 1) };
  }
  const co = json.compilerOptions;
  if (typeof co?.baseUrl === "string") out.baseUrl = resolve(dir, co.baseUrl);
  if (co?.paths && typeof co.paths === "object") {
    out.paths = co.paths as Record<string, string[]>;
    out.pathsDir = dir;
  }
  return out;
}

/** Aliases from the app's `tsconfig.json` (or `jsconfig.json`). Without `baseUrl`, `paths`
 * resolve against the config that declares them, as TypeScript does. */
export function loadAliases(appRoot: string): AliasConfig {
  for (const name of ["tsconfig.json", "jsconfig.json"]) {
    const file = join(appRoot, name);
    if (!isFile(file)) continue;
    const cfg = readConfig(file, appRoot);
    return { baseUrl: cfg.baseUrl ?? cfg.pathsDir ?? appRoot, paths: cfg.paths ?? {} };
  }
  return { baseUrl: appRoot, paths: {} };
}

/** A bare specifier through the aliases (`@/components/x`, `~/lib`), or undefined for a package. */
export function resolveAlias(spec: string, aliases: AliasConfig): string | undefined {
  // Longest prefix first, as TypeScript picks the most specific pattern.
  const patterns = Object.entries(aliases.paths).sort((a, b) => b[0].length - a[0].length);
  for (const [pattern, targets] of patterns) {
    if (!Array.isArray(targets)) continue;
    const star = pattern.indexOf("*");
    let rest: string | undefined;
    if (star === -1) {
      if (spec !== pattern) continue;
      rest = "";
    } else {
      const prefix = pattern.slice(0, star);
      const suffix = pattern.slice(star + 1);
      if (!spec.startsWith(prefix) || !spec.endsWith(suffix) || spec.length < prefix.length + suffix.length) continue;
      rest = spec.slice(prefix.length, spec.length - suffix.length);
    }
    for (const target of targets) {
      if (typeof target !== "string") continue;
      const found = resolveSourceFile(resolve(aliases.baseUrl, target.replace("*", rest)));
      if (found) return found;
    }
  }
  return undefined;
}

/** Comments out, string contents kept: specifiers live in strings. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:"'`\\])\/\/[^\n]*/g, "$1");
}

/** `{ a, b as c, default as D, type T }` -> pairs [imported/local-side, exported/local name]. */
function parseBraces(body: string): [string, string][] {
  return body
    .split(",")
    .map((s) => s.trim().replace(/^type\s+/, ""))
    .filter(Boolean)
    .map((s) => {
      const m = /^([\w$]+)(?:\s+as\s+([\w$]+))?$/.exec(s);
      return m ? ([m[1], m[2] ?? m[1]] as [string, string]) : undefined;
    })
    .filter((p): p is [string, string] => Boolean(p));
}

const IMPORT_FROM = /\bimport\s+(type\s+)?([^'"`;]*?)\s+from\s+["']([^"']+)["']/g;
const IMPORT_BARE = /\bimport\s+["']([^"']+)["']/g;
const DYNAMIC = /\b(?:import|require)\s*\(\s*["']([^"']+)["']\s*\)/g;
const EXPORT_FROM = /\bexport\s+(type\s+)?(\*\s*(?:as\s+([\w$]+))?|\{([^}]*)\})\s*from\s+["']([^"']+)["']/g;
const EXPORT_DECL = /\bexport\s+(?:declare\s+)?(?:async\s+)?(?:function\*?|class|const|let|var|enum|interface|type|abstract\s+class)\s+([\w$]+)/g;
const EXPORT_DEFAULT = /\bexport\s+default\b/;
const EXPORT_LOCAL = /\bexport\s+(?:type\s+)?\{([^}]*)\}(?!\s*from)/g;

export function parseModule(source: string): ModuleInfo {
  const text = stripComments(source);
  const imports: ImportEdge[] = [];
  const reexports: ReexportEdge[] = [];
  const own = new Set<string>();

  for (const m of text.matchAll(IMPORT_FROM)) {
    if (m[1]) continue; // `import type`: nothing renders
    const clause = m[2].trim();
    const names = new Set<string>();
    let all = false;
    const braces = /\{([^}]*)\}/.exec(clause);
    if (braces) for (const [imported] of parseBraces(braces[1])) names.add(imported);
    if (/\*\s*as\s+[\w$]+/.test(clause)) all = true;
    const head = clause.replace(/\{[^}]*\}/, "").replace(/\*\s*as\s+[\w$]+/, "").replace(/,/g, " ").trim();
    if (head) names.add("default");
    imports.push({ spec: m[3], names: all || (names.size === 0 && !braces) ? ALL : names });
  }
  for (const m of text.matchAll(IMPORT_BARE)) imports.push({ spec: m[1], names: ALL });
  for (const m of text.matchAll(DYNAMIC)) imports.push({ spec: m[1], names: ALL });

  for (const m of text.matchAll(EXPORT_FROM)) {
    if (m[1]) continue;
    if (m[4] !== undefined) {
      const map = new Map<string, string>();
      for (const [imported, exported] of parseBraces(m[4])) map.set(exported, imported);
      reexports.push({ spec: m[5], map });
    } else if (m[3]) {
      reexports.push({ spec: m[5], map: new Map([[m[3], ALL]]) });
    } else {
      reexports.push({ spec: m[5], map: ALL });
    }
  }
  for (const m of text.matchAll(EXPORT_DECL)) own.add(m[1]);
  if (EXPORT_DEFAULT.test(text)) own.add("default");
  for (const m of text.matchAll(EXPORT_LOCAL)) for (const [, exported] of parseBraces(m[1])) own.add(exported);

  // A barrel: nothing but import/export-from lines (and blank space) once those are removed.
  const rest = text
    .replace(EXPORT_FROM, "")
    .replace(IMPORT_FROM, "")
    .replace(IMPORT_BARE, "")
    .replace(/["']use (client|server)["'];?/g, "")
    .replace(/[;\s]/g, "");
  return { imports, reexports, own, barrel: reexports.length > 0 && rest === "" };
}

/**
 * Memoised import graph over an app. `closure(entry)` is every file `entry` reaches, following
 * relative and aliased imports, through barrels by name (module comment).
 */
export class SourceGraph {
  readonly aliases: AliasConfig;
  private readonly modules = new Map<string, ModuleInfo>();
  private readonly resolved = new Map<string, string | undefined>();
  private readonly closures = new Map<string, Set<string>>();

  private readonly insideCache = new Map<string, boolean>();

  constructor(readonly root: string) {
    this.aliases = loadAliases(root);
  }

  /** `isInsideRoot`, memoised. */
  inside(file: string): boolean {
    let ok = this.insideCache.get(file);
    if (ok === undefined) {
      ok = isInsideRoot(this.root, file);
      this.insideCache.set(file, ok);
    }
    return ok;
  }

  private info(file: string): ModuleInfo {
    let m = this.modules.get(file);
    if (!m) {
      let source = "";
      try {
        source = readFileSync(file, "utf8");
      } catch {
        // unreadable: no edges
      }
      m = parseModule(source);
      this.modules.set(file, m);
    }
    return m;
  }

  /** A specifier written in `from` as a file in the app, or undefined (a package). */
  resolve(from: string, spec: string): string | undefined {
    const key = `${dirname(from)}\u0000${spec}`;
    if (this.resolved.has(key)) return this.resolved.get(key);
    let target: string | undefined;
    if (spec.startsWith(".")) target = resolveSourceFile(resolve(dirname(from), spec));
    else if (!isAbsolute(spec)) target = resolveAlias(spec, this.aliases);
    if (target && !this.inside(target)) target = undefined;
    this.resolved.set(key, target);
    return target;
  }

  /** `entry` plus every file it reaches. */
  closure(entry: string): Set<string> {
    const cached = this.closures.get(entry);
    if (cached) return cached;
    const reached = new Set<string>();
    // Per file: ALL once it's reached whole, else the names already asked of it.
    const asked = new Map<string, Names>();
    const stack: [string, Names][] = [[entry, ALL]];
    while (stack.length > 0) {
      const [file, names] = stack.pop()!;
      // Never read a file outside the app (an entry that is a symlink out, say).
      if (!this.inside(file)) continue;
      const before = asked.get(file);
      if (before === ALL) continue;
      let fresh: Names;
      if (names === ALL) fresh = ALL;
      else {
        fresh = new Set([...names].filter((n) => !(before instanceof Set && before.has(n))));
        if (fresh.size === 0) continue;
      }
      asked.set(file, fresh === ALL ? ALL : new Set([...(before instanceof Set ? before : []), ...fresh]));
      const info = this.info(file);
      // Code of its own runs when imported at all: the file is reached whole.
      const whole = fresh === ALL || !info.barrel || [...fresh].some((n) => info.own.has(n));
      if (whole) {
        reached.add(file);
        for (const imp of info.imports) {
          const t = this.resolve(file, imp.spec);
          if (t) stack.push([t, imp.names]);
        }
      }
      for (const re of info.reexports) {
        const t = this.resolve(file, re.spec);
        if (!t) continue;
        if (re.map === ALL) {
          if (fresh === ALL) stack.push([t, ALL]);
          else {
            const pass = new Set([...fresh].filter((n) => !info.own.has(n) && n !== "default"));
            if (pass.size > 0) stack.push([t, pass]);
          }
          continue;
        }
        const want = new Set<string>();
        let wantAll = false;
        for (const [exported, imported] of re.map) {
          if (fresh !== ALL && !fresh.has(exported)) continue;
          if (imported === ALL) wantAll = true;
          else want.add(imported);
        }
        if (wantAll) stack.push([t, ALL]);
        else if (want.size > 0) stack.push([t, want]);
      }
    }
    this.closures.set(entry, reached);
    return reached;
  }
}
