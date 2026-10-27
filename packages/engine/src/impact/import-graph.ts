// Static import graph for `aida affected` (build-plan.md M17 follow-up: route/API matching by
// exact file equality was far too coarse on real history — almost every pilot-app commit touches a
// shared component/action/service, not a route file itself. This resolves each route's (and its
// layout chain's) transitive imports, so a changed file maps to exactly the routes that actually
// reach it, instead of "unknown -> all" for nearly everything.
//
// Deliberately a regex scanner, not the TypeScript compiler API: this only needs import
// *specifiers* (not type information), and a full `ts.createProgram` over a real-app-sized repo
// would cost orders of magnitude more than the few hundred ms this takes (see timing note in
// compute.ts). Caches per-file imports and per-entry closures, so a run with many changed
// files/routes still only reads/parses each source file once.
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";

export interface TsconfigPaths {
  baseUrl: string;
  paths: Record<string, string[]>;
}

const FROM_PATTERN = /\bfrom\s+["']([^"']+)["']/g;
const BARE_IMPORT_PATTERN = /\bimport\s+["']([^"']+)["']/g; // side-effect import, no `from`
const REQUIRE_PATTERN = /\brequire\(\s*["']([^"']+)["']\s*\)/g;
const DYNAMIC_IMPORT_PATTERN = /\bimport\(\s*["']([^"']+)["']\s*\)/g;

function parseImportSpecifiers(source: string): string[] {
  const specs = new Set<string>();
  for (const re of [FROM_PATTERN, BARE_IMPORT_PATTERN, REQUIRE_PATTERN, DYNAMIC_IMPORT_PATTERN]) {
    for (const m of source.matchAll(re)) specs.add(m[1]!);
  }
  return [...specs];
}

/** Reads `tsconfig.json`'s `baseUrl`/`paths` (for `@/*`-style aliases). Any failure (missing
 * file, malformed JSON, comments tsconfig allows but JSON.parse doesn't) falls back to a baseUrl
 * of `scanRoot` and no alias patterns — aliased imports then just won't resolve, same as an
 * unparseable import specifier. */
function loadTsconfigPaths(scanRoot: string): TsconfigPaths {
  let baseUrl = scanRoot;
  let paths: Record<string, string[]> = {};
  const file = join(scanRoot, "tsconfig.json");
  if (existsSync(file)) {
    try {
      const json = JSON.parse(readFileSync(file, "utf8")) as {
        compilerOptions?: { baseUrl?: string; paths?: Record<string, string[]> };
      };
      const co = json.compilerOptions;
      if (co?.baseUrl) baseUrl = join(scanRoot, co.baseUrl);
      if (co?.paths) paths = co.paths;
    } catch {
      // fall through to defaults
    }
  }
  return { baseUrl, paths };
}

const RESOLVE_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"];

function resolveFile(base: string): string | undefined {
  if (existsSync(base) && statSync(base).isFile()) return base;
  for (const ext of RESOLVE_EXTENSIONS) {
    if (existsSync(base + ext)) return base + ext;
  }
  for (const ext of RESOLVE_EXTENSIONS) {
    const idx = join(base, `index${ext}`);
    if (existsSync(idx)) return idx;
  }
  return undefined;
}

/** Resolves a bare (non-relative) specifier against tsconfig `paths` (e.g. `@/*` -> `./*`).
 * Undefined for anything not matching a configured alias — including ordinary package imports
 * (`next/server`, `react`), which this graph never follows past the repo boundary. */
function resolveAliased(spec: string, tsconfig: TsconfigPaths): string | undefined {
  for (const [pattern, targets] of Object.entries(tsconfig.paths)) {
    if (pattern.endsWith("/*")) {
      const prefix = pattern.slice(0, -1);
      if (!spec.startsWith(prefix)) continue;
      const rest = spec.slice(prefix.length);
      for (const target of targets) {
        const targetBase = target.endsWith("/*") ? target.slice(0, -1) : target;
        const resolved = resolveFile(join(tsconfig.baseUrl, targetBase, rest));
        if (resolved) return resolved;
      }
    } else if (pattern === spec) {
      for (const target of targets) {
        const resolved = resolveFile(join(tsconfig.baseUrl, target));
        if (resolved) return resolved;
      }
    }
  }
  return undefined;
}

/**
 * Lazily-built, memoized static import graph rooted at `scanRoot`. `closure(entry)` returns every
 * file transitively reachable from `entry` via relative imports and tsconfig path aliases —
 * external package imports are left unresolved (and so don't expand the closure past the repo).
 */
export class ImportGraph {
  private readonly tsconfig: TsconfigPaths;
  private readonly importsCache = new Map<string, string[]>();
  private readonly closureCache = new Map<string, Set<string>>();

  constructor(private readonly scanRoot: string) {
    this.tsconfig = loadTsconfigPaths(scanRoot);
  }

  private getImports(file: string): string[] {
    const cached = this.importsCache.get(file);
    if (cached) return cached;

    let source: string;
    try {
      source = readFileSync(file, "utf8");
    } catch {
      this.importsCache.set(file, []);
      return [];
    }

    const resolved: string[] = [];
    for (const spec of parseImportSpecifiers(source)) {
      let target: string | undefined;
      if (spec.startsWith(".")) {
        target = resolveFile(resolve(dirname(file), spec));
      } else if (!isAbsolute(spec)) {
        target = resolveAliased(spec, this.tsconfig);
      }
      if (target) resolved.push(target);
    }
    this.importsCache.set(file, resolved);
    return resolved;
  }

  /** `entry` plus every file reachable from it (inclusive), memoized. */
  closure(entry: string): Set<string> {
    const cached = this.closureCache.get(entry);
    if (cached) return cached;

    const seen = new Set<string>();
    const stack = [entry];
    while (stack.length > 0) {
      const f = stack.pop()!;
      if (seen.has(f)) continue;
      seen.add(f);
      for (const dep of this.getImports(f)) stack.push(dep);
    }
    this.closureCache.set(entry, seen);
    return seen;
  }
}
