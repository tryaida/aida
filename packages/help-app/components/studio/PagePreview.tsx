"use client";
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { cn } from "@/lib/cn";
import { useStudioBlob } from "./api";
import { Icon } from "./icons";
import { parsePage, previewImageSource, type Block, type Inline } from "./markdown";
import type { PageData } from "./types";
import { aidaCli } from "./aida-cli";

/**
 * The built help page for the selected walkthrough, rendered the way the help site shows it: the
 * site's own `prose` typography and brand variables, frontmatter and aida's block markers
 * hidden, inline HTML (<strong>, <kbd>) as real elements, and the page's screenshots loaded
 * through the Studio's guarded page-asset route. Each step's section is clickable (selects that
 * step) and the selected step is highlighted and scrolled into view. A Video tab plays the
 * rendered walkthrough video when one exists.
 */
export function PagePreview({
  walkthroughId,
  page,
  loading,
  hasVideo,
  selectedStepId,
  onSelectStep,
  studioToken,
}: {
  walkthroughId?: string;
  page?: PageData;
  loading: boolean;
  hasVideo: boolean;
  selectedStepId?: string;
  onSelectStep: (stepId: string) => void;
  studioToken: string;
}) {
  const [tab, setTab] = useState<"page" | "video">("page");
  const activeTab = hasVideo ? tab : "page";

  return (
    <section className="flex min-h-0 flex-1 flex-col" aria-label="Preview">
      <div className="flex h-11 shrink-0 items-center justify-between gap-2 border-b border-fd-border px-3">
        <h2 className="text-[13px] font-semibold">Preview</h2>
        <div role="tablist" aria-label="Preview type" className="flex rounded-lg bg-fd-muted p-0.5 text-xs">
          {(["page", "video"] as const).map((t) => (
            <button
              key={t}
              type="button"
              role="tab"
              aria-selected={activeTab === t}
              disabled={t === "video" && !hasVideo}
              title={t === "video" && !hasVideo ? "No video rendered yet — run aida build" : undefined}
              onClick={() => setTab(t)}
              className={cn(
                "studio-focus flex items-center gap-1.5 rounded-md px-2.5 py-1 font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-45",
                activeTab === t ? "studio-surface text-fd-foreground shadow-sm" : "text-fd-muted-foreground hover:text-fd-foreground",
              )}
            >
              <Icon name={t === "page" ? "file" : "play"} className="size-3.5" />
              {t === "page" ? "Page" : "Video"}
            </button>
          ))}
        </div>
      </div>
      {activeTab === "video" && walkthroughId ? (
        <VideoPreview walkthroughId={walkthroughId} studioToken={studioToken} />
      ) : (
        <PageBody
          walkthroughId={walkthroughId}
          page={page}
          loading={loading}
          selectedStepId={selectedStepId}
          onSelectStep={onSelectStep}
          studioToken={studioToken}
        />
      )}
    </section>
  );
}

