// A step with more than one device's screenshot (decision 40, M43b) — the engine wraps the
// primary's `![alt](file)` and every other device's in `<DeviceShots devices="desktop,phone">`
// (pages/content.ts `buildStepBlock`). Shows one device's image at a time, following the site's
// shared device choice (`lib/device.ts` `useDevice`) with a `<DeviceSwitch>` above it when there's
// more than one. Print always shows the primary's (first child's) image — `.aida-device-shots`
// rules in app/print.css override the on-screen choice there.
"use client";

import { Children, type ReactNode } from "react";
import { cn } from "@/lib/cn";
import { useDevice, type Device } from "@/lib/device";
import { DeviceSwitch } from "./device-switch";
import { activeDeviceIndex, parseDeviceList } from "./device-shots-parse";

export interface DeviceShotsProps {
  /** Comma-separated device list, primary first — exactly the engine's `devices` attribute. */
  devices: string;
  children: ReactNode;
}

export function DeviceShots({ devices, children }: DeviceShotsProps) {
  const deviceList = parseDeviceList(devices);
  const [device, choose] = useDevice(deviceList.length > 0 ? deviceList : (["desktop"] as Device[]));
  // One child per device, in the same order as `deviceList` (the engine writes them that way) —
  // filters out the blank-line whitespace text nodes MDX leaves between block children.
  const items = Children.toArray(children).filter((child) => typeof child !== "string" || child.trim() !== "");
  const activeIndex = activeDeviceIndex(deviceList, device);

  return (
    <div className="aida-device-shots not-prose my-4">
      {deviceList.length > 1 ? (
        <div className="mb-2 flex justify-end print:hidden">
          <DeviceSwitch devices={deviceList} value={device} onChange={choose} />
        </div>
      ) : null}
      {items.map((child, i) => (
        <div
          key={i}
          data-device={deviceList[i] ?? "desktop"}
          // The primary (first) device's image is what print always shows (app/print.css) and
          // what search/PDF already read from the plain Markdown — kept out of CSS logic alone
          // so it's unambiguous even if something inspects the DOM directly.
          {...(i === 0 ? { "data-primary": "" } : {})}
          hidden={i !== activeIndex}
          className={cn(deviceList[i] === "phone" && "aida-phone-shot")}
        >
          {child}
        </div>
      ))}
    </div>
  );
}
