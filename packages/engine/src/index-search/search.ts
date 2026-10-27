// Built-in lexical retrieval over search-index.json: no database, no network (docs/scope.md
// "Swappable providers": Search default "Built in: an index file that ships with the help app;
// no database"). Scores with BM25 over a tiny tokenizer; `LexicalSearchProvider` implements the
// `SearchProvider` interface so a hosted vector provider (pgvector/Upstash/Vectorize) can slot
// in later (types.ts `SearchProvider`) without any caller change.
import type { SearchHit, SearchIndexEntry, SearchProvider } from "./types.js";

const STOPWORDS = new Set([
  "a", "an", "the", "and", "or", "but", "is", "are", "was", "were", "be", "been", "being",
  "to", "of", "in", "on", "for", "with", "at", "by", "from", "as", "it", "this", "that",
  "how", "do", "does", "i", "my", "you", "your", "can", "what", "where", "when",
]);

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 1 && !STOPWORDS.has(t));
}

/** A lowercase, hyphenated slug of heading text — matches the heading-id scheme Fumadocs/remark
 * generate, so a section hit's URL anchor actually lands on the right heading. */
export function slugify(heading: string): string {
  return heading
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-");
}

interface Doc {
  entry: SearchIndexEntry;
  tokens: string[];
  termFreq: Map<string, number>;
  url: string;
  /** `url` without its `#anchor` — what a boost URL (a page) is compared against. */
  pageUrl: string;
}

const K1 = 1.5;
const B = 0.75;

/**
 * Builds a BM25 index once (`entries` is small — a few hundred to a few thousand rows for most
 * help sites) and answers repeated `search()` calls cheaply. Pass `boostUrls` per call rather
 * than baking boosts into the index, since the current-page boost (chat's `currentPath`) varies
 * per request.
 */
export class LexicalSearchProvider implements SearchProvider {
  private docs: Doc[] = [];
  private docFreq = new Map<string, number>();
  private avgLen = 0;

  constructor(entries: SearchIndexEntry[]) {
    this.docs = entries.map((entry) => {
      const tokens = tokenize(`${entry.title} ${entry.heading ?? ""} ${entry.text}`);
      const termFreq = new Map<string, number>();
      for (const t of tokens) termFreq.set(t, (termFreq.get(t) ?? 0) + 1);
      // A current index already carries the heading's anchor in `url`; an older one doesn't.
      const url = entry.heading && !entry.url.includes("#") ? `${entry.url}#${slugify(entry.heading)}` : entry.url;
      return { entry, tokens, termFreq, url, pageUrl: url.split("#")[0] };
    });
    const seen = new Map<string, Set<number>>();
    this.docs.forEach((doc, i) => {
      for (const t of new Set(doc.tokens)) {
        if (!seen.has(t)) seen.set(t, new Set());
        seen.get(t)!.add(i);
      }
    });
    for (const [t, set] of seen) this.docFreq.set(t, set.size);
    this.avgLen = this.docs.length === 0 ? 0 : this.docs.reduce((s, d) => s + d.tokens.length, 0) / this.docs.length;
  }

  search(query: string, opts: { limit?: number; boostUrls?: string[] } = {}): SearchHit[] {
    const limit = opts.limit ?? 5;
    const boost = new Set(opts.boostUrls ?? []);
    const qTokens = [...new Set(tokenize(query))];
    if (qTokens.length === 0 || this.docs.length === 0) return [];

    const n = this.docs.length;
    const scored = this.docs.map((doc) => {
      let score = 0;
      for (const t of qTokens) {
        const tf = doc.termFreq.get(t);
        if (!tf) continue;
        const df = this.docFreq.get(t) ?? 0;
        const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5));
        const denom = tf + K1 * (1 - B + B * (doc.tokens.length / Math.max(this.avgLen, 1)));
        score += idf * ((tf * (K1 + 1)) / Math.max(denom, 1e-9));
      }
      if (score > 0 && (boost.has(doc.pageUrl) || boost.has(doc.url))) score *= 1.5;
      return { doc, score };
    });

    return scored
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map(({ doc, score }) => ({
        url: doc.url,
        title: doc.entry.title,
        heading: doc.entry.heading,
        text: doc.entry.text,
        ...(doc.entry.section ? { section: doc.entry.section } : {}),
        score,
      }));
  }
}

/** Convenience one-shot search, for callers that don't want to hold a `LexicalSearchProvider`
 * instance across requests (tests, the CLI). Prefer constructing the provider once per process
 * in the chat/MCP route handlers — rebuilding the BM25 index per request is wasted work. */
export function searchEntries(entries: SearchIndexEntry[], query: string, opts?: { limit?: number; boostUrls?: string[] }): SearchHit[] {
  return new LexicalSearchProvider(entries).search(query, opts);
}
