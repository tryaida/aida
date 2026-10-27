export { buildSearchIndex, stripMarkdown, HeadingSlugger } from "./build.js";
export type { SearchIndexEntry, BuildSearchIndexResult, SearchHit, SearchProvider } from "./types.js";
export { LexicalSearchProvider, searchEntries, tokenize, slugify } from "./search.js";
