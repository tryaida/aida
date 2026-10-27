// Minimal glob matcher for `aida affected`'s ignore/all pattern lists (build-plan.md M17).
// Deliberately small: aida has no glob dependency, and the patterns here never need brace
// expansion or character classes — `*`, `**` and `?` cover every built-in and user-supplied
// pattern in practice.

const REGEX_SPECIAL = /[.+^${}()|[\]\\]/g;

/** Converts one glob pattern into an anchored regex matching a forward-slash-normalized path. */
function globToRegex(glob: string): RegExp {
  let out = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        i++;
        if (glob[i + 1] === "/") {
          out += "(?:.*/)?";
          i++;
        } else {
          out += ".*";
        }
      } else {
        out += "[^/]*";
      }
    } else if (c === "?") {
      out += "[^/]";
    } else {
      out += c.replace(REGEX_SPECIAL, "\\$&");
    }
  }
  return new RegExp(`^${out}$`);
}

const compiledCache = new Map<string, RegExp>();

function compile(glob: string): RegExp {
  let re = compiledCache.get(glob);
  if (!re) {
    re = globToRegex(glob);
    compiledCache.set(glob, re);
  }
  return re;
}

/** Normalizes a path to forward slashes with no leading "./". */
export function normalizePath(path: string): string {
  const slashed = path.replace(/\\/g, "/");
  return slashed.startsWith("./") ? slashed.slice(2) : slashed;
}

/** Returns the first pattern in `patterns` that matches `path`, or undefined. */
export function matchesAnyGlob(path: string, patterns: string[]): string | undefined {
  const normalized = normalizePath(path);
  for (const pattern of patterns) {
    if (compile(pattern).test(normalized)) return pattern;
  }
  return undefined;
}

/**
 * Changed files that are clearly irrelevant to every walkthrough: docs, tests, lint/editor
 * config, CI workflow files. Extended (never replaced) by `config.impact.ignore`.
 */
export const DEFAULT_IGNORE_GLOBS: string[] = [
  "**/*.md",
  "**/*.mdx",
  "**/README*",
  "**/CHANGELOG*",
  "**/LICENSE*",
  "**/*.test.*",
  "**/*.spec.*",
  "**/__tests__/**",
  "**/*.stories.*",
  "**/.github/**",
  "**/.vscode/**",
  "**/.editorconfig",
  "**/.prettierrc*",
  "**/.eslintrc*",
  "**/eslint.config.*",
];

/**
 * Changed files that are genuinely global — nothing route-specific to narrow them to, so every
 * walkthrough is affected outright (docs/scope.md "Only rebuild what changed": "If the map can't
 * tell, everything runs."). Deliberately narrow: compute.ts's import graph now resolves which
 * routes actually import a shared component/action/service/lib file, so (unlike an earlier
 * version of this list) `lib/`, `utils/`, `shared/` and `auth/` are no longer blanket-"all" —
 * a pilot app's real history showed almost every commit touches one of those directories, which made
 * `aida affected` say "all" for nearly everything. What's left here is what the import graph
 * can't (or shouldn't) reason about: build/tooling config, the root layout (wraps every route),
 * the auth gate, and database schema/migrations (no route "imports" a migration file, but a
 * schema change can change what every page renders). Extended (never replaced) by
 * `config.impact.all`.
 */
export const DEFAULT_ALL_GLOBS: string[] = [
  "package.json",
  "**/package.json",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "**/*.lock",
  "next.config.*",
  "tsconfig*.json",
  "tailwind.config.*",
  "postcss.config.*",
  // Next.js's auth/request gate — `middleware.ts` by convention, `proxy.ts` is the newer name
  // (a pilot app's own proxy.ts: "not middleware.ts, and that matters beyond the deprecation
  // warning"). Root-level only: these run for every request regardless of route.
  "middleware.ts",
  "middleware.js",
  "proxy.ts",
  "proxy.js",
  // The *root* layout only ("**/" so this matches both "app/layout.tsx" and "src/app/layout.tsx"
  // — a nested "app/dashboard/layout.tsx" has "dashboard", not "app", as its parent segment, so
  // it never matches this pattern and is instead handled by the import graph's layout chain).
  "**/app/layout.tsx",
  "**/app/layout.jsx",
  "**/app/layout.js",
  "**/pages/_app.*",
  "**/pages/_document.*",
  "**/globals.css",
  "**/migrations/**",
  "**/schema.prisma",
  "drizzle.config.*",
];
