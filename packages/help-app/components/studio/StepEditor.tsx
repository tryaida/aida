"use client";
import { forwardRef, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { cn } from "@/lib/cn";
import { screenshotUrl, useStudioBlob } from "./api";
import { captionCues } from "./format";
import { Icon, Spinner } from "./icons";
import type { StudioStep } from "./types";

export type StepField = "title" | "say" | "caption" | "page_text" | "hold";

const FIELDS: { key: "say" | "caption" | "page_text"; label: string; hint: string; rows: number }[] = [
  { key: "say", label: "Narration", hint: "spoken in the video", rows: 2 },
  { key: "caption", label: "Caption", hint: "on screen in the video", rows: 2 },
  { key: "page_text", label: "Page text", hint: "on the help page · **bold** for buttons", rows: 2 },
];

/** One step as a card: number badge, editable title and hold time, a thumbnail of its captured
 * screenshot, and its narration/caption/page text. Every field saves on blur (if changed) and
 * shows its own Saving…/Saved/error state, so one field's problem never blocks another. The
 * selected card also shows `children` (the screenshot editor) below. */
export const StepEditor = forwardRef<
  HTMLElement,
  {
    walkthroughId: string;
    step: StudioStep;
    index: number;
    selected: boolean;
    hasImage: boolean;
    studioToken: string;
    onSelect: () => void;
    onSave: (field: StepField, value: string | number) => Promise<unknown>;
    children?: ReactNode;
  }
>(function StepEditor({ walkthroughId, step, index, selected, hasImage, studioToken, onSelect, onSave, children }, ref) {
  return (
    <article
      ref={ref}
      data-step-card={step.id}
      onClick={onSelect}
      onFocusCapture={onSelect}
      className={cn(
        "studio-card group/card scroll-mt-4 rounded-xl border studio-surface transition-[border-color,box-shadow]",
        selected ? "border-fd-primary/60 shadow-md ring-1 ring-fd-primary/40" : "border-fd-border shadow-sm hover:border-fd-primary/30",
      )}
    >
      <header className="flex items-center gap-3 px-4 pt-3.5">
        <span
          className={cn(
            "flex size-7 shrink-0 items-center justify-center rounded-full text-[13px] font-bold tabular-nums transition-colors",
            selected ? "bg-fd-primary text-fd-primary-foreground" : "bg-fd-muted text-fd-foreground",
          )}
        >
          {index + 1}
        </span>
        <div className="min-w-0 flex-1">
          <TitleField value={step.title ?? ""} placeholder={step.id ?? `Step ${index + 1}`} onCommit={(v) => onSave("title", v)} />
        </div>
        {step.chapter ? (
          <span className="hidden max-w-[12rem] truncate rounded-full border border-fd-border px-2 py-0.5 text-[11px] text-fd-muted-foreground @xl:inline" title="Chapter">
            {step.chapter}
          </span>
        ) : null}
        <HoldField value={step.hold} onCommit={(v) => onSave("hold", v)} />
      </header>

      <div className="grid gap-4 px-4 pb-4 pt-3 @2xl:grid-cols-[minmax(0,13rem)_minmax(0,1fr)]">
        <StepThumb walkthroughId={walkthroughId} stepNumber={index + 1} hasImage={hasImage} studioToken={studioToken} selected={selected} />
        <div className="grid min-w-0 gap-3 @4xl:grid-cols-2">
          {FIELDS.map((f) => (
            <TextField
              key={f.key}
              label={f.label}
              hint={f.hint}
              rows={f.rows}
              value={step[f.key] ?? ""}
              className={f.key === "page_text" ? "@4xl:col-span-2" : undefined}
              extra={f.key === "caption" ? (v) => <CaptionHint text={v} /> : undefined}
              onCommit={(v) => onSave(f.key, v)}
            />
          ))}
        </div>
      </div>

      {children ? (
        <div className="border-t border-fd-border px-4 pb-4 pt-3" onClick={(e) => e.stopPropagation()}>
          {children}
        </div>
      ) : null}
    </article>
  );
});

type SaveState = { kind: "idle" } | { kind: "saving" } | { kind: "saved" } | { kind: "error"; message: string };

/** Commit-on-blur state shared by every field: keeps a local draft, re-syncs it when the saved
 * value changes underneath (an undo, an agent's edit) unless the person is mid-edit. */
function useCommitField<T extends string>(value: T, onCommit: (v: T) => Promise<unknown>) {
  const [draft, setDraft] = useState<T>(value);
  const [state, setState] = useState<SaveState>({ kind: "idle" });
  const focused = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => {
    if (!focused.current) setDraft(value);
  }, [value]);
  useEffect(() => () => clearTimeout(timer.current), []);

  const commit = () => {
    focused.current = false;
    if (draft === value) return;
    setState({ kind: "saving" });
    onCommit(draft).then(
      () => {
        setState({ kind: "saved" });
        clearTimeout(timer.current);
        timer.current = setTimeout(() => setState({ kind: "idle" }), 2200);
      },
      (err: unknown) => setState({ kind: "error", message: err instanceof Error ? err.message : String(err) }),
    );
  };
  return {
    draft,
    setDraft,
    state,
    bind: {
      onFocus: () => {
        focused.current = true;
      },
      onBlur: commit,
    },
  };
}

function SaveBadge({ state }: { state: SaveState }) {
  // Fixed-width slot so the label row never shifts when the badge appears.
  return (
    <span className="ml-auto flex h-4 min-w-[4.5rem] items-center justify-end text-[11px]" aria-live="polite">
      {state.kind === "saving" ? (
        <span className="flex items-center gap-1 text-fd-muted-foreground">
          <Spinner className="size-3" /> Saving…
        </span>
      ) : state.kind === "saved" ? (
        <span className="studio-fade-in flex items-center gap-1 text-emerald-600 dark:text-emerald-400">
          <Icon name="check" className="size-3" /> Saved
        </span>
      ) : state.kind === "error" ? (
        <span className="flex items-center gap-1 text-red-600 dark:text-red-400" title={state.message}>
          <Icon name="alert" className="size-3" /> Not saved
        </span>
      ) : null}
    </span>
  );
}

