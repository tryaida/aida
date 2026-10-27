// The site's search (Ctrl/⌘ K, and every search button Fumadocs renders). Searches the
// engine-built public/search-index.json in the browser — no server route or database, so it works
// on any host and on a static export (docs/scope.md "Swappable providers": search built in).
// Fumadocs' dialog supplies the look, keyboard navigation and focus handling; results are passed
// in as "action" items so the index format stays aida's own.
"use client";

import {
  SearchDialog,
  SearchDialogClose,
  SearchDialogContent,
  SearchDialogFooter,
  SearchDialogHeader,
  SearchDialogIcon,
  SearchDialogInput,
  SearchDialogList,
  SearchDialogOverlay,
  type SearchItemType,
} from "fumadocs-ui/components/dialog/search";
import type { SharedProps } from "fumadocs-ui/contexts/search";
import { FileText, Hash } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";

export interface SearchIndexEntry {
  url: string;
  title: string;
  heading?: string;
  section?: string;
  text: string;
}

interface Hit {
  entry: SearchIndexEntry;
  score: number;
}

let cachedIndex: Promise<SearchIndexEntry[]> | undefined;

function loadIndex(): Promise<SearchIndexEntry[]> {
  cachedIndex ??= fetch("/search-index.json")
    .then((res) => (res.ok ? res.json() : []))
    .then((data: unknown) => (Array.isArray(data) ? (data as SearchIndexEntry[]) : []))
    .catch(() => []);
  return cachedIndex;
}

/** Strips anything markup-like an older index may still carry (MDX comments, tags, images). */
function cleanText(text: string): string {
  return text
    .replace(/\{\/?\*?[\s\S]*?\*?\/?\}/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/[*_`#>]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Every query word must appear somewhere; titles and headings count for more than body text. */
function rank(index: SearchIndexEntry[], query: string): Hit[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  const hits: Hit[] = [];
  for (const entry of index) {
    const title = entry.title.toLowerCase();
    const heading = entry.heading?.toLowerCase() ?? "";
    const text = entry.text.toLowerCase();
    let score = 0;
    let all = true;
    for (const w of words) {
      const s = (title.includes(w) ? 6 : 0) + (heading.includes(w) ? 4 : 0) + (text.includes(w) ? 1 : 0);
      if (s === 0) {
        all = false;
        break;
      }
      score += s;
    }
    if (!all) continue;
    if (title.startsWith(words[0])) score += 3;
    // A whole guide beats one of its own sections when both match.
    if (!entry.heading) score += 8;
    hits.push({ entry, score });
  }
  // At most three results per guide, so one long page can't fill the list.
  const perPage = new Map<string, number>();
  return hits
    .sort((a, b) => b.score - a.score)
    .filter((h) => {
      const n = perPage.get(h.entry.url.split("#")[0]) ?? 0;
      perPage.set(h.entry.url.split("#")[0], n + 1);
      return n < 3;
    })
    .slice(0, 12);
}

/** A short excerpt of `text` around the first query word. */
function excerpt(text: string, query: string): string {
  const clean = cleanText(text);
  const first = query.toLowerCase().split(/\s+/).find(Boolean) ?? "";
  const at = first ? clean.toLowerCase().indexOf(first) : -1;
  const start = Math.max(0, at - 40);
  const snippet = clean.slice(start, start + 140);
  return `${start > 0 ? "…" : ""}${snippet}${start + 140 < clean.length ? "…" : ""}`;
}

function Row({ entry, query }: { entry: SearchIndexEntry; query: string }) {
  const Icon = entry.heading ? Hash : FileText;
  return (
    <div className="flex items-start gap-3 px-2.5 py-2">
      <Icon className="mt-0.5 size-4 shrink-0 text-fd-muted-foreground" />
      <div className="min-w-0">
        {entry.section ? <div className="truncate text-xs text-fd-muted-foreground">{entry.section}</div> : null}
        <div className="truncate font-medium">
          {entry.title}
          {entry.heading ? <span className="font-normal text-fd-muted-foreground"> · {entry.heading}</span> : null}
        </div>
        {query ? <div className="line-clamp-2 text-xs text-fd-muted-foreground">{excerpt(entry.text, query)}</div> : null}
      </div>
    </div>
  );
}

export default function HelpSearchDialog(props: SharedProps) {
  const router = useRouter();
  const [index, setIndex] = useState<SearchIndexEntry[] | undefined>();
  const [search, setSearch] = useState("");

  useEffect(() => {
    if (props.open && !index) void loadIndex().then(setIndex);
  }, [props.open, index]);

  const toItem = (entry: SearchIndexEntry, query: string, key: string): SearchItemType => ({
    id: key,
    type: "action",
    node: <Row entry={entry} query={query} />,
    onSelect: () => router.push(entry.url),
  });

  const query = search.trim();
  const items = useMemo(() => {
    if (!index || query.length < 2) return null;
    return rank(index, query).map((h, i) => toItem(h.entry, query, `${h.entry.url}#${h.entry.heading ?? ""}#${i}`));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- toItem only closes over router
  }, [index, query]);

  // With nothing typed, list every guide once, so the dialog doubles as a quick index.
  const defaultItems = useMemo(() => {
    if (!index) return null;
    const seen = new Set<string>();
    const pages = index.filter((e) => !e.heading && e.url !== "/" && !seen.has(e.url) && seen.add(e.url));
    return pages.slice(0, 8).map((e) => toItem(e, "", `default:${e.url}`));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index]);

  return (
    <SearchDialog
      open={props.open}
      onOpenChange={props.onOpenChange}
      dialogHandle={props.dialogHandle}
      search={search}
      onSearchChange={setSearch}
      isLoading={!index}
    >
      <SearchDialogOverlay />
      <SearchDialogContent>
        <SearchDialogHeader>
          <SearchDialogIcon />
          <SearchDialogInput placeholder="Search guides, steps and screens…" />
          <SearchDialogClose />
        </SearchDialogHeader>
        <SearchDialogList
          items={items}
          defaultItems={defaultItems}
          Empty={() => (
            <div className="px-3 py-10 text-center text-sm text-fd-muted-foreground">
              No guides match “{query}”. Try fewer or different words, or ask the help chat.
            </div>
          )}
        />
        <SearchDialogFooter>
          <div className="flex w-full items-center gap-4 px-1 text-xs text-fd-muted-foreground">
            <span>
              <kbd className="rounded border px-1">↑</kbd> <kbd className="rounded border px-1">↓</kbd> to move
            </span>
            <span>
              <kbd className="rounded border px-1">Enter</kbd> to open
            </span>
            <span className="ms-auto">
              <kbd className="rounded border px-1">Esc</kbd> to close
            </span>
          </div>
        </SearchDialogFooter>
      </SearchDialogContent>
    </SearchDialog>
  );
}