function PageBody({
  walkthroughId,
  page,
  loading,
  selectedStepId,
  onSelectStep,
  studioToken,
}: {
  walkthroughId?: string;
  page?: PageData;
  loading: boolean;
  selectedStepId?: string;
  onSelectStep: (stepId: string) => void;
  studioToken: string;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const parsed = useMemo(() => (page?.found && page.text ? parsePage(page.text) : undefined), [page]);

  // Follow the selected step — except the automatic first-step selection when a walkthrough
  // opens, which would otherwise scroll the page's title out of view.
  const prevStep = useRef<string | undefined>(undefined);
  const autoSelected = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (prevStep.current === undefined && selectedStepId !== undefined) autoSelected.current = selectedStepId;
    else if (selectedStepId !== prevStep.current) autoSelected.current = undefined;
    prevStep.current = selectedStepId;
    if (!selectedStepId || !scrollRef.current || selectedStepId === autoSelected.current) return;
    const el = scrollRef.current.querySelector<HTMLElement>(`[data-step-id="${CSS.escape(selectedStepId)}"]`);
    if (!el) return;
    const box = scrollRef.current.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    // Keep the step clear of the sticky "built before your edits" banner when it's showing.
    const banner = scrollRef.current.querySelector<HTMLElement>("[data-stale-banner]")?.offsetHeight ?? 0;
    if (r.top < box.top + banner + 8 || r.top > box.bottom - 120) {
      scrollRef.current.scrollTo({ top: scrollRef.current.scrollTop + (r.top - box.top) - banner - 12, behavior: "smooth" });
    }
  }, [selectedStepId, parsed]);

  if (loading) return <PreviewSkeleton />;
  if (!walkthroughId) {
    return (
      <div className="studio-canvas flex flex-1 items-center justify-center p-6 text-center text-xs text-fd-muted-foreground">
        The help page for the walkthrough you pick shows here.
      </div>
    );
  }

  if (!parsed) {
    return (
      <div className="flex flex-1 items-center justify-center p-6">
        <div className="max-w-xs text-center">
          <div className="mx-auto mb-3 flex size-10 items-center justify-center rounded-full bg-fd-muted text-fd-muted-foreground">
            <Icon name="file" className="size-5" />
          </div>
          <p className="text-sm font-medium">No page built yet</p>
          <p className="mt-1 text-xs leading-relaxed text-fd-muted-foreground">
            Run <code className="studio-code">{aidaCli("build")}</code> (or <code className="studio-code">{aidaCli(`pages ${walkthroughId}`)}</code>)
            from your aida checkout and the help page shows here.
          </p>
        </div>
      </div>
    );
  }

  const stale = page?.builtAt !== undefined && page.editedAt !== undefined && page.editedAt > page.builtAt + 1000;
  const fm = parsed.frontmatter;

  return (
    <div ref={scrollRef} className="studio-scroll min-h-0 flex-1 overflow-y-auto studio-canvas">
      {stale ? (
        <div
          data-stale-banner
          className="sticky top-0 z-10 flex items-start gap-2 border-b border-amber-500/30 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:bg-amber-950 dark:text-amber-200"
        >
          <Icon name="info" className="mt-px size-3.5 shrink-0" />
          <span>
            This page was built before your latest edits. They show here after the next{" "}
            <code className="studio-code">aida build</code>.
          </span>
        </div>
      ) : null}
      <div className="m-3 overflow-hidden rounded-xl border border-fd-border studio-surface shadow-sm">
        <article className="px-6 pb-8 pt-6">
          {fm.lastChecked || fm.passed ? (
            <div className="mb-4 flex flex-wrap items-center gap-2">
              <span
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[11px]",
                  fm.passed === "true"
                    ? "border-emerald-500/40 text-emerald-700 dark:text-emerald-400"
                    : "border-amber-500/40 text-amber-700 dark:text-amber-400",
                )}
              >
                {fm.passed === "true" ? "Last checked" : "Not fully verified"} · {fm.lastChecked ? fm.lastChecked.slice(0, 10) : "not yet checked"}
              </span>
            </div>
          ) : null}
          <div className="prose max-w-none studio-prose">
            {parsed.sections.map((section, i) => {
              const stepId = section.key?.startsWith("step-") ? section.key.slice(5) : undefined;
              const content = section.blocks.map((b, j) => (
                <BlockView key={j} block={b} walkthroughId={walkthroughId} studioToken={studioToken} />
              ));
              if (!stepId) return <Fragment key={i}>{content}</Fragment>;
              const selected = stepId === selectedStepId;
              return (
                <div
                  key={i}
                  data-step-id={stepId}
                  onClick={() => onSelectStep(stepId)}
                  className={cn(
                    "studio-preview-step -mx-3 cursor-pointer rounded-lg px-3 py-px transition-colors",
                    selected ? "bg-fd-primary/[0.07] ring-1 ring-fd-primary/40" : "hover:bg-fd-muted/60",
                  )}
                >
                  {content}
                </div>
              );
            })}
          </div>
        </article>
      </div>
    </div>
  );
}

