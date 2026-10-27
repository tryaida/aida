// Shows when a page's walkthrough was last replayed against the real app, and whether it passed
// (docs/scope.md principle 7: "Pages show when they were last checked"). Pages with
// `passed: false` never reach a production build (app/(site)/[[...slug]]/page.tsx), so readers
// only ever see the passing state; the failing one is for dev and the Studio.
import { BadgeCheck, TriangleAlert } from "lucide-react";
import { formatDate } from "./site/format";

export interface LastCheckedBadgeProps {
  lastChecked?: string;
  passed: boolean;
}

export function LastCheckedBadge({ lastChecked, passed }: LastCheckedBadgeProps) {
  const date = formatDate(lastChecked);
  if (passed) {
    return (
      <span
        className="aida-last-checked inline-flex items-center gap-1.5 rounded-full border border-emerald-600/25 bg-emerald-600/10 px-2.5 py-1 text-xs font-medium text-emerald-800 dark:text-emerald-300"
        title="Every step on this page was replayed against the real app and passed."
      >
        <BadgeCheck className="size-3.5" />
        {date ? `Checked in the app ${date}` : "Checked in the app"}
      </span>
    );
  }
  return (
    <span className="aida-last-checked inline-flex items-center gap-1.5 rounded-full border border-amber-600/30 bg-amber-500/10 px-2.5 py-1 text-xs font-medium text-amber-800 dark:text-amber-300">
      <TriangleAlert className="size-3.5" />
      {date ? `Not verified · last run ${date}` : "Not verified yet"}
    </span>
  );
}
