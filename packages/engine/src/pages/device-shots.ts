// Helpers shared by pages/build.ts and procedures/build.ts for a step shown on more than one
// device (decision 40, M43b): the reader-facing note for a device-only step, and the file names
// a secondary device's screenshots get — chosen so neither ever matches the PDF's `STEP_IMG`/
// `PATH_STEP_IMG` regexes (pdf/html.ts), which must only ever pick up the primary device's shot.
import type { Device } from "../walkthrough/index.js";

const DEVICE_WORDS: Record<Device, string> = { desktop: "a computer", phone: "a phone" };

/**
 * The reader-facing note for a step whose own `devices:` is a proper subset of the walkthrough's
 * devices (`allDevices`, primary first) — "On a phone only." / "On a computer only." — or
 * undefined when the step runs on every device the walkthrough shows (no `devices:`, or it names
 * all of them). Never says anything when the walkthrough itself only has one device: there's
 * nothing to contrast with.
 */
export function deviceOnlyNote(stepDevices: Device[] | undefined, allDevices: Device[]): string | undefined {
  if (!stepDevices || stepDevices.length === 0) return undefined;
  if (allDevices.length < 2) return undefined;
  const only = allDevices.filter((d) => stepDevices.includes(d));
  if (only.length === 0 || only.length >= allDevices.length) return undefined;
  const words = only.map((d) => DEVICE_WORDS[d]);
  const joined = words.length === 1 ? words[0] : `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`;
  return `On ${joined} only.`;
}

/** A secondary device's main-step screenshot: `screenshots/<device>-step-NN.png`. Never
 * `.../step-NN.png` after a slash (unlike the primary's `screenshotFile`), which is what
 * `STEP_IMG` requires to match. */
export function secondaryScreenshotFile(device: Device, stepNumber: number): string {
  return `screenshots/${device}-step-${String(stepNumber).padStart(2, "0")}.png`;
}

/** A secondary device's path-step screenshot, nested under its own device directory —
 * `screenshots/paths/<device>/<pathId>-step-NN.png` — so it can never match `PATH_STEP_IMG`
 * (which requires `/paths/<id>-step-NN.png` with no further `/` in between): that regex's id
 * group can't match across a path separator, however the id and device name are combined. */
export function secondaryPathScreenshotFile(device: Device, pathId: string, stepNumber: number): string {
  return `screenshots/paths/${device}/${pathId}-step-${String(stepNumber).padStart(2, "0")}.png`;
}

/** The `devices` attribute `<DeviceShots>` reads: every device this walkthrough shows, primary
 * first, as written in a walkthrough/config `devices:` list. */
export function deviceShotsAttr(devices: Device[]): string {
  return devices.join(",");
}

/** Matches one `<DeviceShots>` wrapper (`buildStepBlock`'s exact output: the tag, a blank line,
 * the primary image, a blank line, one or more secondary images each followed by a blank line,
 * the closing tag) and captures the primary image's own `![alt](file)` line. */
const DEVICE_SHOTS_BLOCK = /<DeviceShots\b[^\n]*>\n\n(!\[[^\]]*\]\([^\n)]*\))\n\n[\s\S]*?\n<\/DeviceShots>\n?/g;

/** A device-only step's image when the primary never runs that step at all — no wrapper, since
 * there's no primary image to show beside it (`buildStepBlock`), but still a secondary device's
 * file (`screenshots/<device>-step-NN.png`), named the same as any other secondary shot. */
const LONE_SECONDARY_IMAGE = /^!\[[^\]]*\]\(screenshots\/(?:desktop|phone)-step-\d+\.png\)\n?/gm;

/**
 * Drops a `<DeviceShots>` wrapper down to its primary image's plain `![alt](file)` line, and
 * removes a device-only step's lone secondary-device image entirely — same idea as
 * `stripPathClips`'s `CLIP_EMBED`. Used on `index.plain.md` (llms.txt, search) and the PDF input
 * (pdf/input.ts): both read past a secondary device's screenshot exactly as they did before
 * `<DeviceShots>` existed, since it's never anything but a help-app, on-screen affordance (print,
 * search and llms.txt only ever show the primary device, when it has anything to show at all).
 */
export function stripDeviceShots(markdown: string): string {
  return markdown.replace(DEVICE_SHOTS_BLOCK, (_m, primaryImage: string) => `${primaryImage}\n`).replace(LONE_SECONDARY_IMAGE, "");
}
