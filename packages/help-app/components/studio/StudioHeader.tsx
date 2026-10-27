"use client";
import { ThemeSwitch } from "fumadocs-ui/layouts/shared/slots/theme-switch";
import brandJson from "@/lib/brand.json";
import { cn } from "@/lib/cn";
import { relativeTime, STATUS_LABEL } from "./format";
import { Icon } from "./icons";
import type { CaptureStatus } from "./types";

// Contract 2: written by the engine (`aida init`/`theme`/`build`); logo/logoDark/icon are site
// URLs under /brand/, or null when the app has none.
interface BrandJson {
  name?: string;
  logo?: string | null;
  logoDark?: string | null;
  icon?: string | null;
}
const brand = brandJson as BrandJson;

/** The Studio's top bar: the app's own mark and name, the walkthrough being edited with its
 * last-checked status, and actions (open the page on the help site, light/dark). */
export function StudioHeader({
  title,
  status,
  lastChecked,
  siteUrl,
  loading,
  onOpenProof,
}: {
  title?: string;
  status?: CaptureStatus;
  lastChecked?: string;
  siteUrl?: string;
  loading: boolean;
  /** Opens the proof sheet (`aida proof`). */
  onOpenProof?: () => void;
}) {
  return (
    <header className="flex h-14 shrink-0 items-center gap-3 border-b border-fd-border studio-surface px-4">
      <a href="/" className="studio-focus flex shrink-0 items-center gap-2.5 rounded-md" title="Open the help site">
        <BrandMark />
        <span className="flex items-baseline gap-1.5">
          <span className="text-[15px] font-semibold tracking-tight">{brand.name || "Help"}</span>
          <span className="rounded-md bg-fd-primary/10 px-1.5 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-fd-primary">Studio</span>
        </span>
      </a>

      <span className="h-6 w-px shrink-0 bg-fd-border" aria-hidden />

      <div className="flex min-w-0 flex-1 items-center gap-2.5">
        {loading ? (
          <div className="studio-skeleton h-4 w-64" />
        ) : title ? (
          <>
            <h1 className="truncate text-sm font-semibold" title={title}>
              {title}
            </h1>
            {status ? <StatusPill status={status} lastChecked={lastChecked} /> : null}
          </>
        ) : (
          <span className="text-sm text-fd-muted-foreground">No walkthrough selected</span>
        )}
      </div>

      <div className="flex shrink-0 items-center gap-2">
        <span className="hidden items-center gap-1 text-[11px] text-fd-muted-foreground 2xl:flex" title="Move between steps">
          <kbd className="studio-kbd">↑</kbd>
          <kbd className="studio-kbd">↓</kbd>
          steps
        </span>
        {onOpenProof ? (
          <button type="button" onClick={onOpenProof} className="studio-btn h-8 px-3" title="How the brand looks on every output">
            <Icon name="sparkles" className="size-3.5" />
            Proof sheet
          </button>
        ) : null}
        {siteUrl ? (
          <a href={siteUrl} target="_blank" rel="noreferrer" className="studio-btn h-8 px-3">
            View on help site
            <Icon name="external" className="size-3.5" />
          </a>
        ) : null}
        <ThemeSwitch className="h-8" />
      </div>
    </header>
  );
}

function BrandMark() {
  const icon = brand.icon || undefined;
  const light = icon ?? (brand.logo || undefined);
  const dark = icon ?? (brand.logoDark || brand.logo || undefined);
  if (!light) {
    return (
      <span className="flex size-8 items-center justify-center rounded-lg bg-fd-primary text-fd-primary-foreground">
        <Icon name="book" className="size-4" />
      </span>
    );
  }
  /* eslint-disable @next/next/no-img-element -- brand files from /public/brand, any size/format */
  return (
    <span className="flex size-8 items-center justify-center overflow-hidden rounded-lg">
      <img src={light} alt="" className={cn("size-8 object-contain", dark !== light && "dark:hidden")} />
      {dark !== light ? <img src={dark} alt="" className="hidden size-8 object-contain dark:block" /> : null}
    </span>
  );
  /* eslint-enable @next/next/no-img-element */
}

const PILL: Record<CaptureStatus, string> = {
  passed: "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
  failed: "border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-400",
  captured: "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400",
  "not-captured": "border-fd-border bg-fd-muted text-fd-muted-foreground",
};

function StatusPill({ status, lastChecked }: { status: CaptureStatus; lastChecked?: string }) {
  return (
    <span
      className={cn("inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-medium", PILL[status])}
      title={lastChecked ? `Last checked against the app ${new Date(lastChecked).toLocaleString()}` : undefined}
    >
      <Icon name={status === "passed" ? "check" : status === "failed" ? "alert" : "clock"} className="size-3" />
      {STATUS_LABEL[status]}
      {lastChecked ? <span className="font-normal opacity-80">· checked {relativeTime(lastChecked)}</span> : null}
    </span>
  );
}
