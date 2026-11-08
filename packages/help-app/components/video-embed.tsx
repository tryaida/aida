// A guide's narrated video (frontmatter `video`/`vtt`/`srt`/`chapters`/`transcript`/`poster`,
// written by the engine). Captions use the VTT track; chapters come from the render's chapters
// VTT (one per step) and show as a clickable list that follows playback. SRT is offered as a
// download, and the transcript (a Markdown file beside it) as a native disclosure.
"use client";

import { Captions, PlayCircle } from "lucide-react";
import { useEffect, useId, useRef, useState, type SyntheticEvent } from "react";
import { cn } from "@/lib/cn";
import { brand } from "@/lib/brand";
import { useDevice } from "@/lib/device";
import { DeviceSwitch } from "./device-switch";
import { clock, devicesForEmbed, languageLabel, mediaForDevice, parseChaptersVtt, parseTranscriptMarkdown, type VideoChapter } from "./video-embed-parse";

export type { VideoChapter, TranscriptBlock } from "./video-embed-parse";
export { parseChaptersVtt, parseTranscriptMarkdown } from "./video-embed-parse";

/** One device's own media — the primary device's (`src`/`vtt`/…) or the `phone` prop's. */
interface DeviceMedia {
  src: string;
  vtt?: string;
  srt?: string;
  poster?: string;
  chapters?: string | VideoChapter[];
  transcript?: string;
}

export interface VideoEmbedProps extends DeviceMedia {
  /** A secondary phone device's own portrait video (decision 40, M43c) — when given, the embed
   * shows a `<DeviceSwitch>` and plays whichever device the reader has chosen (shared with every
   * other switch on the site, `lib/device.ts`'s `useDevice`). Absent: just the one video, shown
   * portrait itself if it happens to be (e.g. a phone-primary walkthrough) — see `onLoadedMetadata`. */
  phone?: DeviceMedia;
  title?: string;
  /** DOM id for the figure. The page's own "Watch the video" link (`#video`) targets the main
   * guide video, so that call site passes `id="video"`; other embeds on the same page (a path's
   * clip, from MDX) get a unique one automatically so ids never collide. */
  id?: string;
}

