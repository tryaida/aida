"use client";
import { useEffect, useState } from "react";
import { cn } from "@/lib/cn";
import { describeEntry, relativeTime, undoState } from "./format";
import { Icon, Spinner } from "./icons";
import type { HistoryEntry } from "./types";

/** Every edit, newest first — who made it (a person in the Studio, or an agent), what changed in
 * plain words, and when — with Undo for the last edit and for the agent's last edit. Collapsible
 * so the preview gets the room when history isn't needed. */
export function HistoryPanel({
  entries,
  titles,
  onUndo,
  undoing,
  onSelectStep,
  loading,
}: {
  entries: HistoryEntry[];
  loading?: boolean;
  /** walkthrough id → title, to name the walkthrough an entry touched. */
  titles: Record<string, string>;
  onUndo: (by?: "agent" | "person") => void;
  undoing: boolean;
  onSelectStep?: (walkthroughId: string, stepId?: string) => void;
}) {
  const [open, setOpen] = useState(true);
  const now = useNow(30_000);
  // `entries` is newest first; the engine's undo bookkeeping (undoOf) counts oldest first.
  const { undone, canUndo, canUndoAgent } = undoState([...entries].reverse());

  return (
    <section className={cn("flex shrink-0 flex-col border-t border-fd-border studio-surface", open && "max-h-[42%] min-h-[10rem]")} aria-label="History">
      <div className="flex h-11 shrink-0 items-center gap-2 px-3">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          className="studio-focus -ml-1 flex items-center gap-1.5 rounded-md px-1 py-0.5 text-[13px] font-semibold"
        >
          <Icon name="chevronRight" className={cn("size-3.5 text-fd-muted-foreground transition-transform", open && "rotate-90")} />
          History
          {entries.length > 0 ? (
            <span className="rounded-full bg-fd-muted px-1.5 text-[11px] font-medium tabular-nums text-fd-muted-foreground">{entries.length}</span>
          ) : null}
        </button>
        <div className="ml-auto flex items-center gap-1">
          {undoing ? <Spinner className="mr-1 size-3.5 text-fd-muted-foreground" /> : null}
          <button
            type="button"
            disabled={undoing || !canUndo}
            onClick={() => onUndo()}
            className="studio-btn"
            title="Undo the most recent edit, whoever made it"
          >
            <Icon name="undo" className="size-3.5" />
            Undo
          </button>
          <button
            type="button"
            disabled={undoing || !canUndoAgent}
            onClick={() => onUndo("agent")}
            className="studio-btn"
            title="Undo the most recent edit an agent made"
          >
            <Icon name="bot" className="size-3.5" />
            Undo agent
          </button>
        </div>
      </div>

      {open ? (
        <ol className="studio-scroll min-h-0 flex-1 overflow-y-auto px-3 pb-3">
          {loading ? (
            <li className="space-y-2 pt-1" aria-hidden>
              <div className="studio-skeleton h-3 w-2/3" />
              <div className="studio-skeleton h-3 w-1/2" />
            </li>
          ) : entries.length === 0 ? (
            <li className="rounded-lg border border-dashed border-fd-border px-3 py-4 text-center text-xs text-fd-muted-foreground">
              No edits yet. Changes you make here — and ones your agent makes — show up in this list, and every one can be
              undone.
            </li>
          ) : null}
          {entries.map((e, i) => {
            const d = describeEntry(e);
            const person = e.by === "person";
            const wtTitle = d.walkthroughId ? titles[d.walkthroughId] ?? d.walkthroughId : undefined;
            const wasUndone = undone.has(entries.length - 1 - i);
            return (
              <li key={`${e.at}-${i}`} className={cn("relative flex gap-2.5 pb-3 last:pb-0", wasUndone && "opacity-55")}>
                {i < entries.length - 1 ? <span className="absolute bottom-0 left-[11px] top-6 w-px bg-fd-border" aria-hidden /> : null}
                <span
                  className={cn(
                    "relative mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full",
                    person ? "bg-fd-primary/12 text-fd-primary" : "bg-violet-500/12 text-violet-600 dark:text-violet-400",
                  )}
                  title={person ? "A person" : "An agent"}
                >
                  <Icon name={person ? "user" : "bot"} className="size-3.5" />
                </span>
                <div className="min-w-0 flex-1 text-xs">
                  <p className="leading-snug">
                    <span className="font-semibold">{person ? "You" : "Agent"}</span> {d.what}
                    {d.stepId ? (
                      <>
                        {" "}
                        on{" "}
                        <button
                          type="button"
                          onClick={() => d.walkthroughId && onSelectStep?.(d.walkthroughId, d.stepId)}
                          className="studio-focus rounded font-medium text-fd-foreground underline decoration-fd-border underline-offset-2 hover:decoration-fd-primary"
                        >
                          {d.stepId}
                        </button>
                      </>
                    ) : null}
                    {wasUndone ? (
                      <span className="ml-1.5 rounded bg-fd-muted px-1 py-px align-[1px] text-[10px] font-medium uppercase tracking-wide text-fd-muted-foreground">
                        undone
                      </span>
                    ) : null}
                  </p>
                  {d.after !== undefined ? (
                    <div className="mt-1 space-y-0.5 rounded-md bg-fd-muted/60 px-2 py-1.5 text-[11px] leading-snug">
                      {d.before ? <p className="text-fd-muted-foreground line-through decoration-fd-muted-foreground/50">{d.before}</p> : null}
                      <p>{d.after || <em className="text-fd-muted-foreground">empty</em>}</p>
                    </div>
                  ) : null}
                  <p className="mt-0.5 truncate text-[11px] text-fd-muted-foreground" title={new Date(e.at).toLocaleString()}>
                    {relativeTime(e.at, now)}
                    {wtTitle ? ` · ${wtTitle}` : ""}
                  </p>
                </div>
              </li>
            );
          })}
        </ol>
      ) : null}
    </section>
  );
}

function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}
