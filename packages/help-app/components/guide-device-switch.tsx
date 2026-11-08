// The guide header's own Computer/Phone switch (decision 40, M43b) — a small client island so
// the rest of the guide header (page.tsx's `Guide`) can stay a server component. Shares the same
// device choice as every `<DeviceShots>` and the video embed on the page (`lib/device.ts`).
"use client";

import { useDevice, type Device } from "@/lib/device";
import { DeviceSwitch } from "./device-switch";

export function GuideDeviceSwitch({ devices }: { devices?: Device[] }) {
  const list = devices && devices.length > 1 ? devices : undefined;
  const [device, choose] = useDevice(list ?? ["desktop"]);
  if (!list) return null;
  return <DeviceSwitch devices={list} value={device} onChange={choose} className="print:hidden" />;
}
