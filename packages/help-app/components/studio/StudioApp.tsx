"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { getJson, postJson } from "./api";
import { HistoryPanel } from "./HistoryPanel";
import { ProofPanel } from "./ProofPanel";
import { Icon } from "./icons";
import { PagePreview } from "./PagePreview";
import { ScreenshotEditor } from "./ScreenshotEditor";
import { StepEditor, type StepField } from "./StepEditor";
import { StepTimeline } from "./StepTimeline";
import { StudioHeader } from "./StudioHeader";
import { ToastStack, useToasts } from "./Toasts";
import { WalkthroughList } from "./WalkthroughList";
import type { HistoryEntry, PageData, WalkthroughDetail, WalkthroughSummary } from "./types";

const PREVIEW_WIDTH_KEY = "aida-studio-preview-width";
const HISTORY_POLL_MS = 8000;

/**
 * The Studio shell: top bar, walkthrough library (left), the selected walkthrough's step strip
 * and step cards (middle), and the page/video preview with edit history (right, resizable).
 * Every pane scrolls on its own; nothing here owns logic beyond fetching and wiring — edits go
 * to /studio/api/edit, which calls the engine's shared edit actions.
 */
export function StudioApp({ studioToken }: { studioToken: string }) {
  const { toasts, push: pushToast, dismiss } = useToasts();
  const [walkthroughs, setWalkthroughs] = useState<WalkthroughSummary[]>([]);
  const [listLoading, setListLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<string>();
  const [detail, setDetail] = useState<WalkthroughDetail>();
  const [selectedStepId, setSelectedStepId] = useState<string>();
  const [history, setHistory] = useState<HistoryEntry[]>();
  const [undoing, setUndoing] = useState(false);
  const [page, setPage] = useState<PageData>();
  const [pageLoading, setPageLoading] = useState(false);
  const [previewWidth, setPreviewWidth] = useState<number>();
  const [proofOpen, setProofOpen] = useState(false);
  const closeProof = useCallback(() => setProofOpen(false), []);
  const cardRefs = useRef(new Map<string, HTMLElement>());
  // Selection made by clicking/typing in a card shouldn't scroll the list under the pointer;
  // selection from the strip, the preview, history or the keyboard should.
  const scrollToStep = useRef(false);
  const latestHistoryAt = useRef<string | undefined>(undefined);

  const showError = useCallback((title: string, err: unknown) => {
    pushToast({ kind: "error", title, message: err instanceof Error ? err.message : String(err) });
  }, [pushToast]);

  const loadDetail = useCallback(
    (id: string, opts: { quiet?: boolean } = {}) => {
      return getJson<WalkthroughDetail>(`/studio/api/walkthrough?id=${encodeURIComponent(id)}`, studioToken)
        .then((d) => {
          setDetail((prev) => (prev?.walkthrough.walkthrough === id || !opts.quiet ? d : prev));
        })
        .catch((e) => showError("Couldn't load the walkthrough", e));
    },
    [studioToken, showError],
  );

  const loadPage = useCallback(
    (id: string) => {
      setPageLoading(true);
      getJson<PageData>(`/studio/api/page?id=${encodeURIComponent(id)}`, studioToken)
        .then(setPage)
        .catch(() => setPage({ found: false }))
        .finally(() => setPageLoading(false));
    },
    [studioToken],
  );

  const refreshHistory = useCallback(() => {
    return getJson<{ entries: HistoryEntry[] }>("/studio/api/history", studioToken).then((d) => {
      setHistory(d.entries);
      const top = d.entries[0]?.at;
      const changed = latestHistoryAt.current !== undefined && top !== latestHistoryAt.current;
      latestHistoryAt.current = top;
      return { changed, top: d.entries[0] };
    });
  }, [studioToken]);

  // First load: the library and history.
  // Hides the page's "hasn't started" notice (app/studio/page.tsx): the Studio's scripts loaded.
  useEffect(() => {
    document.documentElement.dataset.studioReady = "1";
    return () => {
      delete document.documentElement.dataset.studioReady;
    };
  }, []);

  useEffect(() => {
    getJson<{ walkthroughs: WalkthroughSummary[] }>("/studio/api/walkthroughs", studioToken)
      .then((d) => {
        setWalkthroughs(d.walkthroughs);
        const fromHash = typeof window !== "undefined" ? decodeURIComponent(window.location.hash.slice(1)) : "";
        const initial = d.walkthroughs.find((w) => w.id === fromHash) ?? d.walkthroughs[0];
        if (initial) setSelectedId(initial.id);
      })
      .catch((e) => showError("Couldn't list walkthroughs", e))
      .finally(() => setListLoading(false));
    refreshHistory().catch((e) => showError("Couldn't load history", e));
    const saved = Number(window.localStorage.getItem(PREVIEW_WIDTH_KEY));
    if (saved > 0) setPreviewWidth(saved);
  }, [studioToken, refreshHistory, showError]);

  useEffect(() => {
    if (!selectedId) return;
    setSelectedStepId(undefined);
    setPage(undefined);
    void loadDetail(selectedId);
    loadPage(selectedId);
    if (window.location.hash.slice(1) !== selectedId) window.history.replaceState(null, "", `#${selectedId}`);
  }, [selectedId, loadDetail, loadPage]);

  // An agent editing the same files (scope.md "Editing": all three ways change the same files)
  // shows up without a reload: poll history, and refresh the open walkthrough when it moves.
  useEffect(() => {
    const t = setInterval(() => {
      if (document.visibilityState !== "visible") return;
      refreshHistory()
        .then(({ changed, top }) => {
          if (changed && top?.by === "agent" && selectedId) {
            void loadDetail(selectedId, { quiet: true });
            pushToast({ kind: "info", title: "An agent just edited a walkthrough", message: "The Studio picked up the change." });
          }
        })
        .catch(() => {
          /* transient — the next tick retries */
        });
    }, HISTORY_POLL_MS);
    return () => clearInterval(t);
  }, [refreshHistory, loadDetail, selectedId, pushToast]);

  const steps = useMemo(() => detail?.walkthrough.steps ?? [], [detail]);

  // Open on the first step, so the screenshot editor is there without an extra click.
  useEffect(() => {
    if (detail?.walkthrough.walkthrough !== selectedId || selectedStepId) return;
    const first = detail?.walkthrough.steps.find((s) => s.id)?.id;
    if (first) setSelectedStepId(first);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only when a walkthrough (re)loads
  }, [detail, selectedId]);

  const selectStep = useCallback(
    (stepId: string | undefined, opts: { scroll?: boolean } = {}) => {
      if (stepId === selectedStepId) return;
      scrollToStep.current = Boolean(opts.scroll);
      setSelectedStepId(stepId);
      if (!selectedId) return;
      void postJson("/studio/api/selection", { walkthroughId: selectedId, stepId }, studioToken).catch(() => {
        /* best-effort — a failed selection write shouldn't block editing */
      });
    },
    [selectedId, selectedStepId, studioToken],
  );

  useEffect(() => {
    if (!selectedStepId || !scrollToStep.current) return;
    scrollToStep.current = false;
    cardRefs.current.get(selectedStepId)?.scrollIntoView({ block: "start", behavior: "smooth" });
  }, [selectedStepId]);

  // ↑/↓ (or k/j) move between steps when the focus isn't in a text field.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const el = e.target as HTMLElement | null;
      if (el && (el.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName))) return;
      const dir = e.key === "ArrowDown" || e.key === "j" ? 1 : e.key === "ArrowUp" || e.key === "k" ? -1 : 0;
      if (!dir || steps.length === 0) return;
      e.preventDefault();
      const i = steps.findIndex((s) => s.id === selectedStepId);
      const next = steps[Math.min(steps.length - 1, Math.max(0, i === -1 ? 0 : i + dir))];
      if (next?.id) selectStep(next.id, { scroll: true });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [steps, selectedStepId, selectStep]);

  // After an edit, only the page's "built before your edits" flag can change — re-read quietly.
  const refreshPageMeta = useCallback(
    (id: string) =>
      getJson<PageData>(`/studio/api/page?id=${encodeURIComponent(id)}`, studioToken)
        .then((p) => setPage(p))
        .catch(() => undefined),
    [studioToken],
  );

  const saveField = useCallback(
    (stepId: string, field: StepField, value: string | number) => {
      if (!selectedId) return Promise.resolve();
      if (field === "hold" && (typeof value !== "number" || !Number.isFinite(value) || value < 0)) {
        const err = new Error("Hold is how many extra seconds the video stays on this step — use 0 or more.");
        showError("Couldn't save the hold time", err);
        return Promise.reject(err);
      }
      return postJson("/studio/api/edit", { action: "setStepField", walkthroughId: selectedId, stepId, field, value }, studioToken)
        .then(() => Promise.all([loadDetail(selectedId, { quiet: true }), refreshHistory(), refreshPageMeta(selectedId)]))
        .catch((e) => {
          showError("Couldn't save that change", e);
          throw e;
        });
    },
    [selectedId, studioToken, loadDetail, refreshHistory, refreshPageMeta, showError],
  );

  const undo = useCallback(
    (by?: "agent" | "person") => {
      setUndoing(true);
      postJson<{ undone?: HistoryEntry }>("/studio/api/history", { by }, studioToken)
        .then(() => {
          pushToast({ kind: "success", title: by === "agent" ? "Undid the agent's last edit" : "Undid the last edit" });
          void refreshHistory();
          if (selectedId) void loadDetail(selectedId, { quiet: true });
        })
        .catch((e) => showError("Couldn't undo", e))
        .finally(() => setUndoing(false));
    },
    [refreshHistory, loadDetail, selectedId, studioToken, pushToast, showError],
  );

  const titles = useMemo(() => Object.fromEntries(walkthroughs.map((w) => [w.id, w.title])), [walkthroughs]);
  const summary = walkthroughs.find((w) => w.id === selectedId);
  const wt = detail?.walkthrough.walkthrough === selectedId ? detail : undefined;
  const showSkeleton = listLoading || (Boolean(selectedId) && !wt);

  // Preview pane resize: drag the divider; width persists per browser.
  const onResizeStart = (e: ReactPointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = (e.currentTarget.nextElementSibling as HTMLElement).getBoundingClientRect().width;
    const onMove = (ev: PointerEvent) => {
      const max = Math.min(900, window.innerWidth * 0.55);
      setPreviewWidth(Math.round(Math.min(max, Math.max(320, startW + (startX - ev.clientX)))));
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      document.body.style.removeProperty("cursor");
      setPreviewWidth((w) => {
        if (w) window.localStorage.setItem(PREVIEW_WIDTH_KEY, String(w));
        return w;
      });
    };
    document.body.style.cursor = "col-resize";
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  return (
    <div className="studio-root studio-canvas fixed inset-0 flex flex-col text-fd-foreground">
      <StudioHeader
        title={wt?.walkthrough.title ?? summary?.title}
        status={wt?.status ?? summary?.status}
        lastChecked={wt?.lastChecked ?? summary?.lastChecked}
        siteUrl={wt?.siteUrl}
        loading={listLoading}
        onOpenProof={() => setProofOpen(true)}
      />

      <div className="flex min-h-0 flex-1">
        <aside className="flex w-60 shrink-0 flex-col border-r border-fd-border xl:w-72">
          <WalkthroughList walkthroughs={walkthroughs} loading={listLoading} selectedId={selectedId} onSelect={setSelectedId} />
        </aside>

        <main className="@container flex min-w-0 flex-1 flex-col">
          {showSkeleton ? (
            <MainSkeleton />
          ) : wt ? (
            <>
              <div className="shrink-0 border-b border-fd-border studio-surface">
                <div className="px-5 pb-1 pt-4">
                  <div className="flex items-center gap-2 text-[11px] font-medium uppercase tracking-wide text-fd-muted-foreground">
                    <span>{wt.walkthrough.section ?? summary?.section ?? "How do I…"}</span>
                    <span aria-hidden>·</span>
                    <span className="normal-case tracking-normal">{wt.walkthrough.walkthrough}</span>
                  </div>
                  <h2 className="mt-1 text-xl font-semibold tracking-tight studio-heading">{wt.walkthrough.title}</h2>
                  {wt.walkthrough.summary ? <p className="mt-0.5 max-w-3xl text-[13px] text-fd-muted-foreground">{wt.walkthrough.summary}</p> : null}
                </div>
                <StepTimeline
                  walkthroughId={wt.walkthrough.walkthrough}
                  steps={steps}
                  manifest={wt.manifest}
                  selectedStepId={selectedStepId}
                  onSelect={(id) => selectStep(id, { scroll: true })}
                  studioToken={studioToken}
                />
              </div>
              <div className="studio-scroll min-h-0 flex-1 overflow-y-auto">
                <div className="mx-auto flex max-w-5xl flex-col gap-3 p-5 pb-24">
                  {steps.map((step, i) => (
                    <StepEditor
                      key={step.id ?? i}
                      ref={(el) => {
                        if (!step.id) return;
                        if (el) cardRefs.current.set(step.id, el);
                        else cardRefs.current.delete(step.id);
                      }}
                      walkthroughId={wt.walkthrough.walkthrough}
                      step={step}
                      index={i}
                      selected={step.id !== undefined && step.id === selectedStepId}
                      hasImage={Boolean(wt.manifest?.steps[i]?.image)}
                      studioToken={studioToken}
                      onSelect={() => selectStep(step.id)}
                      onSave={(field, value) => (step.id ? saveField(step.id, field, value) : Promise.reject(new Error("This step has no id, so it can't be edited here.")))}
                    >
                      {step.id && step.id === selectedStepId ? (
                        <ScreenshotEditor
                          walkthroughId={wt.walkthrough.walkthrough}
                          step={step}
                          stepNumber={i + 1}
                          manifestStep={wt.manifest?.steps[i]}
                          viewport={wt.manifest?.viewport}
                          studioToken={studioToken}
                          onChanged={() => {
                            void loadDetail(wt.walkthrough.walkthrough, { quiet: true });
                            void refreshHistory();
                          }}
                          onError={(message) => showError("Couldn't change the screenshot", message)}
                        />
                      ) : null}
                    </StepEditor>
                  ))}
                  {steps.length > 0 ? (
                    <p className="mt-2 flex items-center justify-center gap-1.5 text-[11px] text-fd-muted-foreground">
                      <Icon name="keyboard" className="size-3.5" />
                      Use <kbd className="studio-kbd">↑</kbd> <kbd className="studio-kbd">↓</kbd> to move between steps. Changes save when you leave a field.
                    </p>
                  ) : null}
                </div>
              </div>
            </>
          ) : (
            <NothingSelected hasWalkthroughs={walkthroughs.length > 0} />
          )}
        </main>

        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize preview"
          onPointerDown={onResizeStart}
          onDoubleClick={() => {
            setPreviewWidth(undefined);
            window.localStorage.removeItem(PREVIEW_WIDTH_KEY);
          }}
          className="group relative z-10 w-px shrink-0 cursor-col-resize bg-fd-border"
          title="Drag to resize · double-click to reset"
        >
          <span className="absolute inset-y-0 -left-1.5 -right-1.5 transition-colors group-hover:bg-fd-primary/20" />
        </div>
        <aside
          className="flex w-[clamp(320px,32vw,520px)] shrink-0 flex-col studio-surface"
          style={previewWidth ? { width: previewWidth } : undefined}
        >
          <PagePreview
            walkthroughId={wt?.walkthrough.walkthrough}
            page={page}
            loading={pageLoading || showSkeleton}
            hasVideo={Boolean(wt?.hasVideo)}
            selectedStepId={selectedStepId}
            onSelectStep={(id) => selectStep(id, { scroll: true })}
            studioToken={studioToken}
          />
          <HistoryPanel
            entries={history ?? []}
            loading={history === undefined}
            titles={titles}
            onUndo={undo}
            undoing={undoing}
            onSelectStep={(wtId, stepId) => {
              if (wtId !== selectedId) setSelectedId(wtId);
              else if (stepId) selectStep(stepId, { scroll: true });
            }}
          />
        </aside>
      </div>

      <ProofPanel open={proofOpen} onClose={closeProof} studioToken={studioToken} />
      <ToastStack toasts={toasts} onDismiss={dismiss} />
    </div>
  );
}

