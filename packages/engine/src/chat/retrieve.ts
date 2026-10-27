// Retrieval step of the chat pipeline (docs/scope.md "Help chat"; build-plan.md M15 step 4):
// the best-matching pages — not sections — boosted by the in-app widget's current page, each
// with its matching procedure (steps, screenshot, video jump) when it's a walkthrough page.
//
// Ranked by page so one guide's five sections can't crowd out every other guide: a question
// spanning two tasks ("find unpaid entries and record their payments") gets both guides.
import { LexicalSearchProvider, type SearchHit, type SearchIndexEntry } from "../index-search/index.js";
import type { Procedure } from "../procedures/index.js";
import type { RetrievedContext, RetrievedPage } from "./types.js";

/** Pages scoring below this fraction of the best page are dropped as noise. */
const RELATIVE_SCORE_FLOOR = 0.3;
/** Sections searched before grouping into pages — enough to reach a site's whole index for
 * small sites, bounded for large ones. */
const SECTION_SEARCH_LIMIT = 200;

/** URLs to boost for this request: the current in-app page itself, plus every procedure whose
 * `start.page` or `impactRoutes` match it (scope.md "Help chat": "boosts docs whose walkthrough
 * start.page or impact routes match"). */
function boostUrlsFor(currentPath: string | undefined, procedures: Procedure[]): string[] {
  if (!currentPath) return [];
  const urls = [currentPath];
  for (const proc of procedures) {
    if (startsOrTouches(proc, currentPath)) urls.push(procedureUrl(proc));
  }
  return urls;
}

function startsOrTouches(proc: Procedure, path: string): boolean {
  return proc.start.page === path || (proc.impactRoutes ?? []).includes(path) || Boolean(pathStartingOn(proc, path));
}

/** The procedure's other way in (decision 34) that starts on `screen`, unless the main path does. */
function pathStartingOn(proc: Procedure | undefined, screen: string | undefined): string | undefined {
  if (!proc || !screen || proc.start.page === screen) return undefined;
  return proc.paths?.find((p) => p.start.page === screen)?.id;
}

/** A procedure's page URL: its `url` (the nested library URL, e.g.
 * "/how-do-i/payments/record-a-payment"), or the legacy flat `/<id>` for a procedures.json
 * written before pages were nested. */
export function procedureUrl(proc: Procedure): string {
  return proc.url ?? `/${proc.id}`;
}

/** A hit's page: its URL without the `#anchor` or a trailing slash. */
export function pageUrlOf(url: string): string {
  return url.split("#")[0].replace(/\/+$/, "") || "/";
}

/** The procedure for a page — matched by URL, falling back to the URL's last segment, which is
 * always the walkthrough id (walkthrough/placement.ts) — so an older flat `/<id>` index still
 * matches. */
function procedureFor(pageUrl: string, procedures: Procedure[]): Procedure | undefined {
  const lastSegment = pageUrl.split("/").pop() ?? "";
  return procedures.find((p) => procedureUrl(p) === pageUrl) ?? procedures.find((p) => p.id === lastSegment);
}

export function retrieve(
  question: string,
  searchIndexEntries: SearchIndexEntry[],
  procedures: Procedure[],
  opts: { currentPath?: string; limit?: number } = {},
): RetrievedContext {
  const limit = opts.limit ?? 4;
  const provider = new LexicalSearchProvider(searchIndexEntries);
  const boostUrls = boostUrlsFor(opts.currentPath, procedures);
  const hits = provider.search(question, { limit: SECTION_SEARCH_LIMIT, boostUrls }) as SearchHit[];

  // Group by page, keeping the page's best section score as its rank.
  const byPage = new Map<string, { score: number; title: string }>();
  for (const hit of hits) {
    const url = pageUrlOf(hit.url);
    const page = byPage.get(url);
    if (!page) byPage.set(url, { score: hit.score, title: hit.title });
    else page.score = Math.max(page.score, hit.score);
  }
  const ranked = [...byPage.entries()].sort((a, b) => b[1].score - a[1].score);
  const topScore = ranked[0]?.[1].score ?? 0;

  const pages: RetrievedPage[] = ranked
    .filter(([, p]) => p.score >= topScore * RELATIVE_SCORE_FLOOR)
    .slice(0, limit)
    .map(([url, p]) => ({
      url,
      title: p.title,
      score: p.score,
      // The whole page, in reading order — guides are short, and a section on its own loses
      // the "before you start" and caveats around it.
      sections: searchIndexEntries.filter((e) => pageUrlOf(e.url) === url),
      procedure: procedureFor(url, procedures),
    }))
    .map((page) => {
      const currentPathId = pathStartingOn(page.procedure, opts.currentPath);
      return currentPathId ? { ...page, currentPathId } : page;
    });

  // Nothing matched, but the reader is on a screen a walkthrough covers: offer that one.
  if (pages.length === 0 && opts.currentPath) {
    const proc = procedures.find((p) => startsOrTouches(p, opts.currentPath!));
    if (proc) {
      const url = procedureUrl(proc);
      const currentPathId = pathStartingOn(proc, opts.currentPath);
      pages.push({
        url,
        title: proc.title,
        score: 0,
        sections: searchIndexEntries.filter((e) => pageUrlOf(e.url) === url),
        procedure: proc,
        ...(currentPathId ? { currentPathId } : {}),
      });
    }
  }

  return { pages, topScore };
}