export function VideoEmbed({ id, phone, title, ...primary }: VideoEmbedProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const devices = devicesForEmbed(Boolean(phone));
  const [device, setDevice] = useDevice(devices);
  const media = mediaForDevice(device, primary, phone);
  const { src, vtt, srt, poster, chapters, transcript } = media;
  const [list, setList] = useState<VideoChapter[]>(Array.isArray(chapters) ? chapters : []);
  const [current, setCurrent] = useState(-1);
  const [transcriptText, setTranscriptText] = useState<string | undefined>();
  const [transcriptRequested, setTranscriptRequested] = useState(false);
  // No frontmatter carries the video's own pixel size — a phone-primary walkthrough's only video
  // is portrait too (decision 40), so this is learned from the loaded video itself rather than
  // assumed from `phone` being set (the switch case) or unset (a single video, which might still
  // be portrait).
  const [portrait, setPortrait] = useState(false);
  const autoId = useId().replace(/[^a-zA-Z0-9-]/g, "");
  const figureId = id ?? `video-${autoId}`;
  const chaptersVttUrl = typeof chapters === "string" ? chapters : undefined;

  useEffect(() => {
    if (!chaptersVttUrl) return;
    let cancelled = false;
    fetch(chaptersVttUrl)
      .then((r) => (r.ok ? r.text() : ""))
      .then((text) => {
        if (!cancelled) setList(parseChaptersVtt(text));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [chaptersVttUrl]);

  // Switching device swaps `src` on the same <video> element — browsers don't reload a <source>
  // child's new src on their own, and the transcript disclosure (if already opened) must re-fetch
  // the newly-chosen device's own transcript rather than keep showing the old one.
  useEffect(() => {
    videoRef.current?.load();
    setTranscriptText(undefined);
    setTranscriptRequested(false);
  }, [src, transcript]);

  function onLoadedMetadata(e: SyntheticEvent<HTMLVideoElement>) {
    const v = e.currentTarget;
    setPortrait(v.videoHeight > v.videoWidth);
  }

  function onTime() {
    const t = videoRef.current?.currentTime ?? 0;
    let idx = -1;
    list.forEach((c, i) => {
      if (t >= c.seconds) idx = i;
    });
    setCurrent(idx);
  }

  function seek(seconds: number) {
    const v = videoRef.current;
    if (!v) return;
    v.currentTime = seconds;
    // A click to seek is a deliberate user action, not autoplay, so this plays even under
    // `prefers-reduced-motion: reduce` — reduced motion holds off animation/transitions
    // (globals.css), not video playback the reader just asked for.
    void v.play().catch(() => {});
  }

  // Fetched the first time the <details> is opened, not eagerly — most readers never open it.
  function onTranscriptToggle(e: SyntheticEvent<HTMLDetailsElement>) {
    if (!e.currentTarget.open || transcriptRequested || !transcript) return;
    setTranscriptRequested(true);
    fetch(transcript)
      .then((r) => (r.ok ? r.text() : ""))
      .then(setTranscriptText)
      .catch(() => setTranscriptText(""));
  }

  return (
    <figure
      id={figureId}
      className="aida-video not-prose my-6 overflow-hidden rounded-[calc(var(--brand-radius)+4px)] border border-fd-border bg-fd-card shadow-sm print:hidden"
      aria-label={title ? `Video: ${title}` : "Video"}
    >
      {devices.length > 1 ? (
        <div className="flex items-center justify-end border-b border-fd-border px-3 py-2">
          <DeviceSwitch devices={devices} value={device} onChange={setDevice} />
        </div>
      ) : null}
      <div className={cn("grid", list.length > 0 && "lg:grid-cols-[1fr_15rem]")}>
        <video
          ref={videoRef}
          controls
          preload="metadata"
          poster={poster}
          onTimeUpdate={onTime}
          onLoadedMetadata={onLoadedMetadata}
          className={cn(
            "bg-black",
            // Portrait (decision 40, M43c): shown at its own shape, centred, at a sensible max
            // height — never forced into a 16:9 box (which would letterbox or crop it).
            portrait ? "mx-auto h-auto max-h-[70vh] w-auto" : "aspect-video w-full",
          )}
        >
          <source src={src} type="video/mp4" />
          {/* Captions are already burned into the video (decision 39), so the track is offered
           * — for anyone who wants the browser's own caption UI too — but never on by default. */}
          {vtt ? <track kind="captions" src={vtt} srcLang={brand.lang} label={languageLabel(brand.lang)} /> : null}
          {chaptersVttUrl ? <track kind="chapters" src={chaptersVttUrl} srcLang={brand.lang} label="Chapters" /> : null}
        </video>
        {list.length > 0 ? (
          <ol className="max-h-[22rem] overflow-y-auto border-t border-fd-border p-2 text-sm lg:max-h-none lg:border-s lg:border-t-0">
            {list.map((c, i) => (
              <li key={`${c.seconds}-${c.label}`}>
                <button
                  type="button"
                  onClick={() => seek(c.seconds)}
                  aria-current={i === current ? "step" : undefined}
                  className={cn(
                    "flex w-full items-baseline gap-2 rounded-md border-s-2 border-transparent px-2 py-1.5 text-start transition hover:bg-fd-accent motion-reduce:transition-none",
                    // The tint alone (`bg-fd-primary/10`) is too subtle to count as the WCAG
                    // 1.4.11 non-text indicator of "this is the current chapter" — the left
                    // border carries that, in the same contrast-checked colour as the text.
                    i === current && "border-fd-primary-text bg-fd-primary/10 text-fd-primary-text",
                  )}
                >
                  <span className="w-5 shrink-0 text-xs tabular-nums text-fd-muted-foreground">{c.step ?? i + 1}</span>
                  <span className="flex-1 leading-snug">{c.label}</span>
                  <span className="text-xs tabular-nums text-fd-muted-foreground">{clock(c.seconds)}</span>
                </button>
              </li>
            ))}
          </ol>
        ) : null}
      </div>
      <figcaption className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-fd-border px-4 py-2 text-xs text-fd-muted-foreground">
        <span className="inline-flex items-center gap-1.5">
          <PlayCircle className="size-3.5" aria-hidden="true" /> Narrated walkthrough{vtt ? " with captions" : ""}
        </span>
        {srt ? (
          <a href={srt} download className="ms-auto inline-flex items-center gap-1.5 hover:text-fd-primary-text">
            <Captions className="size-3.5" aria-hidden="true" /> Download captions (.srt)
          </a>
        ) : null}
      </figcaption>
      {transcript ? (
        <details className="border-t border-fd-border px-4 py-2 text-sm" onToggle={onTranscriptToggle}>
          <summary className="cursor-pointer font-medium text-fd-foreground">Transcript</summary>
          <div className="mt-2 space-y-2 text-fd-muted-foreground">
            {transcriptText === undefined ? (
              <p className="text-xs">Loading…</p>
            ) : (
              parseTranscriptMarkdown(transcriptText).map((b, i) =>
                b.kind === "heading" ? (
                  <p key={i} className="font-semibold text-fd-foreground">
                    {b.text}
                  </p>
                ) : (
                  <p key={i}>{b.text}</p>
                ),
              )
            )}
          </div>
        </details>
      ) : null}
    </figure>
  );
}
