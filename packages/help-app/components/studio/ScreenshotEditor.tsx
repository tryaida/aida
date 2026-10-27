"use client";
import { useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { cn } from "@/lib/cn";
import { screenshotUrl, STUDIO_TOKEN_HEADER, useStudioBlob } from "./api";
import { Icon, Spinner } from "./icons";
import type { StudioBlur, StudioBox, StudioCallout, StudioManifestStep, StudioStep, StudioTarget } from "./types";
import { aidaCli } from "./aida-cli";

type Mode = "callout" | "blur";

interface Draft {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** The target each of a step's manifest-recorded `highlights` boxes came from, in the same order
 * `runner.ts` emits `highlight` events (and so builds `ManifestStep.doc.highlights`): one per
 * action whose `highlight` is truthy, in action order. `highlight: true` means "the action's own
 * target"; a `Target` object means "highlight a different element" — mirrors capture/runner.ts's
 * `highlightBox(page, a.highlight, a.target)`. Returns `undefined` at an index whose action has
 * no usable target (shouldn't happen if the manifest and walkthrough agree, but a mismatch — the
 * walkthrough edited since the last capture — must degrade to "pin by box", never throw). */
function highlightTargetsOf(step: StudioStep): (StudioTarget | undefined)[] {
  return (step.actions ?? [])
    .filter((a) => Boolean(a.highlight))
    .map((a) => (a.highlight === true ? a.target : (a.highlight as StudioTarget | undefined)));
}

interface DraftPin {
  box: StudioBox;
  /** Set when the drag was really a click that snapped onto a manifest highlight box whose
   * target we could resolve — writing `target:` instead of `box:` so the callout/blur follows
   * the element when the layout moves, same as M22's capture-side `target:` pinning. */
  target?: StudioTarget;
}

/** Converts a drag's two viewport-px corners into a pin: snapping to the nearest highlight box
 * (M22's "pin to the element under the pointer") when the drag is really a click (near-zero
 * area) that landed inside one — with its target, when `highlightTargetsOf` could resolve one —
 * otherwise the drawn box itself, clamped to a sane minimum size. */
function draftToPin(d: Draft, highlights: StudioBox[], highlightTargets: (StudioTarget | undefined)[]): DraftPin {
  const x = Math.min(d.x0, d.x1);
  const y = Math.min(d.y0, d.y1);
  const w = Math.abs(d.x1 - d.x0);
  const h = Math.abs(d.y1 - d.y0);
  if (w < 6 && h < 6) {
    const idx = highlights.findIndex((b) => d.x0 >= b.x && d.x0 <= b.x + b.w && d.y0 >= b.y && d.y0 <= b.y + b.h);
    if (idx !== -1) {
      const target = highlightTargets[idx];
      return target ? { box: highlights[idx], target } : { box: highlights[idx] };
    }
    return { box: { x: Math.round(x - 16), y: Math.round(y - 16), w: 32, h: 32 } };
  }
  return { box: { x: Math.round(x), y: Math.round(y), w: Math.round(Math.max(w, 4)), h: Math.round(Math.max(h, 4)) } };
}

export function ScreenshotEditor({
  walkthroughId,
  step,
  stepNumber,
  manifestStep,
  viewport,
  studioToken,
  onChanged,
  onError,
}: {
  walkthroughId: string;
  step: StudioStep;
  stepNumber: number;
  manifestStep?: StudioManifestStep;
  viewport?: { width: number; height: number };
  studioToken: string;
  onChanged: () => void;
  /** Where save errors go (the Studio's toasts); falls back to an inline message. */
  onError?: (message: string) => void;
}) {
  const [mode, setMode] = useState<Mode>("callout");
  const [draft, setDraft] = useState<Draft | null>(null);
  const [inlineError, setInlineError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const hasImage = Boolean(manifestStep?.image);

  // A plain <img src="..."> can't carry the Studio token header assertStudioRequest requires
  // (security.ts), so the screenshot is fetched with it and handed to <img> as a blob URL.
  const image = useStudioBlob(hasImage ? screenshotUrl(walkthroughId, stepNumber) : undefined, studioToken);

  const setError = (message: string | undefined) => {
    if (message && onError) onError(message);
    else setInlineError(message);
  };

  if (!manifestStep?.image || !viewport) {
    return (
      <div className="flex items-start gap-3 rounded-lg border border-dashed border-fd-border bg-fd-muted/40 p-3 text-xs text-fd-muted-foreground">
        <Icon name="image" className="mt-0.5 size-4 shrink-0" />
        <p>
          No captured screenshot for this step yet. Run <code className="studio-code">{aidaCli("capture")}</code> from your aida checkout and you can add numbered
          callouts and blur boxes here.
        </p>
      </div>
    );
  }

  const vp = viewport;
  const callouts = step.callouts ?? [];
  const blurBoxes = step.blur ?? [];
  const highlightTargets = highlightTargetsOf(step);
  const resolvedCallouts = new Map((manifestStep.callouts ?? []).map((c) => [c.id, c.box]));
  const resolvedBlur = new Map((manifestStep.blur ?? []).map((b) => [b.id, b.box]));

  const toFraction = (b: StudioBox) => ({
    left: `${(b.x / viewport.width) * 100}%`,
    top: `${(b.y / viewport.height) * 100}%`,
    width: `${(b.w / viewport.width) * 100}%`,
    height: `${(b.h / viewport.height) * 100}%`,
  });

  function post<T>(body: unknown): Promise<T> {
    setBusy(true);
    return fetch("/studio/api/edit", {
      method: "POST",
      headers: { "content-type": "application/json", [STUDIO_TOKEN_HEADER]: studioToken },
      body: JSON.stringify(body),
    }).then(async (res) => {
      const data = (await res.json()) as T & { ok?: boolean; error?: string };
      if (!res.ok || data.ok === false) throw new Error(data.error ?? `${res.status}`);
      return data;
    }).finally(() => setBusy(false));
  }

  function pointerToViewportPx(e: ReactPointerEvent<HTMLDivElement>): { x: number; y: number } {
    const rect = wrapRef.current!.getBoundingClientRect();
    const fx = (e.clientX - rect.left) / rect.width;
    const fy = (e.clientY - rect.top) / rect.height;
    return { x: fx * vp.width, y: fy * vp.height };
  }

  function onPointerDown(e: ReactPointerEvent<HTMLDivElement>) {
    const p = pointerToViewportPx(e);
    setDraft({ x0: p.x, y0: p.y, x1: p.x, y1: p.y });
  }
  function onPointerMove(e: ReactPointerEvent<HTMLDivElement>) {
    if (!draft) return;
    const p = pointerToViewportPx(e);
    setDraft({ ...draft, x1: p.x, y1: p.y });
  }
  function onPointerUp() {
    if (!draft) return;
    const pin = draftToPin(draft, manifestStep!.highlights, highlightTargets);
    setDraft(null);
    setError(undefined);
    const id = `${mode}-${Date.now().toString(36)}`;
    const action = mode === "callout" ? "addCallout" : "addBlur";
    const pinFields = pin.target ? { target: pin.target } : { box: pin.box };
    const payload =
      mode === "callout"
        ? { action, walkthroughId, stepId: step.id, callout: { id, ...pinFields } satisfies StudioCallout }
        : { action, walkthroughId, stepId: step.id, blur: { id, ...pinFields } satisfies StudioBlur };
    post(payload).then(onChanged).catch((err: Error) => setError(err.message));
  }

  function removeItem(kind: Mode, itemId: string) {
    const action = kind === "callout" ? "removeCallout" : "removeBlur";
    post({ action, walkthroughId, stepId: step.id, itemId }).then(onChanged).catch((err: Error) => setError(err.message));
  }

  function setLabel(itemId: string, label: string) {
    post({ action: "updateCallout", walkthroughId, stepId: step.id, itemId, patch: { label } })
      .then(onChanged)
      .catch((err: Error) => setError(err.message));
  }

  function move(itemId: string, dir: -1 | 1) {
    const ids = callouts.map((c) => c.id);
    const i = ids.indexOf(itemId);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= ids.length) return;
    const newOrder = [...ids];
    [newOrder[i], newOrder[j]] = [newOrder[j], newOrder[i]];
    post({ action: "reorderCallouts", walkthroughId, stepId: step.id, newOrder }).then(onChanged).catch((err: Error) => setError(err.message));
  }

  const draftPin = draft ? draftToPin(draft, manifestStep.highlights, highlightTargets) : null;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <h3 className="text-xs font-semibold">Screenshot</h3>
        <div role="radiogroup" aria-label="What a click adds" className="flex rounded-lg bg-fd-muted p-0.5 text-xs">
          {(
            [
              ["callout", "Numbered callout"],
              ["blur", "Blur box"],
            ] as const
          ).map(([m, label]) => (
            <button
              key={m}
              type="button"
              role="radio"
              aria-checked={mode === m}
              onClick={() => setMode(m)}
              className={cn(
                "studio-focus flex items-center gap-1.5 rounded-md px-2.5 py-1 font-medium transition-colors",
                mode === m ? "studio-surface text-fd-foreground shadow-sm" : "text-fd-muted-foreground hover:text-fd-foreground",
              )}
            >
              <span className={cn("size-2.5 rounded-full", m === "callout" ? "bg-red-600" : "bg-slate-500")} aria-hidden />
              {label}
            </button>
          ))}
        </div>
        <span className="text-[11px] text-fd-muted-foreground">
          Click a highlighted element to pin to it, or drag to draw a box.
        </span>
        {busy ? <Spinner className="ml-auto size-3.5 text-fd-muted-foreground" /> : null}
      </div>

      <div
        ref={wrapRef}
        className="relative w-full cursor-crosshair touch-none select-none overflow-hidden rounded-lg border border-fd-border bg-fd-muted shadow-sm"
        style={{ aspectRatio: `${viewport.width} / ${viewport.height}` }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
      >
        {image.status === "ready" ? (
          // eslint-disable-next-line @next/next/no-img-element -- dev-only Studio, blob URL from our own fetch
          <img src={image.src} alt={`Step ${stepNumber} screenshot`} className="absolute inset-0 h-full w-full" draggable={false} />
        ) : image.status === "loading" ? (
          <div className="studio-skeleton absolute inset-0 rounded-none" />
        ) : null}

        {/* Elements aida already knows the box of — a click inside one pins to it. */}
        {(manifestStep.highlights ?? []).map((b, i) => (
          <div
            key={`hl-${i}`}
            className="pointer-events-none absolute rounded-sm border border-dashed border-sky-500/70 bg-sky-400/5"
            style={toFraction(b)}
            aria-hidden
          />
        ))}

        {blurBoxes.map((b) => {
          // A box-pinned item shows immediately from its own authored box (no capture needed);
          // a target-pinned one only shows once a capture run has resolved it into the manifest.
          const box = resolvedBlur.get(b.id) ?? b.box;
          if (!box) return null;
          return (
            <div
              key={b.id}
              className={cn("group absolute rounded-sm border-2 bg-slate-900/45 backdrop-blur-[3px]", b.target ? "border-amber-400" : "border-slate-400")}
              style={toFraction(box)}
              title={b.target ? "Pinned to an element — follows it when the layout moves" : "Fixed position"}
            >
              <button
                type="button"
                aria-label="Remove blur box"
                onPointerDown={(e) => e.stopPropagation()}
                onClick={() => removeItem("blur", b.id)}
                className="absolute -right-2.5 -top-2.5 hidden size-5 items-center justify-center rounded-full bg-slate-800 text-white shadow group-hover:flex"
              >
                <Icon name="x" className="size-3" />
              </button>
            </div>
          );
        })}

        {callouts.map((c, i) => {
          const box = resolvedCallouts.get(c.id) ?? c.box;
          if (!box) return null;
          return (
            <div
              key={c.id}
              className={cn("group absolute rounded-sm border-2", c.target ? "border-amber-500/80" : "border-red-600/80")}
              style={toFraction(box)}
              title={c.target ? "Pinned to an element — follows it when the layout moves" : "Fixed position"}
            >
              <span
                className={cn(
                  "absolute -left-3 -top-3 flex size-6 items-center justify-center rounded-full text-xs font-bold text-white shadow-md ring-2 ring-white",
                  c.target ? "bg-amber-500" : "bg-red-600",
                )}
              >
                {i + 1}
              </span>
              <button
                type="button"
                aria-label={`Remove callout ${i + 1}`}
                onPointerDown={(e) => e.stopPropagation()}
                onClick={() => removeItem("callout", c.id)}
                className="absolute -right-2.5 -top-2.5 hidden size-5 items-center justify-center rounded-full bg-red-800 text-white shadow group-hover:flex"
              >
                <Icon name="x" className="size-3" />
              </button>
            </div>
          );
        })}

        {draftPin ? (
          <div
            className={cn(
              "pointer-events-none absolute rounded-sm border-2 border-dashed",
              draftPin.target ? "border-amber-400 bg-amber-300/10" : mode === "callout" ? "border-red-500 bg-red-500/10" : "border-slate-400 bg-slate-500/20",
            )}
            style={toFraction(draftPin.box)}
          />
        ) : null}
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-fd-muted-foreground">
        <span className="flex items-center gap-1.5">
          <span className="size-2.5 rounded-sm border border-dashed border-sky-500" /> Known element
        </span>
        <span className="flex items-center gap-1.5">
          <span className="size-2.5 rounded-full bg-amber-500" /> Pinned to an element (follows layout changes)
        </span>
        <span className="flex items-center gap-1.5">
          <span className="size-2.5 rounded-full bg-red-600" /> Fixed position
        </span>
      </div>

      {inlineError ? <p className="text-xs text-red-600 dark:text-red-400">{inlineError}</p> : null}

      {callouts.length > 0 ? (
        <ul className="divide-y divide-fd-border overflow-hidden rounded-lg border border-fd-border text-xs">
          {callouts.map((c, i) => (
            <li key={c.id} className="flex items-center gap-2 studio-surface px-2.5 py-1.5">
              <span
                className={cn(
                  "flex size-5 shrink-0 items-center justify-center rounded-full text-[11px] font-bold text-white",
                  c.target ? "bg-amber-500" : "bg-red-600",
                )}
              >
                {i + 1}
              </span>
              <span className="shrink-0 text-fd-muted-foreground" title={c.target ? "Pinned to an element" : "Fixed position"}>
                <Icon name={c.target ? "pin" : "square"} className="size-3.5" />
              </span>
              <input
                defaultValue={c.label ?? ""}
                placeholder="Label (optional)"
                aria-label={`Callout ${i + 1} label`}
                className="studio-input h-7 min-w-0 flex-1 px-2"
                onKeyDown={(e) => {
                  if (e.key === "Enter") e.currentTarget.blur();
                }}
                onBlur={(e) => {
                  if (e.target.value !== (c.label ?? "")) setLabel(c.id, e.target.value);
                }}
              />
              <div className="flex shrink-0 items-center">
                <IconButton label="Move up" icon="arrowUp" onClick={() => move(c.id, -1)} disabled={i === 0} />
                <IconButton label="Move down" icon="arrowDown" onClick={() => move(c.id, 1)} disabled={i === callouts.length - 1} />
                <IconButton label="Remove callout" icon="trash" onClick={() => removeItem("callout", c.id)} danger />
              </div>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function IconButton({
  label,
  icon,
  onClick,
  disabled,
  danger,
}: {
  label: string;
  icon: "arrowUp" | "arrowDown" | "trash";
  onClick: () => void;
  disabled?: boolean;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "studio-focus flex size-7 items-center justify-center rounded-md text-fd-muted-foreground transition-colors disabled:pointer-events-none disabled:opacity-30",
        danger ? "hover:bg-red-500/10 hover:text-red-600" : "hover:bg-fd-muted hover:text-fd-foreground",
      )}
    >
      <Icon name={icon} className="size-3.5" />
    </button>
  );
}
