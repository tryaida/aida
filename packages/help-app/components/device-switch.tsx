// The Computer / Phone switch beside a guide's screenshots and video (decision 40). A group of
// toggle buttons rather than tabs: each one changes what every screenshot and video on the site
// shows, not just the panel beside it.
"use client";

import { Monitor, Smartphone } from "lucide-react";
import { cn } from "@/lib/cn";
import { DEVICE_LABELS, type Device } from "@/lib/device";

const ICONS = { desktop: Monitor, phone: Smartphone } as const;

export function DeviceSwitch({ devices, value, onChange, className }: {
  devices: readonly Device[];
  value: Device;
  onChange: (device: Device) => void;
  className?: string;
}) {
  if (devices.length < 2) return null;
  return (
    <div role="group" aria-label="Show screens on" className={cn("aida-device-switch not-prose inline-flex rounded-lg border border-fd-border bg-fd-card p-0.5 text-xs print:hidden", className)}>
      {devices.map((d) => {
        const Icon = ICONS[d];
        const on = d === value;
        return (
          <button
            key={d}
            type="button"
            aria-pressed={on}
            onClick={() => onChange(d)}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 font-medium transition-colors motion-reduce:transition-none",
              on ? "bg-fd-primary text-fd-primary-foreground" : "text-fd-muted-foreground hover:text-fd-foreground",
            )}
          >
            <Icon className="size-3.5" aria-hidden="true" />
            {DEVICE_LABELS[d]}
          </button>
        );
      })}
    </div>
  );
}
