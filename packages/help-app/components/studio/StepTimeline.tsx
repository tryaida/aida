"use client";
import { useEffect, useRef } from "react";
import { cn } from "@/lib/cn";
import { screenshotUrl, useStudioBlob } from "./api";
import { estimateSeconds } from "./format";
import type { StudioManifest, StudioStep } from "./types";

/** A compact horizontal strip of the walkthrough's steps (M22 timeline): one thumbnail per step
 * with its number and title, chapter breaks marked, a bar under each showing its rough share of
 * the video's length. Clicking selects the step; the selected one scrolls into view. */
export function StepTimeline({
  walkthroughId,
  steps,
  manifest,
  selectedStepId,
  onSelect,
  studioToken,
}: {
  walkthroughId: string;
  steps: StudioStep[];
  manifest?: StudioManifest;
  selectedStepId?: string;
  onSelect: (stepId: string) => void;
  studioToken: string;
}) {
  const stripRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!selectedStepId || !stripRef.current) return;
    const el = stripRef.current.querySelector<HTMLElement>(`[data-chip="${CSS.escape(selectedStepId)}"]`);
    el?.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "smooth" });
  }, [selectedStepId]);

  if (steps.length === 0) return null;
  const durations = steps.map(estimateSeconds);
  const total = durations.reduce((a, b) => a + b, 0);
  const longest = Math.max(...durations);

  return (
    <div>
      <div className="flex items-center justify-between px-5 pt-2.5 text-[11px] text-fd-muted-foreground">
        <span className="font-medium uppercase tracking-wide">Timeline</span>
        <span className="tabular-nums" title="Estimated from narration length and hold times">
          {steps.length} steps · about {formatDuration(total)}
        </span>
      </div>
      <div ref={stripRef} className="studio-scroll-x flex gap-2 overflow-x-auto px-5 pb-3 pt-2" role="listbox" aria-label="Steps">
        {steps.map((step, i) => {
          const selected = step.id !== undefined && step.id === selectedStepId;
          const newChapter = step.chapter && step.chapter !== steps[i - 1]?.chapter;
          return (
            <div key={step.id ?? i} className="flex shrink-0 items-stretch gap-2">
              {newChapter && i > 0 ? <div className="my-1 w-px bg-fd-border" title={step.chapter} aria-hidden /> : null}
              <button
                type="button"
                role="option"
                aria-selected={selected}
                data-chip={step.id}
                title={`${i + 1}. ${step.title ?? step.id ?? "Step"} · about ${durations[i].toFixed(1)}s${step.chapter ? ` · ${step.chapter}` : ""}`}
                onClick={() => step.id && onSelect(step.id)}
                className={cn(
                  "studio-focus group w-[104px] rounded-lg p-1 text-left transition-colors",
                  selected ? "bg-fd-primary/10" : "hover:bg-fd-muted",
                )}
              >
                <div
                  className={cn(
                    "relative aspect-video overflow-hidden rounded-md border bg-fd-muted",
                    selected ? "border-fd-primary ring-2 ring-fd-primary/30" : "border-fd-border",
                  )}
                >
                  <Thumb walkthroughId={walkthroughId} stepNumber={i + 1} hasImage={Boolean(manifest?.steps[i]?.image)} studioToken={studioToken} />
                  <span
                    className={cn(
                      "absolute left-1 top-1 flex h-4 min-w-4 items-center justify-center rounded px-1 text-[10px] font-bold tabular-nums shadow-sm",
                      selected ? "bg-fd-primary text-fd-primary-foreground" : "studio-surface text-fd-foreground",
                    )}
                  >
                    {i + 1}
                  </span>
                </div>
                <div className={cn("mt-1 truncate px-0.5 text-[11px] leading-tight", selected ? "font-semibold text-fd-primary" : "text-fd-muted-foreground group-hover:text-fd-foreground")}>
                  {step.title ?? step.id ?? `Step ${i + 1}`}
                </div>
                <div className="mx-0.5 mt-1 h-0.5 rounded-full bg-fd-border">
                  <div
                    className={cn("h-full rounded-full", selected ? "bg-fd-primary" : "bg-fd-muted-foreground/40")}
                    style={{ width: `${Math.max(8, (durations[i] / longest) * 100)}%` }}
                  />
                </div>
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function Thumb({ walkthroughId, stepNumber, hasImage, studioToken }: { walkthroughId: string; stepNumber: number; hasImage: boolean; studioToken: string }) {
  const blob = useStudioBlob(hasImage ? screenshotUrl(walkthroughId, stepNumber) : undefined, studioToken);
  if (blob.status === "ready") {
    // eslint-disable-next-line @next/next/no-img-element -- dev-only Studio, blob URL from our own fetch
    return <img src={blob.src} alt="" className="absolute inset-0 size-full object-cover object-top" draggable={false} />;
  }
  return <div className={cn("absolute inset-0", blob.status === "loading" && "studio-skeleton rounded-none")} />;
}

export function formatDuration(seconds: number): string {
  const s = Math.round(seconds);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
}
