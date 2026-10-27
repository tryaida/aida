// Shared types for the engine-side search index (scope.md "Swappable
// providers": "Search ... Built in: an index file that ships with the help
// app; no database"). Consumed client-side by help-app/components/search-box.tsx.
export interface SearchIndexEntry {
  /** Page URL, e.g. "/how-do-i/add-competitor" — plus the rendered heading's `#anchor` for a
   * heading entry (e.g. "/how-do-i/add-competitor#before-you-start"). Indexes built before
   * anchors were added carry the bare page URL; `LexicalSearchProvider` adds the anchor then. */
  url: string;
  /** Page title (frontmatter `title`). */
  title: string;
  /** Heading text for this section, when the entry is a sub-heading rather than the page itself. */
  heading?: string;
  /** Plain-text content under that heading, truncated to a snippet. */
  text: string;
  /** Where the page sits in the library, e.g. "How do I… / Payments" (walkthrough pages only). */
  section?: string;
}

export interface BuildSearchIndexResult {
  entries: SearchIndexEntry[];
  /** Number of source Markdown/MDX files the index was built from. */
  pageCount: number;
  /** Absolute path the index was written to, when `write: true`. */
  outFile?: string;
}

/** One ranked retrieval hit: a page or a section within it, with a URL anchor when it's a
 * sub-heading (docs/scope.md "Swappable providers" / build-plan.md M15 step 2). */
export interface SearchHit {
  /** Page URL + `#anchor` for a heading hit, matching `help-app`'s heading-id scheme (a
   * lowercase, hyphenated slug of the heading text) — plain `url` for a lead-paragraph hit. */
  url: string;
  title: string;
  heading?: string;
  text: string;
  /** The page's library path, when the index entry carries one. */
  section?: string;
  score: number;
}

/**
 * Swappable retrieval provider (docs/scope.md "Swappable providers": "Built in: an index file
 * ... no database" now, "Supabase pgvector, Upstash Vector or Cloudflare Vectorize for big
 * sites" later). The built-in lexical provider (`search.ts`) is the only implementation shipped
 * today; this interface lets a hosted vector provider slot in later without changing callers.
 */
export interface SearchProvider {
  /** Returns up to `limit` ranked hits for `query`, optionally boosted by `boostUrls` (e.g. the
   * current in-app page's matching walkthrough/impact routes — see chat/retrieve.ts). */
  search(query: string, opts?: { limit?: number; boostUrls?: string[] }): Promise<SearchHit[]> | SearchHit[];
}
