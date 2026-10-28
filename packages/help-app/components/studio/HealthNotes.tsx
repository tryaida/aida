"use client";
import { cn } from "@/lib/cn";
import { Icon } from "./icons";
import type { CaptureStatus, StudioDrift, StudioFailure } from "./types";

/** Under the walkthrough's title: why the last capture failed and who it looks like (decision
 * 30: a possible app bug is for a person to check, never worked around in the walkthrough), and
 * the names on its outline card that differ from the screen (M29). Nothing when there's neither. */
export function HealthNotes({ status, failure, drift }: { status: CaptureStatus; failure?: StudioFailure; drift?: StudioDrift[] }) {
  const showFailure = status === "failed" && failure;
  if (!showFailure && !(drift && drift.length > 0)) return null;
  return (
    <div className="mt-2 flex max-w-3xl flex-col gap-1.5 text-[12px]">
      {showFailure ? (
        <div
          role="status"
          className={cn(
            "flex items-start gap-2 rounded-lg border px-2.5 py-1.5",
            failure.category === "app"
              ? "border-red-500/30 bg-red-500/10 text-red-800 dark:text-red-300"
              : "border-amber-500/30 bg-amber-500/10 text-amber-800 dark:text-amber-300",
          )}
        >
          <Icon name="alert" className="mt-0.5 size-3.5 shrink-0" />
          <span className="min-w-0">
            <span className="font-semibold">Last capture: {failure.label}</span>
            {failure.step ? <span className="opacity-80"> · step {failure.step}</span> : null}
            <span className="block">{failure.reason}</span>
            {failure.category === "app" || failure.category === "undetermined" ? (
              <span className="block opacity-80">Check this in the app; the walkthrough isn&apos;t changed to work around it.</span>
            ) : null}
          </span>
        </div>
      ) : null}
      {drift && drift.length > 0 ? (
        <div className="flex items-start gap-2 rounded-lg border border-fd-border bg-fd-muted/60 px-2.5 py-1.5 text-fd-muted-foreground">
          <Icon name="alert" className="mt-0.5 size-3.5 shrink-0" />
          <span className="min-w-0">
            <span className="font-semibold text-fd-foreground">
              Outline card: {drift.length} name{drift.length === 1 ? "" : "s"} {drift.length === 1 ? "differs" : "differ"} from the screen
            </span>
            <ul className="mt-0.5 list-disc pl-4">
              {drift.map((d) => (
                <li key={`${d.source}:${d.expected}`}>{d.text}</li>
              ))}
            </ul>
          </span>
        </div>
      ) : null}
    </div>
  );
}
