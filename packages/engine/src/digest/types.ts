// Types for `aida digest` (scope.md "Token efficiency, models and subagents": "`aida digest`
// gives a compact map of routes, roles and labels so an agent doesn't read the whole repo.").

export interface DigestRoute {
  /** Route path, e.g. "/dashboard/competitors/[id]". */
  path: string;
  /** File path relative to the app repo root, e.g. "app/dashboard/competitors/[id]/page.tsx". */
  file: string;
  /** True when any segment is a dynamic `[param]` or catch-all `[...param]` segment. */
  dynamic: boolean;
  /** Route group name, e.g. "(site)", when the route sits under one. */
  group?: string;
}

export interface DigestResult {
  /** Absolute path to the app repo this digest describes. */
  appRepo: string;
  framework: "nextjs-app" | "nextjs-pages" | "unknown";
  routes: DigestRoute[];
  /** Detected role names/enum members from auth/permission files, deduped and sorted. */
  roles: string[];
  /** On-screen button/label text per route path, capped per route. */
  labelsByRoute: Record<string, string[]>;
  /** e.g. "Auth.js", "Clerk", "Supabase Auth", "Firebase Auth", or "unknown". */
  signInMethod?: string;
  /** True when any section of this digest was capped/truncated to stay within budget. */
  truncated: boolean;
  /** Set instead of routes/roles/labels when `appRepo` is a workspace monorepo with more than
   * one Next.js app and no `--app`/`opts.app` was given to pick one. */
  apps?: { path: string; routeCount: number }[];
  /** A short human-readable message for the `apps` case above, e.g. "found 3 Next.js apps...". */
  message?: string;
}
