// Entry files per route, for the import-graph closure in compute.ts (build-plan.md M17 follow-up).
// A page route's entry is its page file plus every layout.tsx along the App Router nesting chain
// down to it (a layout change can affect everything it wraps); an API route's entry is just its
// handler file.
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import type { DigestRoute } from "../digest/types.js";
import type { ApiRoute } from "./routes.js";

const APP_ROUTER_PREFIXES = ["src/app", "app"];
const LAYOUT_EXTS = ["tsx", "jsx", "js"];

/** Which of the two App Router roots `routeFile` (relative, forward-slash path) sits under, if any. */
function appRouterPrefixFor(routeFile: string): string | undefined {
  const normalized = routeFile.replace(/\\/g, "/");
  return APP_ROUTER_PREFIXES.find((p) => normalized === p || normalized.startsWith(`${p}/`));
}

/** Every `layout.{tsx,jsx,js}` from `routeFile`'s directory up to (and including) the router root. */
function layoutChain(scanRoot: string, prefix: string, routeFile: string): string[] {
  const layouts: string[] = [];
  const rootDir = join(scanRoot, prefix);
  let dir = dirname(join(scanRoot, routeFile));

  for (;;) {
    for (const ext of LAYOUT_EXTS) {
      const candidate = join(dir, `layout.${ext}`);
      if (existsSync(candidate)) {
        layouts.push(candidate);
        break;
      }
    }
    if (dir === rootDir) break;
    const parent = dirname(dir);
    if (parent === dir) break; // reached filesystem root without hitting rootDir — give up
    dir = parent;
  }
  return layouts;
}

/** Absolute entry files for a page route: its page file, plus its layout chain (App Router only —
 * the Pages Router's shared `_app`/`_document` are covered by the always-all glob list instead). */
export function entryFilesForPageRoute(scanRoot: string, route: DigestRoute): string[] {
  const entries = [join(scanRoot, route.file)];
  const prefix = appRouterPrefixFor(route.file);
  if (prefix) entries.push(...layoutChain(scanRoot, prefix, route.file));
  return entries;
}

/** Absolute entry files for an API route: just its handler file. */
export function entryFilesForApiRoute(scanRoot: string, route: ApiRoute): string[] {
  return [join(scanRoot, route.file)];
}