function MainSkeleton() {
  return (
    <div className="flex min-h-0 flex-1 flex-col" aria-busy="true">
      <div className="shrink-0 border-b border-fd-border studio-surface px-5 pb-3 pt-4">
        <div className="studio-skeleton h-2.5 w-40" />
        <div className="studio-skeleton mt-2.5 h-5 w-80" />
        <div className="studio-skeleton mt-2 h-3 w-[28rem] max-w-full" />
        <div className="mt-5 flex gap-2">
          {[0, 1, 2, 3, 4, 5].map((i) => (
            <div key={i} className="w-[104px] shrink-0 p-1">
              <div className="studio-skeleton aspect-video" />
              <div className="studio-skeleton mt-1.5 h-2.5 w-3/4" />
            </div>
          ))}
        </div>
      </div>
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-3 p-5">
        {[0, 1].map((i) => (
          <div key={i} className="rounded-xl border border-fd-border studio-surface p-4">
            <div className="flex items-center gap-3">
              <div className="studio-skeleton size-7 rounded-full" />
              <div className="studio-skeleton h-4 w-56" />
            </div>
            <div className="mt-4 grid gap-4 @2xl:grid-cols-[13rem_1fr]">
              <div className="studio-skeleton aspect-video" />
              <div className="space-y-3">
                <div className="studio-skeleton h-14" />
                <div className="studio-skeleton h-14" />
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function NothingSelected({ hasWalkthroughs }: { hasWalkthroughs: boolean }) {
  return (
    <div className="flex flex-1 items-center justify-center p-8">
      <div className="max-w-sm text-center">
        <div className="mx-auto mb-4 flex size-12 items-center justify-center rounded-2xl bg-fd-primary/10 text-fd-primary">
          <Icon name="sparkles" className="size-6" />
        </div>
        <h2 className="text-base font-semibold studio-heading">{hasWalkthroughs ? "Pick a walkthrough" : "Your Studio is ready"}</h2>
        <p className="mt-1.5 text-sm leading-relaxed text-fd-muted-foreground">
          {hasWalkthroughs
            ? "Choose one on the left to edit its steps, narration, captions and screenshots."
            : "Once your agent writes a walkthrough and AIDA builds it, you can edit every word, callout and pause here — and see the help page update."}
        </p>
      </div>
    </div>
  );
}
