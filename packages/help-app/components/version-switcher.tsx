"use client";
// Version switcher (docs/scope.md "Help site": "a version per release"; build-plan.md M21 step
// 2). Keeps the unversioned "latest" URL stable: this never changes the current page's own
// route, it only offers a link sideways into `/v/<name>/...` (or back to the real page from
// there). Reads `public/versions.json` client-side so a static export still works with no API
// route — the same file the chat/MCP routes already read server-side (versions/manifest.ts).
import { useEffect, useState } from "react";

interface VersionManifestEntry {
  name: string;
  date: string;
  gitRef?: string;
}

interface VersionManifest {
  latest: string;
  versions: VersionManifestEntry[];
}

/** Strips a leading `/v/<version>` segment off `pathname`, so switching versions keeps the
 * reader on the same page instead of bouncing them to that version's home. */
function currentSlugFrom(pathname: string): string {
  const match = /^\/v\/[^/]+(\/.*)?$/.exec(pathname);
  return match ? match[1] ?? "" : pathname;
}

export function VersionSwitcher() {
  const [manifest, setManifest] = useState<VersionManifest | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    fetch("/versions.json")
      .then((r) => (r.ok ? (r.json() as Promise<VersionManifest>) : undefined))
      .then((m) => {
        if (!cancelled) setManifest(m);
      })
      .catch(() => {
        // No versions.json yet (nothing frozen) — the switcher simply doesn't render.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!manifest || manifest.versions.length === 0) return null;

  return (
    <label className="flex items-center justify-between gap-2 rounded-[var(--brand-radius)] border border-fd-border bg-fd-card px-2.5 py-1.5 text-xs text-fd-muted-foreground">
      <span className="font-medium">Version</span>
      <select
        defaultValue="latest"
        onChange={(e) => {
          const target = e.target.value;
          const slug = currentSlugFrom(window.location.pathname);
          window.location.href = target === "latest" ? slug || "/" : `/v/${target}${slug}`;
        }}
        className="min-w-0 flex-1 truncate bg-transparent text-end text-fd-foreground outline-none"
      >
        <option value="latest">Latest ({manifest.latest})</option>
        {manifest.versions.map((v) => (
          <option key={v.name} value={v.name}>
            {v.name}
          </option>
        ))}
      </select>
    </label>
  );
}
