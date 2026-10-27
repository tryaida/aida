// The screens a call site can show on, for `aida paths` (M35). A page renders more than its own
// imports: every `layout`/`template` up the App Router tree wraps it, a parallel route's `@slot`
// page renders inside its parent's layout, and an intercepting route (`(.)x`, `(..)x`, `(...)x`)
// opens over the page the reader came from. Each screen lists the files that render on it, so a
// save button in a layout or a modal is found on the routes it really appears on.
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import type { DigestRoute } from "../digest/types.js";
import { isInsideRoot } from "./source-graph.js";

const APP_ROUTER_PREFIXES = ["src/app", "app"];
const PAGES_ROUTER_PREFIXES = ["src/pages", "pages"];
const WRAPPER_FILES = ["layout", "template"];
const WRAPPER_EXTS = ["tsx", "jsx", "js", "ts"];

export interface Screen {
  /** URL route the reader sees this page on, e.g. `/payments` or `/bookings/[id]`. */
  route: string;
  /** The page file, relative to the app root. */
  file: string;
  /** Relative files wrapping the page on this route, nearest first: layouts and templates up the
   * tree (App Router) or `_app` (Pages Router). */
  wrappers: string[];
  /** Set for a parallel route's slot page: the `@slot` name. */
  slot?: string;
  /** Set for an intercepting route: the URL it intercepts (opened over `route`). */
  intercepts?: string;
}

function isGroup(seg: string): boolean {
  return seg.startsWith("(") && seg.endsWith(")") && !/^\(\.{1,3}\)/.test(seg);
}

/** `(.)photo` -> { up: 0, rest: "photo" }; `(..)(..)x` -> up 2; `(...)x` -> to the root. */
function interceptOf(seg: string): { up: number | "root"; rest: string } | undefined {
  if (seg.startsWith("(...)")) return { up: "root", rest: seg.slice(5) };
  const m = /^((?:\(\.\.\))+)(.*)$/.exec(seg);
  if (m) return { up: m[1].length / 4, rest: m[2] };
  if (seg.startsWith("(.)")) return { up: 0, rest: seg.slice(3) };
  return undefined;
}

function urlOf(segments: string[]): string {
  return `/${segments.join("/")}`;
}

/**
 * The route a page under the App Router appears on, from its folders: route groups and `@slot`
 * folders aren't URL segments; an intercepting folder opens over the route of the folders above
 * it (where the reader navigated from), and `intercepts` is the URL it stands in for.
 */
export function appRouteOf(dirSegments: string[]): { route: string; slot?: string; intercepts?: string } {
  const url: string[] = [];
  let slot: string | undefined;
  let shownOn: string[] | undefined;
  let target: string[] | undefined;
  for (const seg of dirSegments) {
    if (isGroup(seg)) continue;
    if (seg.startsWith("@")) {
      slot ??= seg.slice(1);
      continue;
    }
    const icpt = shownOn === undefined ? interceptOf(seg) : undefined;
    if (icpt) {
      shownOn = [...url];
      const base = icpt.up === "root" ? [] : url.slice(0, Math.max(0, url.length - icpt.up));
      target = [...base, ...(icpt.rest ? [icpt.rest] : [])];
      continue;
    }
    if (target) target.push(seg);
    else url.push(seg);
  }
  if (shownOn !== undefined && target) return { route: urlOf(shownOn), ...(slot ? { slot } : {}), intercepts: urlOf(target) };
  return { route: urlOf(url), ...(slot ? { slot } : {}) };
}

function prefixOf(file: string, prefixes: string[]): string | undefined {
  return prefixes.find((p) => file === p || file.startsWith(`${p}/`));
}

function firstExisting(root: string, dir: string, names: string[]): string[] {
  const out: string[] = [];
  for (const name of names) {
    for (const ext of WRAPPER_EXTS) {
      const rel = dir ? `${dir}/${name}.${ext}` : `${name}.${ext}`;
      // Inside the app only: a layout symlinked out of it is never read.
      if (existsSync(join(root, rel)) && isInsideRoot(root, join(root, rel))) {
        out.push(rel);
        break;
      }
    }
  }
  return out;
}

/** Every page the digest found, as the screen it shows on (module comment). */
export function screensOf(root: string, routes: DigestRoute[]): Screen[] {
  const screens: Screen[] = [];
  for (const r of routes) {
    const file = r.file.split("\\").join("/");
    const app = prefixOf(file, APP_ROUTER_PREFIXES);
    if (app) {
      const dir = dirname(file);
      const segments = dir === app ? [] : dir.slice(app.length + 1).split("/");
      const wrappers: string[] = [];
      for (let i = segments.length; i >= 0; i--) {
        wrappers.push(...firstExisting(root, [app, ...segments.slice(0, i)].join("/"), WRAPPER_FILES));
      }
      screens.push({ file, wrappers, ...appRouteOf(segments) });
      continue;
    }
    const pages = prefixOf(file, PAGES_ROUTER_PREFIXES);
    const wrappers = pages ? firstExisting(root, pages, ["_app"]) : [];
    screens.push({ route: r.path, file, wrappers });
  }
  return screens;
}
