// Library cards: one per guide (walkthrough page) and one per section, used on the home page and
// on every section page so the library can be browsed without the sidebar.
import Link from "next/link";
import { ChevronRight, FolderOpen, ListOrdered, PlayCircle } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/cn";
import { formatDate, plural } from "./format";

export interface GuideCardProps {
  url: string;
  title: ReactNode;
  description?: string;
  poster?: string;
  steps?: number;
  video?: boolean;
  lastChecked?: string;
}

export function GuideCard({ url, title, description, poster, steps, video, lastChecked }: GuideCardProps) {
  const checked = formatDate(lastChecked);
  return (
    <Link
      href={url}
      className="group flex flex-col overflow-hidden rounded-[calc(var(--brand-radius)+2px)] border border-fd-border bg-fd-card text-fd-card-foreground shadow-xs transition hover:-translate-y-0.5 hover:border-fd-primary/40 hover:shadow-lg"
    >
      <div className="relative aspect-[16/9] overflow-hidden border-b border-fd-border bg-fd-muted">
        {poster ? (
          // eslint-disable-next-line @next/next/no-img-element -- screenshots are already sized by the engine
          <img src={poster} alt="" loading="lazy" className="size-full object-cover object-top transition duration-300 group-hover:scale-[1.02]" />
        ) : (
          <div className="flex size-full items-center justify-center text-fd-muted-foreground">
            <ListOrdered className="size-8 opacity-40" />
          </div>
        )}
        {video ? (
          <span className="absolute bottom-2 left-2 inline-flex items-center gap-1 rounded-full bg-black/70 px-2 py-0.5 text-xs font-medium text-white backdrop-blur">
            <PlayCircle className="size-3.5" /> Video
          </span>
        ) : null}
      </div>
      <div className="flex flex-1 flex-col gap-1.5 p-4">
        <h3 className="font-heading font-semibold leading-snug group-hover:text-fd-primary">{title}</h3>
        {description ? <p className="line-clamp-2 text-sm text-fd-muted-foreground">{description}</p> : null}
        <div className="mt-auto flex flex-wrap items-center gap-x-3 gap-y-1 pt-2 text-xs text-fd-muted-foreground">
          {steps ? <span>{plural(steps, "step")}</span> : null}
          {checked ? <span>Checked {checked}</span> : null}
        </div>
      </div>
    </Link>
  );
}

export interface SectionCardProps {
  url?: string;
  title: ReactNode;
  description?: ReactNode;
  icon?: ReactNode;
  guides: { url: string; title: ReactNode }[];
}

export function SectionCard({ url, title, description, icon, guides }: SectionCardProps) {
  const shown = guides.slice(0, 4);
  return (
    <div className="flex flex-col rounded-[calc(var(--brand-radius)+2px)] border border-fd-border bg-fd-card p-5 text-fd-card-foreground shadow-xs">
      <div className="flex items-start gap-3">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-[var(--brand-radius)] bg-fd-primary/10 text-fd-primary [&_svg]:size-5">
          {icon ?? <FolderOpen />}
        </span>
        <div className="min-w-0">
          <h3 className="font-heading font-semibold leading-snug">
            {url ? (
              <Link href={url} className="hover:text-fd-primary">
                {title}
              </Link>
            ) : (
              title
            )}
          </h3>
          <p className="text-sm text-fd-muted-foreground">
            {description ?? plural(guides.length, "guide")}
          </p>
        </div>
      </div>
      {shown.length > 0 ? (
        <ul className="mt-4 flex flex-col border-t border-fd-border pt-2">
          {shown.map((g) => (
            <li key={g.url}>
              <Link
                href={g.url}
                className="group flex items-center gap-2 rounded-md px-1 py-1.5 text-sm hover:text-fd-primary"
              >
                <ChevronRight className="size-3.5 shrink-0 text-fd-muted-foreground group-hover:text-fd-primary" />
                <span className="truncate">{g.title}</span>
              </Link>
            </li>
          ))}
        </ul>
      ) : null}
      {url && guides.length > shown.length ? (
        <Link href={url} className="mt-2 text-sm font-medium text-fd-primary hover:underline">
          All {plural(guides.length, "guide")}
        </Link>
      ) : null}
    </div>
  );
}

export function CardGrid({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("not-prose grid gap-4 sm:grid-cols-2 xl:grid-cols-3", className)}>{children}</div>;
}
