"use client";
// Client-side fetch helpers for the Studio's /studio/api/** routes. Every call carries the
// per-process Studio token (app/studio/_lib/security.ts) — which is also why images and video
// are fetched here and handed to <img>/<video> as blob URLs: a plain src="" can't send the header.
import { useEffect, useState } from "react";

export const STUDIO_TOKEN_HEADER = "x-aida-studio-token";

export const FORBIDDEN_HINT =
  "The Studio only answers on localhost. Open it at http://localhost:<port>/studio, or start the dev server with AIDA_STUDIO_ALLOWED_HOSTS=<this host> if this host is behind your own sign-in.";

export async function getJson<T>(url: string, studioToken: string): Promise<T> {
  const res = await fetch(url, { headers: { [STUDIO_TOKEN_HEADER]: studioToken } });
  if (res.status === 403) throw new Error(FORBIDDEN_HINT);
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(data.error ?? `${url} answered ${res.status}`);
  }
  return (await res.json()) as T;
}

export async function postJson<T>(url: string, body: unknown, studioToken: string): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", [STUDIO_TOKEN_HEADER]: studioToken },
    body: JSON.stringify(body),
  });
  if (res.status === 403) throw new Error(FORBIDDEN_HINT);
  const data = (await res.json().catch(() => ({}))) as T & { error?: string; ok?: boolean };
  if (!res.ok || data.ok === false) throw new Error(data.error ?? `${url} answered ${res.status}`);
  return data;
}

// Blob URLs shared by every component showing the same image (timeline strip, step card, editor,
// page preview), so a screenshot is fetched once per Studio session rather than once per view.
// Captured frames and built page images only change on a new capture/build, which a reload picks up.
const blobCache = new Map<string, Promise<string>>();

function blobUrl(url: string, studioToken: string): Promise<string> {
  let p = blobCache.get(url);
  if (!p) {
    p = fetch(url, { headers: { [STUDIO_TOKEN_HEADER]: studioToken } })
      .then((res) => (res.ok ? res.blob() : Promise.reject(new Error(String(res.status)))))
      .then((blob) => URL.createObjectURL(blob));
    p.catch(() => blobCache.delete(url));
    blobCache.set(url, p);
  }
  return p;
}

export type BlobState = { status: "loading" } | { status: "ready"; src: string } | { status: "missing" };

/** Fetches a token-guarded Studio asset and returns a blob URL for it; `url` undefined = nothing to load. */
export function useStudioBlob(url: string | undefined, studioToken: string): BlobState {
  const [state, setState] = useState<{ url?: string; value: BlobState }>({ value: { status: "loading" } });
  useEffect(() => {
    if (!url) return;
    let cancelled = false;
    blobUrl(url, studioToken).then(
      (src) => !cancelled && setState({ url, value: { status: "ready", src } }),
      () => !cancelled && setState({ url, value: { status: "missing" } }),
    );
    return () => {
      cancelled = true;
    };
  }, [url, studioToken]);
  if (!url) return { status: "missing" };
  return state.url === url ? state.value : { status: "loading" };
}

export function screenshotUrl(walkthroughId: string, stepNumber: number): string {
  return `/studio/api/screenshot?id=${encodeURIComponent(walkthroughId)}&step=${stepNumber}`;
}