function TextField({
  label,
  hint,
  value,
  rows,
  className,
  extra,
  onCommit,
}: {
  label: string;
  hint: string;
  value: string;
  rows: number;
  className?: string;
  extra?: (draft: string) => ReactNode;
  onCommit: (value: string) => Promise<unknown>;
}) {
  const { draft, setDraft, state, bind } = useCommitField(value, onCommit);
  return (
    <label className={cn("flex min-w-0 flex-col gap-1", className)}>
      <span className="flex min-w-0 items-baseline gap-1.5">
        <span className="shrink-0 text-xs font-semibold">{label}</span>
        <span className="min-w-0 truncate text-[11px] text-fd-muted-foreground">{hint}</span>
        <SaveBadge state={state} />
      </span>
      <textarea
        rows={rows}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        {...bind}
        className={cn("studio-input studio-autogrow min-h-[3.75rem] w-full resize-y px-2.5 py-2 text-[13px] leading-relaxed", state.kind === "error" && "border-red-500/70")}
      />
      {extra ? extra(draft) : null}
    </label>
  );
}

function CaptionHint({ text }: { text: string }) {
  if (!text.trim()) return null;
  const { cues } = captionCues(text);
  const long = cues > 1;
  return (
    <span
      className={cn("flex items-start gap-1 text-[11px] leading-snug", long ? "text-amber-700 dark:text-amber-400" : "text-fd-muted-foreground")}
      title="Video captions wrap at 42 characters a line, 2 lines a screen"
    >
      {long ? <Icon name="info" className="mt-px size-3 shrink-0" /> : null}
      <span>
        {text.length} characters · {long ? `${cues} caption screens (about 80 characters fit on one)` : "fits one caption screen"}
      </span>
    </span>
  );
}

function TitleField({ value, placeholder, onCommit }: { value: string; placeholder: string; onCommit: (v: string) => Promise<unknown> }) {
  const { draft, setDraft, state, bind } = useCommitField(value, onCommit);
  return (
    <div className="flex items-center gap-2">
      <input
        aria-label="Step title"
        value={draft}
        placeholder={placeholder}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
        }}
        {...bind}
        className={cn(
          "studio-focus -ml-1.5 min-w-0 flex-1 truncate rounded-md border border-transparent bg-transparent px-1.5 py-0.5 text-[15px] font-semibold hover:border-fd-border focus:border-fd-border",
          state.kind === "error" && "border-red-500/70",
        )}
      />
      {state.kind !== "idle" ? <SaveBadge state={state} /> : null}
    </div>
  );
}

function HoldField({ value, onCommit }: { value?: number; onCommit: (v: number) => Promise<unknown> }) {
  const { draft, setDraft, state, bind } = useCommitField(value === undefined ? "" : String(value), (v) => onCommit(Number(v)));
  return (
    <label
      className={cn(
        "flex shrink-0 items-center gap-1 rounded-lg border studio-surface px-2 py-1 text-[11px] text-fd-muted-foreground focus-within:border-fd-primary/60",
        state.kind === "error" ? "border-red-500/70" : "border-fd-border",
      )}
      title={state.kind === "error" ? state.message : "Extra seconds the video lingers on this step"}
    >
      {state.kind === "saving" ? <Spinner className="size-3" /> : state.kind === "saved" ? <Icon name="check" className="size-3 text-emerald-600" /> : <Icon name="clock" className="size-3" />}
      <span>Hold</span>
      <input
        type="number"
        step="0.1"
        min="0"
        inputMode="decimal"
        value={draft}
        placeholder="0"
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
        }}
        {...bind}
        onBlur={() => {
          if (draft === "") {
            setDraft(value === undefined ? "" : String(value));
            return;
          }
          bind.onBlur();
        }}
        className="w-9 bg-transparent text-right font-medium tabular-nums text-fd-foreground outline-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none"
      />
      <span>s</span>
    </label>
  );
}

function StepThumb({
  walkthroughId,
  stepNumber,
  hasImage,
  studioToken,
  selected,
}: {
  walkthroughId: string;
  stepNumber: number;
  hasImage: boolean;
  studioToken: string;
  selected: boolean;
}) {
  const blob = useStudioBlob(hasImage ? screenshotUrl(walkthroughId, stepNumber) : undefined, studioToken);
  return (
    <div
      className={cn(
        "relative aspect-video w-full self-start overflow-hidden rounded-lg border bg-fd-muted",
        selected ? "border-fd-primary/40" : "border-fd-border",
      )}
    >
      {blob.status === "ready" ? (
        // eslint-disable-next-line @next/next/no-img-element -- dev-only Studio, blob URL from our own fetch
        <img src={blob.src} alt={`Step ${stepNumber} screenshot`} className="absolute inset-0 size-full object-cover object-top" draggable={false} />
      ) : blob.status === "loading" ? (
        <div className="studio-skeleton absolute inset-0 rounded-none" />
      ) : (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-1 p-2 text-center text-[11px] text-fd-muted-foreground">
          <Icon name="image" className="size-4" />
          Not captured yet
        </div>
      )}
      {!selected && blob.status === "ready" ? (
        <span className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/60 to-transparent px-2 pb-1 pt-4 text-[10px] font-medium text-white opacity-0 transition-opacity group-hover/card:opacity-100">
          Select to add callouts or blur
        </span>
      ) : null}
    </div>
  );
}
