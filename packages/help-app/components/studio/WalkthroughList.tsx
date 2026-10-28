"use client";
import { useMemo, useState } from "react";
import { cn } from "@/lib/cn";
import { groupLibrary, healthNotes, relativeTime, STATUS_LABEL } from "./format";
import { Icon } from "./icons";
import type { CaptureStatus, WalkthroughSummary } from "./types";
import { aidaCli } from "./aida-cli";

/** The walkthrough library: search box, then the help library's categories (Contract 3) as
 * collapsible groups, feature groups inside them, and one row per walkthrough with its status. */
export function WalkthroughList({
  walkthroughs,
  loading,
  selectedId,
  onSelect,
}: {
  walkthroughs: WalkthroughSummary[];
  loading: boolean;
  selectedId?: string;
  onSelect: (id: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const library = useMemo(() => groupLibrary(walkthroughs, query), [walkthroughs, query]);
  const searching = query.trim().length > 0;

  const toggle = (slug: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(slug)) next.delete(slug);
      else next.add(slug);
      return next;
    });

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-11 shrink-0 items-center justify-between px-3">
        <h2 className="text-[13px] font-semibold">Walkthroughs</h2>
        {!loading && walkthroughs.length > 0 ? (
          <span className="rounded-full bg-fd-muted px-2 py-0.5 text-[11px] font-medium tabular-nums text-fd-muted-foreground">
            {walkthroughs.length}
          </span>
        ) : null}
      </div>
      {walkthroughs.length > 0 ? (
        <div className="shrink-0 px-3 pb-2">
          <label className="relative block">
            <span className="sr-only">Search walkthroughs</span>
            <Icon name="search" className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-fd-muted-foreground" />
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") setQuery("");
              }}
              placeholder="Search walkthroughs"
              className="studio-input h-8 w-full pl-8 pr-2 text-[13px]"
            />
          </label>
        </div>
      ) : null}

      <nav className="studio-scroll min-h-0 flex-1 overflow-y-auto px-2 pb-6" aria-label="Walkthroughs">
        {loading ? (
          <ListSkeleton />
        ) : walkthroughs.length === 0 ? (
          <EmptyLibrary />
        ) : library.length === 0 ? (
          <p className="px-2 py-6 text-center text-xs text-fd-muted-foreground">Nothing matches “{query.trim()}”.</p>
        ) : (
          library.map((cat) => {
            const open = searching || !collapsed.has(cat.category);
            return (
              <div key={cat.category} className="mb-1">
                <button
                  type="button"
                  onClick={() => toggle(cat.category)}
                  aria-expanded={open}
                  className="studio-focus group flex w-full items-center gap-1 rounded-md px-1.5 py-1.5 text-left text-[11px] font-semibold uppercase tracking-wide text-fd-muted-foreground hover:text-fd-foreground"
                >
                  <Icon name="chevronRight" className={cn("size-3.5 transition-transform", open && "rotate-90")} />
                  <span className="flex-1">{cat.title}</span>
                  <span className="font-medium tabular-nums opacity-70">{cat.count}</span>
                </button>
                {open ? (
                  <div className="mt-0.5">
                    {cat.groups.map((g) => (
                      <div key={g.name || "_"} className={cn(g.name && "mt-2")}>
                        {g.name ? (
                          <div className="flex items-center gap-1.5 px-2.5 pb-1 text-[11px] font-medium text-fd-muted-foreground">
                            <Icon name="layers" className="size-3" />
                            <span className="truncate">{g.name.split(" / ").join(" › ")}</span>
                          </div>
                        ) : null}
                        <ul className="flex flex-col gap-px">
                          {g.items.map((w) => (
                            <li key={w.id}>
                              <Row w={w} selected={w.id === selectedId} onSelect={onSelect} />
                            </li>
                          ))}
                        </ul>
                      </div>
                    ))}
                  </div>
                ) : null}
              </div>
            );
          })
        )}
      </nav>
    </div>
  );
}