function BlockView({ block, walkthroughId, studioToken }: { block: Block; walkthroughId: string; studioToken: string }): ReactNode {
  const inl = (nodes: Inline[]) => <InlineView nodes={nodes} walkthroughId={walkthroughId} studioToken={studioToken} />;
  switch (block.type) {
    case "heading": {
      const H = `h${block.level}` as "h1";
      return <H>{inl(block.children)}</H>;
    }
    case "paragraph":
      return <p>{inl(block.children)}</p>;
    case "image":
      return (
        <figure className="my-4">
          <PreviewImage src={block.src} alt={block.alt} walkthroughId={walkthroughId} studioToken={studioToken} />
        </figure>
      );
    case "list": {
      const items = block.items.map((item, i) => (
        <li key={i}>
          {item.length === 1 && item[0].type === "paragraph"
            ? inl(item[0].children)
            : item.map((b, j) => <BlockView key={j} block={b} walkthroughId={walkthroughId} studioToken={studioToken} />)}
        </li>
      ));
      return block.ordered ? <ol start={block.start}>{items}</ol> : <ul>{items}</ul>;
    }
    case "quote":
      return (
        <blockquote>
          {block.children.map((b, i) => (
            <BlockView key={i} block={b} walkthroughId={walkthroughId} studioToken={studioToken} />
          ))}
        </blockquote>
      );
    case "code":
      return (
        <pre>
          <code>{block.text}</code>
        </pre>
      );
    case "table":
      return (
        <table>
          <thead>
            <tr>
              {block.head.map((c, i) => (
                <th key={i}>{inl(c)}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {block.rows.map((row, i) => (
              <tr key={i}>
                {row.map((c, j) => (
                  <td key={j}>{inl(c)}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      );
    case "hr":
      return <hr />;
    case "component":
      return (
        <div className="not-prose my-3 flex items-center gap-2 rounded-lg border border-dashed border-fd-border px-3 py-2 text-xs text-fd-muted-foreground">
          <Icon name="puzzle" className="size-3.5" />
          <span>
            <code className="studio-code">&lt;{block.name} /&gt;</code> shows on the help site
          </span>
        </div>
      );
  }
}

function InlineView({ nodes, walkthroughId, studioToken }: { nodes: Inline[]; walkthroughId: string; studioToken: string }) {
  return (
    <>
      {nodes.map((n, i) => {
        const kids = "children" in n ? <InlineView nodes={n.children} walkthroughId={walkthroughId} studioToken={studioToken} /> : null;
        switch (n.type) {
          case "text":
            return <Fragment key={i}>{n.text}</Fragment>;
          case "code":
            return <code key={i}>{n.text}</code>;
          case "br":
            return <br key={i} />;
          case "image":
            return <PreviewImage key={i} src={n.src} alt={n.alt} walkthroughId={walkthroughId} studioToken={studioToken} inline />;
          case "link":
            return (
              <a key={i} href={n.href} target="_blank" rel="noreferrer noopener" onClick={(e) => e.stopPropagation()}>
                {kids}
              </a>
            );
          case "kbd":
            return (
              <kbd key={i} className="studio-kbd">
                {kids}
              </kbd>
            );
          default: {
            const Tag = n.type;
            return <Tag key={i}>{kids}</Tag>;
          }
        }
      })}
    </>
  );
}

function PreviewImage({
  src,
  alt,
  walkthroughId,
  studioToken,
  inline,
}: {
  src: string;
  alt: string;
  walkthroughId: string;
  studioToken: string;
  inline?: boolean;
}) {
  const source = previewImageSource(walkthroughId, src);
  const blob = useStudioBlob(source?.kind === "guarded" ? source.url : undefined, studioToken);
  const resolved = source?.kind === "direct" ? source.url : blob.status === "ready" ? blob.src : undefined;

  if (!resolved) {
    const missing = !source || blob.status === "missing";
    return (
      <span
        className={cn(
          "not-prose flex aspect-[16/9] w-full items-center justify-center rounded-lg border border-fd-border bg-fd-muted text-xs text-fd-muted-foreground",
          !missing && "animate-pulse",
          inline && "inline-flex w-48",
        )}
      >
        {missing ? `Image not found: ${src}` : null}
      </span>
    );
  }
  // eslint-disable-next-line @next/next/no-img-element -- dev-only Studio; blob/same-site URL
  return <img src={resolved} alt={alt} className={cn("rounded-lg border border-fd-border", inline ? "inline h-auto max-w-full" : "w-full")} />;
}

function VideoPreview({ walkthroughId, studioToken }: { walkthroughId: string; studioToken: string }) {
  const id = encodeURIComponent(walkthroughId);
  const video = useStudioBlob(`/studio/api/video?id=${id}&kind=mp4`, studioToken);
  const vtt = useStudioBlob(`/studio/api/video?id=${id}&kind=vtt`, studioToken);
  return (
    <div className="studio-scroll min-h-0 flex-1 overflow-y-auto studio-canvas p-3">
      <div className="overflow-hidden rounded-xl border border-fd-border bg-black shadow-sm">
        {video.status === "ready" ? (
          <video controls preload="metadata" className="aspect-video w-full" key={video.src}>
            <source src={video.src} type="video/mp4" />
            {vtt.status === "ready" ? <track kind="captions" src={vtt.src} srcLang="en" label="Captions" default /> : null}
          </video>
        ) : (
          <div className={cn("flex aspect-video items-center justify-center text-xs text-white/60", video.status === "loading" && "animate-pulse")}>
            {video.status === "missing" ? "No rendered video for this walkthrough yet." : "Loading video…"}
          </div>
        )}
      </div>
      <p className="mt-2 px-1 text-xs leading-relaxed text-fd-muted-foreground">
        The last rendered video. Narration, caption and hold edits show after the next <code className="studio-code">aida build</code>.
      </p>
    </div>
  );
}

function PreviewSkeleton() {
  return (
    <div className="flex-1 studio-canvas p-3">
      <div className="space-y-3 rounded-xl border border-fd-border studio-surface p-6">
        <div className="studio-skeleton h-6 w-3/4" />
        <div className="studio-skeleton h-3 w-full" />
        <div className="studio-skeleton h-3 w-5/6" />
        <div className="studio-skeleton mt-6 h-4 w-1/3" />
        <div className="studio-skeleton aspect-video w-full" />
        <div className="studio-skeleton h-3 w-2/3" />
      </div>
    </div>
  );
}
