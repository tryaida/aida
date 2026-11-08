// Pure parsing for components/device-shots.tsx, kept separate so it's testable without a DOM
// (same split as components/video-embed-parse.ts).
import type { Device } from "@/lib/device";

/** The engine's `devices="desktop,phone"` attribute (pages/content.ts `deviceShotsAttr`) back
 * into a device list, primary first — trimmed, and anything that isn't a known device dropped
 * (future-proofing: a reader's cached page should never crash on a device name it doesn't know). */
export function parseDeviceList(devices: string): Device[] {
  return devices
    .split(",")
    .map((d) => d.trim())
    .filter((d): d is Device => d === "desktop" || d === "phone");
}

/** Which of `deviceList`'s positions is the chosen device's image — 0 (the primary) when the
 * chosen device isn't in the list at all (a stale choice from before this page's own devices). */
export function activeDeviceIndex(deviceList: Device[], device: Device): number {
  const i = deviceList.indexOf(device);
  return i === -1 ? 0 : i;
}