function Row({ w, selected, onSelect }: { w: WalkthroughSummary; selected: boolean; onSelect: (id: string) => void }) {
  const notes = healthNotes(w);
  return (
    <button
      type="button"
      onClick={() => onSelect(w.id)}
      aria-current={selected ? "page" : undefined}
      title={w.summary}
      className={cn(
        "studio-focus relative flex w-full items-start gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors",
        selected ? "bg-fd-primary/10 text-fd-foreground" : "hover:bg-fd-muted",
      )}
    >
      {selected ? <span className="absolute inset-y-2 left-0 w-0.5 rounded-full bg-fd-primary" aria-hidden /> : null}
      <StatusDot status={w.status} className="mt-[5px]" />
      <span className="min-w-0 flex-1">
        <span className={cn("line-clamp-2 text-[13px] leading-snug", selected ? "font-semibold text-fd-primary" : "font-medium")}>{w.title}</span>
        <span className="mt-0.5 block truncate text-[11px] text-fd-muted-foreground">
          {w.stepCount} step{w.stepCount === 1 ? "" : "s"}
          {w.lastChecked ? ` · checked ${relativeTime(w.lastChecked)}` : w.status === "not-captured" ? " · not captured" : ""}
        </span>
        {notes.length > 0 ? (
          <span className={cn("mt-0.5 block truncate text-[11px]", w.failure?.category === "app" ? "text-red-700 dark:text-red-400" : "text-amber-700 dark:text-amber-400")} title={w.failure?.reason}>
            {notes.join(" · ")}
          </span>
        ) : null}
      </span>
    </button>
  );
}

const DOT: Record<CaptureStatus, string> = {
  passed: "bg-emerald-500",
  failed: "bg-red-500",
  captured: "bg-amber-400",
  "not-captured": "bg-fd-muted-foreground/40",
};

export function StatusDot({ status, className }: { status: CaptureStatus; className?: string }) {
  return (
    <span className={cn("relative flex size-2 shrink-0", className)} title={STATUS_LABEL[status]}>
      {status === "failed" ? <span className="absolute inset-0 animate-ping rounded-full bg-red-500/50" /> : null}
      <span className={cn("relative size-2 rounded-full", DOT[status])} />
      <span className="sr-only">{STATUS_LABEL[status]}</span>
    </span>
  );
}

function EmptyLibrary() {
  return (
    <div className="mx-1 mt-2 rounded-xl border border-dashed border-fd-border p-4 text-[13px]">
      <div className="mb-3 flex size-9 items-center justify-center rounded-lg bg-fd-primary/10 text-fd-primary">
        <Icon name="book" className="size-4.5" />
      </div>
      <p className="font-semibold">No walkthroughs yet</p>
      <p className="mt-1 leading-relaxed text-fd-muted-foreground">
        A walkthrough is a short file describing one task in your app, step by step. Every help page, video and chat
        answer is made from them.
      </p>
      <ol className="mt-3 space-y-2 text-xs leading-relaxed text-fd-muted-foreground">
        <li className="flex gap-2">
          <span className="studio-step-num">1</span>
          <span>
            Ask your coding agent: <em className="text-fd-foreground">“Use AIDA to write a walkthrough for inviting a teammate.”</em>
          </span>
        </li>
        <li className="flex gap-2">
          <span className="studio-step-num">2</span>
          <span>
            It saves the file in <code className="studio-code">walkthroughs/</code>. Then run <code className="studio-code">{aidaCli("build")}</code> from your aida checkout to
            capture screenshots and build the page.
          </span>
        </li>
        <li className="flex gap-2">
          <span className="studio-step-num">3</span>
          <span>Come back here to edit the words, callouts and pacing.</span>
        </li>
      </ol>
    </div>
  );
}

function ListSkeleton() {
  return (
    <div className="space-y-1 px-1 pt-1" aria-hidden>
      <div className="studio-skeleton mb-2 h-3 w-24" />
      {[0, 1, 2, 3, 4].map((i) => (
        <div key={i} className="flex gap-2.5 rounded-lg px-2 py-2">
          <div className="studio-skeleton mt-1 size-2 rounded-full" />
          <div className="flex-1 space-y-1.5">
            <div className="studio-skeleton h-3" style={{ width: `${85 - i * 9}%` }} />
            <div className="studio-skeleton h-2.5 w-1/3" />
          </div>
        </div>
      ))}
    </div>
  );
}
