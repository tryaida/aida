// The help app installs a lean runtime build of the engine (init/install.ts): the same dist/, but
// only HELP_APP_RUNTIME_DEPENDENCIES installed. This walks the import graph from every import of
// "aida-docs" in the help app template, and from the main entry, through the engine's sources and
// fails, with the import chain, when anything reaches an npm package outside that list. Type-only
// imports are skipped (they're erased); dynamic `import("x")` with a literal counts, because
// Next.js bundles the help app and resolves those at build time.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { builtinModules } from "node:module";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { HELP_APP_RUNTIME_DEPENDENCIES } from "../../src/init/install.js";
import { AIDA_PACKAGE } from "../../src/package-name.js";

const ENGINE = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SRC = join(ENGINE, "src");
const HELP_APP = resolve(ENGINE, "..", "help-app");

/** Module specifiers a file loads at runtime. */
function runtimeImports(file: string): string[] {
  const sf = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.ES2022, true);
  const out: string[] = [];
  const allTypeOnly = (els: ts.NodeArray<ts.ImportSpecifier | ts.ExportSpecifier>) => els.length > 0 && els.every((e) => e.isTypeOnly);
  const visit = (n: ts.Node): void => {
    if (ts.isImportDeclaration(n)) {
      const c = n.importClause;
      const typeOnly = c?.isTypeOnly || (c && !c.name && c.namedBindings && ts.isNamedImports(c.namedBindings) && allTypeOnly(c.namedBindings.elements));
      if (!typeOnly) out.push((n.moduleSpecifier as ts.StringLiteral).text);
    } else if (ts.isExportDeclaration(n) && n.moduleSpecifier) {
      const typeOnly = n.isTypeOnly || (n.exportClause && ts.isNamedExports(n.exportClause) && allTypeOnly(n.exportClause.elements));
      if (!typeOnly) out.push((n.moduleSpecifier as ts.StringLiteral).text);
    } else if (ts.isCallExpression(n) && n.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const arg = n.arguments[0];
      if (arg && ts.isStringLiteralLike(arg)) out.push(arg.text);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

/** An engine source file for a dist-relative path or a relative import (`x.js` is `x.ts`). */
function sourceFile(path: string): string {
  const tsPath = path.replace(/\.js$/, ".ts");
  if (existsSync(tsPath)) return tsPath;
  if (existsSync(path)) return path;
  throw new Error(`no engine source for ${relative(ENGINE, path)}`);
}

function packageName(spec: string): string {
  const parts = spec.split("/");
  return spec.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
}

const BUILTINS = new Set(builtinModules);
function isBuiltin(spec: string): boolean {
  return spec.startsWith("node:") || BUILTINS.has(spec.split("/")[0]);
}

/** Every npm package reached from the entries, with the first import chain that reached it. */
function reachedPackages(entries: Array<{ label: string; file: string }>): Map<string, string[]> {
  const seen = new Set<string>();
  const found = new Map<string, string[]>();
  const walk = (file: string, chain: string[]): void => {
    if (seen.has(file)) return;
    seen.add(file);
    for (const spec of runtimeImports(file)) {
      if (spec.startsWith(".")) {
        const next = sourceFile(resolve(dirname(file), spec));
        walk(next, [...chain, relative(SRC, next)]);
      } else if (!isBuiltin(spec) && !found.has(packageName(spec))) {
        found.set(packageName(spec), [...chain, spec]);
      }
    }
  };
  for (const e of entries) walk(e.file, [e.label, relative(SRC, e.file)]);
  return found;
}

/** The help app template's runtime imports of "aida-docs", as engine source entry points. */
function helpAppEntries(): Array<{ label: string; file: string }> {
  const entries: Array<{ label: string; file: string }> = [];
  const visit = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      if (name === "node_modules" || name.startsWith(".")) continue;
      const path = join(dir, name);
      if (statSync(path).isDirectory()) visit(path);
      else if (/\.(ts|tsx|mjs|js)$/.test(name) && !name.endsWith(".d.ts")) {
        for (const spec of runtimeImports(path)) {
          if (spec !== AIDA_PACKAGE && !spec.startsWith(`${AIDA_PACKAGE}/`)) continue;
          const file = spec === AIDA_PACKAGE ? join(SRC, "index.ts") : sourceFile(join(SRC, spec.slice(`${AIDA_PACKAGE}/`.length).replace(/^dist\//, "")));
          entries.push({ label: `help-app/${relative(HELP_APP, path)} imports ${spec}`, file });
        }
      }
    }
  };
  visit(HELP_APP);
  return entries;
}

function describeChains(found: Map<string, string[]>, allowed: readonly string[]): string[] {
  return [...found].filter(([name]) => !allowed.includes(name)).map(([name, chain]) => `${name}: ${chain.join(" -> ")}`);
}

describe("help app runtime imports", () => {
  it("finds the help app's imports of aida-docs", () => {
    const entries = helpAppEntries();
    expect(entries.length).toBeGreaterThan(5);
    expect(entries.some((e) => e.label.endsWith("aida.config.ts imports aida-docs"))).toBe(true);
  });

  it("only reach the engine dependencies the lean help-app install keeps", () => {
    const found = reachedPackages(helpAppEntries());
    expect(describeChains(found, HELP_APP_RUNTIME_DEPENDENCIES)).toEqual([]);
  });

  it("the main entry loads no npm package (configs import defineConfig from it; every CLI command loads the config)", () => {
    const found = reachedPackages([{ label: AIDA_PACKAGE, file: join(SRC, "index.ts") }]);
    expect(describeChains(found, [])).toEqual([]);
  });

  it("keeps each runtime dependency in the engine's own dependencies", () => {
    const deps = (JSON.parse(readFileSync(join(ENGINE, "package.json"), "utf8")) as { dependencies: Record<string, string> }).dependencies;
    expect(HELP_APP_RUNTIME_DEPENDENCIES.filter((name) => !deps[name])).toEqual([]);
  });

  it("catches a heavy import with its chain", () => {
    const found = reachedPackages([{ label: "cli", file: join(SRC, "cli.ts") }]);
    const bad = describeChains(found, HELP_APP_RUNTIME_DEPENDENCIES);
    expect(bad.some((line) => line.startsWith("playwright: cli -> cli.ts -> "))).toBe(true);
  });
});
