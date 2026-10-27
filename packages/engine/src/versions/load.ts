// Resolves which search-index/procedures/llms.txt a chat or MCP request should answer from,
// given an optional `version` (query param / tool argument — build-plan.md M21 step 3). Shared
// by the help app's `/api/chat` and `/api/mcp` routes so both apply the same rule: no version,
// `"latest"`, or a name matching the manifest's `latest` all mean "the current build" (read
// straight from `publicDir`, same as before versioning existed); any other known name reads the
// frozen snapshot under `publicDir/versions/<name>`; an unknown name is a clear, listed error.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { readManifest } from "./manifest.js";
import type { ResolvedVersionSource, UnknownVersionError } from "./types.js";
import type { SearchIndexEntry } from "../index-search/index.js";
import type { Procedure } from "../procedures/index.js";

function readJson<T>(file: string): T | undefined {
  if (!existsSync(file)) return undefined;
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch {
    return undefined;
  }
}

function readText(file: string): string | undefined {
  if (!existsSync(file)) return undefined;
  try {
    return readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
}

export function resolveVersionSource(publicDir: string, version?: string): ResolvedVersionSource | UnknownVersionError {
  const manifest = readManifest(publicDir);
  const names = (manifest?.versions ?? []).map((v) => v.name);

  // A named version always reads its frozen snapshot, even the newest one: the current build
  // moves on after a freeze, so only "latest" (or no version) means the current build.
  if (!version || version === "latest") {
    return {
      name: "latest",
      searchIndexEntries: readJson<SearchIndexEntry[]>(join(publicDir, "search-index.json")) ?? [],
      procedures: readJson<Procedure[]>(join(publicDir, "procedures.json")) ?? [],
      llmsTxt: readText(join(publicDir, "llms.txt")),
    };
  }

  if (!names.includes(version)) {
    return { error: `unknown version "${version}" — available versions: ${names.length ? names.join(", ") : "(none frozen yet)"}`, availableVersions: names };
  }

  const dir = join(publicDir, "versions", version);
  return {
    name: version,
    searchIndexEntries: readJson<SearchIndexEntry[]>(join(dir, "search-index.json")) ?? [],
    procedures: readJson<Procedure[]>(join(dir, "procedures.json")) ?? [],
    llmsTxt: readText(join(dir, "llms.txt")),
  };
}

export function isUnknownVersionError(source: ResolvedVersionSource | UnknownVersionError): source is UnknownVersionError {
  return "error" in source;
}
