// Types for the engine's MCP server builder (docs/scope.md "Agent connector (MCP server)";
// build-plan.md M15 step 3).
import type { SearchIndexEntry } from "../index-search/index.js";
import type { Procedure } from "../procedures/index.js";

/** Everything `createAidaMcpServer` needs to answer its five read-only tools. Callers (the
 * help app's route) are responsible for fetching these — usually straight from `public/
 * search-index.json`, `public/procedures.json` and `public/app-overview.md`, the same files the
 * site itself serves. */
export interface AidaMcpSource {
  searchIndexEntries: SearchIndexEntry[];
  procedures: Procedure[];
  /** Reads one page's content as plain Markdown for `get_page`, given its url (e.g.
   * "/add-competitor"). Returns `undefined` when there's no such page. */
  getPageMarkdown(url: string): Promise<string | undefined> | string | undefined;
  /** The app overview for `get_app_overview`: Markdown trimmed from the app brief by `aida build`
   * (`public/app-overview.md`, brief/consumers.ts `briefOverview`). Absent when the app has no
   * brief yet. */
  appOverview?: string;
}
