// Types for the engine's MCP server builder (docs/scope.md "Agent connector (MCP server)";
// build-plan.md M15 step 3).
import type { SearchIndexEntry } from "../index-search/index.js";
import type { Procedure } from "../procedures/index.js";

/** Everything `createAidaMcpServer` needs to answer its four read-only tools. Callers (the
 * help app's route) are responsible for fetching these — usually straight from `public/
 * search-index.json` and `public/procedures.json`, the same files the site itself serves. */
export interface AidaMcpSource {
  searchIndexEntries: SearchIndexEntry[];
  procedures: Procedure[];
  /** Reads one page's content as plain Markdown for `get_page`, given its url (e.g.
   * "/add-competitor"). Returns `undefined` when there's no such page. */
  getPageMarkdown(url: string): Promise<string | undefined> | string | undefined;
}
