// Screen patterns: one captured app pathname turned into a pattern that matches the same screen
// for any record, so in-app help can tell which guides belong to the page a reader is on.
//
// Pattern syntax (also read by the browser scripts in the help app's public/ folder, which carry
// their own copy of `matchRoutePattern`; keep the two in step):
//   /polls/*/edit    `*`  matches exactly one path segment
//   /docs/**         `**` matches the rest of the path, including nothing; only valid last
// Everything else is literal. Patterns never carry a query string or hash.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Query, hash and trailing slash removed; always starts with "/". Accepts a full URL too. */
export function normalizePathname(input: string): string {
  let path = input;
  const scheme = /^[a-z][a-z0-9+.-]*:\/\//i.exec(path);
  if (scheme) {
    const rest = path.slice(scheme[0].length);
    const slash = rest.indexOf("/");
    path = slash === -1 ? "/" : rest.slice(slash);
  }
  path = path.split("#")[0]!.split("?")[0]!;
  if (!path.startsWith("/")) path = `/${path}`;
  if (path.length > 1) path = path.replace(/\/+$/, "");
  return path || "/";
}

/** A framework route ("/polls/[id]/edit", "/docs/[...slug]", "/users/:id") as a screen pattern. */
export function routeToPattern(route: string): string {
  const out: string[] = [];
  for (const segment of normalizePathname(route).split("/").filter(Boolean)) {
    if (/^\(.*\)$/.test(segment) || segment.startsWith("@")) continue; // route groups, parallel slots
    if (/^\[\[?\.\.\..+\]\]?$/.test(segment) || segment === "**") {
      out.push("**");
      break;
    }
    if (/^\[.+\]$/.test(segment) || /^:.+/.test(segment)) out.push("*");
    else out.push(segment);
  }
  return `/${out.join("/")}`;
}

/** True when a path segment reads as a record id rather than a screen name. */
export function looksLikeId(segment: string): boolean {
  if (/^\d+$/.test(segment)) return true;
  if (UUID.test(segment)) return true;
  if (/^[0-9a-f]{16,}$/i.test(segment)) return true;
  // cuid, nanoid, ULID and friends: long, no separators that words use, letters and digits mixed.
  if (segment.length >= 8 && /^[A-Za-z0-9_-]+$/.test(segment) && /\d/.test(segment) && /[A-Za-z]/.test(segment)) {
    const words = segment.split(/[-_]/);
    // "step-2", "q3-report" and "2024-plan" are names; an id has a long run mixing both kinds.
    return words.some((w) => w.length >= 8 && /\d/.test(w) && /[A-Za-z]/.test(w));
  }
  return false;
}

function specificity(pattern: string): number {
  // More literal segments first; a catch-all last.
  const segments = pattern.split("/").filter(Boolean);
  return segments.filter((s) => s !== "*" && s !== "**").length * 4 - (segments.includes("**") ? 2 : 0);
}

/**
 * The screen pattern for a captured pathname. With `knownRoutes` (the app's own routes, in
 * framework form or already as patterns) the most specific route that matches wins; otherwise
 * segments that read as record ids become `*`.
 */
export function routePatternFor(pathname: string, knownRoutes: string[] = []): string {
  const path = normalizePathname(pathname);
  const candidates = knownRoutes
    .map(routeToPattern)
    .filter((p) => matchRoutePattern(p, path))
    .sort((a, b) => specificity(b) - specificity(a));
  if (candidates[0]) return candidates[0];
  const segments = path.split("/").filter(Boolean).map((s) => (looksLikeId(s) ? "*" : s));
  return `/${segments.join("/")}`;
}

/** Does `pathname` belong to the screen `pattern` names? Query, hash and trailing slash ignored. */
export function matchRoutePattern(pattern: string, pathname: string): boolean {
  const want = normalizePathname(pattern).split("/").filter(Boolean);
  const have = normalizePathname(pathname).split("/").filter(Boolean);
  for (let i = 0; i < want.length; i++) {
    if (want[i] === "**") return true;
    if (i >= have.length) return false;
    if (want[i] !== "*" && want[i] !== have[i]) return false;
  }
  return want.length === have.length;
}
