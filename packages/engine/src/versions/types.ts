// Shared types for versioned docs (docs/scope.md "Help site": "a version per release";
// "When it runs": "Release tag. Freeze a versioned copy. Chat and MCP answer for that
// version."; build-plan.md M21).
import type { SearchIndexEntry } from "../index-search/index.js";
import type { Procedure } from "../procedures/index.js";

/** One frozen version's manifest row. */
export interface VersionManifestEntry {
  name: string;
  /** ISO timestamp the version was frozen. */
  date: string;
  /** Git ref (usually a release tag) this version corresponds to, when known — used as the
   * default `--since` for `aida whats-new`'s next run. */
  gitRef?: string;
}

/** `public/versions.json` — the help app's version switcher and the chat/MCP routes both read
 * this to know which version names exist and which one "latest" (the unversioned site) matches. */
export interface VersionManifest {
  latest: string;
  versions: VersionManifestEntry[];
}

export interface FreezeVersionOptions {
  /** The help app directory (holds `public/`, `content/`). */
  helpApp: string;
  name: string;
  /** Git ref this version corresponds to (e.g. the release tag that triggered the freeze). */
  gitRef?: string;
  /** Injectable clock, for deterministic tests. */
  now?: () => Date;
  /** Overwrite an existing snapshot with the same name instead of erroring. */
  force?: boolean;
}

export interface FreezeVersionResult {
  name: string;
  dir: string;
  manifestFile: string;
  /** Snapshot files actually copied (a missing source file, e.g. no procedures.json yet, is
   * skipped rather than failing the freeze). */
  files: string[];
}

/** Everything a chat or MCP request needs for one version: the current/"latest" build when
 * `name` matches the manifest's `latest`, otherwise a frozen snapshot under `public/versions/`. */
export interface ResolvedVersionSource {
  name: string;
  searchIndexEntries: SearchIndexEntry[];
  procedures: Procedure[];
  llmsTxt?: string;
}

/** Returned instead of `ResolvedVersionSource` when the requested version doesn't match any
 * frozen snapshot — callers should answer with a clear 400 listing `availableVersions`. */
export interface UnknownVersionError {
  error: string;
  availableVersions: string[];
}
