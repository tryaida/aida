// A guide's narrated video (frontmatter `video`/`vtt`/`srt`/`chapters`/`poster`, written by the
// engine). Captions use the VTT track; chapters come from the render's chapters VTT (one per
// step) and show as a clickable list that follows playback. SRT is offered as a download.
"use client";

import { Captions, PlayCircle } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/cn";

export interface VideoChapter {
  label: string;
  seconds: number;
}

export interface VideoEmbedProps {
  src: string;
  vtt?: string;
  srt?: string;
  poster?: string;
  /** A WebVTT chapters file, or chapters given directly. */
  chapters?: string | VideoChapter[];
  title?: string;
}

function parseTimestamp(t: string): number {
  const parts = t.trim().split(":").map(Number);
  return parts.reduce((acc, p) => acc * 60 + p, 0);
}

/** Cues from a WebVTT chapters file: `00:00:05.500 --> 00:00:07.850` then the label line. */
export function parseChaptersVtt(text: string): VideoChapter[] {
  const out: VideoChapter[] = [];
  const blocks = text.replace(/\r/g, "").split(/\n{2,}/);
  for (const block of blocks) {
    const lines = block.split("\n");
    const timing = lines.findIndex((l) => l.includes("-->"));
    if (timing < 0) continue;
    const label = lines.slice(timing + 1).join(" ").trim();
    if (!label) continue;
    out.push({ label, seconds: parseTimestamp(lines[timing].split("-->")[0]) });
  }
  return out;
}

function clock(seconds: number): string {
  return `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;
}

export function VideoEmbed({ src, vtt, srt, poster, chapters, title }: VideoEmbedProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [list, setList] = useState<VideoChapter[]>(Array.isArray(chapters) ? chapters : []);
  const [current, setCurrent] = useState(-1);

  useEffect(() => {
    if (typeof chapters !== "string") return;
    let cancelled = false;
    fetch(chapters)
      .then((r) => (r.ok ? r.text() : ""))
      .then((text) => {
        if (!cancelled) setList(parseChaptersVtt(text));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [chapters]);

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
    void v.play().catch(() => {});
  }

  return (
    <figure
      id="video"
      className="aida-video not-prose my-6 overflow-hidden rounded-[calc(var(--brand-radius)+4px)] border border-fd-border bg-fd-card shadow-sm print:hidden"
      aria-label={title ? `Video: ${title}` : "Video"}
    >
      <div className={cn("grid", list.length > 0 && "lg:grid-cols-[1fr_15rem]")}>
        <video
          ref={videoRef}
          controls
          preload="metadata"
          poster={poster}
          onTimeUpdate={onTime}
          className="aspect-video w-full bg-black"
        >
          <source src={src} type="video/mp4" />
          {vtt ? <track kind="captions" src={vtt} srcLang="en" label="English" default /> : null}
        </video>
        {list.length > 0 ? (
          <ol className="max-h-[22rem] overflow-y-auto border-t border-fd-border p-2 text-sm lg:max-h-none lg:border-s lg:border-t-0">
            {list.map((c, i) => (
              <li key={`${c.seconds}-${c.label}`}>
                <button
                  type="button"
                  onClick={() => seek(c.seconds)}
                  className={cn(
                    "flex w-full items-baseline gap-2 rounded-md px-2 py-1.5 text-start transition hover:bg-fd-accent",
                    i === current && "bg-fd-primary/10 text-fd-primary",
                  )}
                >
                  <span className="w-5 shrink-0 text-xs tabular-nums text-fd-muted-foreground">{i + 1}</span>
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
          <PlayCircle className="size-3.5" /> Narrated walkthrough{vtt ? " with captions" : ""}
        </span>
        {srt ? (
          <a href={srt} download className="ms-auto inline-flex items-center gap-1.5 hover:text-fd-primary">
            <Captions className="size-3.5" /> Download captions (.srt)
          </a>
        ) : null}
      </figcaption>
    </figure>
  );
}
