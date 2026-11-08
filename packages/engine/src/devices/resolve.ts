// Which devices a walkthrough is captured and shown on, and the per-device settings and paths
// the capture runner and build pipeline need (decision 40, M43a). Pure and deterministic: no
// Playwright, no filesystem beyond the plain path-joining `captureDirFor` does.
//
// Precedence (decision 40): the walkthrough's own `devices` wins; else the config's `devices`;
// else the brief's readers, matched to this walkthrough's role, falling back to `["desktop"]`
// when nothing says otherwise. The first device in the result is always the primary — the one
// whose output keeps today's plain names/paths (`step-NN.png`, `<buildDir>/<id>/capture`).
import { join } from "node:path";
import type { Device, Step, Walkthrough } from "../walkthrough/index.js";
import type { ResolvedConfig } from "../config/types.js";
import { resolvePhoneSettings, type ResolvedPhoneSettings } from "../config/types.js";
import { briefReaders, type BriefReader, type ParsedBrief } from "../brief/format.js";

/** The role a walkthrough signs in as, for matching it to brief readers — same precedence
 * `personaRole`/`rawRole` use elsewhere: an explicit persona role, else the `signed_in_as`
 * shorthand, else the walkthrough's reader-facing `for`. */
function walkthroughRole(wf: Pick<Walkthrough, "for" | "start">): string | undefined {
  return wf.start?.persona?.role ?? wf.start?.signed_in_as ?? wf.for;
}

/** The brief readers this walkthrough's role matches, falling back to every reader when none
 * of them name a matching role (decision 40: "fall back to all brief readers when roles don't
 * match any"). */
function readersFor(wf: Pick<Walkthrough, "for" | "start">, readers: BriefReader[]): BriefReader[] {
  if (readers.length === 0) return [];
  const role = walkthroughRole(wf);
  const matched = role ? readers.filter((r) => r.role === role) : [];
  return matched.length > 0 ? matched : readers;
}

/** True when every reader who uses a phone uses *only* a phone — no desktop or tablet listed —
 * so phone is this walkthrough's primary device rather than a secondary one. */
function phoneOnly(readers: BriefReader[]): boolean {
  const phoneReaders = readers.filter((r) => (r.devices ?? []).includes("phone"));
  return phoneReaders.every((r) => !(r.devices ?? []).some((d) => d === "desktop" || d === "tablet"));
}

/**
 * Resolves the devices a walkthrough is captured and shown on, first = primary (decision 40):
 * the walkthrough's own `devices` wins, else the config's, else the brief's readers (`brief`,
 * when given — `loadBrief(briefPath(config))`), else `["desktop"]`. "Tablet" (a brief device) is
 * never returned on its own — it counts as desktop for now, until there's a separate tablet
 * capture.
 */
export function devicesFor(
  wf: Pick<Walkthrough, "devices" | "for" | "start">,
  config: Pick<ResolvedConfig, "devices">,
  brief?: ParsedBrief,
): Device[] {
  if (wf.devices && wf.devices.length > 0) return wf.devices;
  if (config.devices && config.devices.length > 0) return config.devices;
  if (!brief) return ["desktop"];
  const readers = readersFor(wf, briefReaders(brief));
  if (readers.length === 0) return ["desktop"];
  const anyPhone = readers.some((r) => (r.devices ?? []).includes("phone"));
  if (!anyPhone) return ["desktop"];
  return phoneOnly(readers) ? ["phone", "desktop"] : ["desktop", "phone"];
}

/** Per-device browser-context settings. Desktop is exactly today's behaviour (walkthrough
 * `start.viewport`/`deviceScaleFactor`, else config, else the built-in default) — phone settings
 * come from config `phone` only: a walkthrough's `start` is a desktop-era field that phone
 * capture doesn't read, so every walkthrough gets one consistent phone profile. */
export interface DeviceSettings {
  viewport: { width: number; height: number };
  deviceScaleFactor: number;
  isMobile: boolean;
  hasTouch: boolean;
  /** Set only for phone (desktop capture never overrides Chromium's own UA). */
  userAgent?: string;
}

export function deviceSettings(
  device: Device,
  wf: Pick<Walkthrough, "start">,
  config: Pick<ResolvedConfig, "viewport" | "deviceScaleFactor" | "phone">,
): DeviceSettings {
  if (device === "phone") {
    const phone: ResolvedPhoneSettings = resolvePhoneSettings(config.phone);
    return { viewport: phone.viewport, deviceScaleFactor: phone.deviceScaleFactor, isMobile: true, hasTouch: true, userAgent: phone.userAgent };
  }
  return {
    viewport: wf.start?.viewport ?? config.viewport ?? { width: 1440, height: 810 },
    deviceScaleFactor: wf.start?.deviceScaleFactor ?? config.deviceScaleFactor ?? 2,
    isMobile: false,
    hasTouch: false,
  };
}

/**
 * Where a device's capture is written under the build dir: desktop keeps today's plain
 * `<buildDir>/<id>/capture` (so an existing build's cache/paths/manifests stay valid unchanged);
 * every other device gets its own `<buildDir>/<id>/<device>/capture` — the primary device too, so
 * a phone-primary walkthrough's own capture is `<id>/phone/capture`. Code that wants "the"
 * capture of a walkthrough (its primary device's) uses `primaryCaptureDir`, never a hard-coded
 * `<id>/capture`, so readers and writers agree.
 */
export function captureDirFor(buildDir: string, id: string, device: Device): string {
  return device === "desktop" ? join(buildDir, id, "capture") : join(buildDir, id, device, "capture");
}

/** The primary device's capture dir (`captureDirFor` of `devicesFor(...)[0]`) — where `aida
 * build`/`aida capture` write a walkthrough's own capture and where every reader finds it.
 * `brief` is `loadBrief(briefPath(config))`. */
export function primaryCaptureDir(
  config: Pick<ResolvedConfig, "buildDir" | "devices">,
  wf: Pick<Walkthrough, "walkthrough" | "devices" | "for" | "start">,
  brief?: ParsedBrief,
): string {
  return captureDirFor(config.buildDir, wf.walkthrough, devicesFor(wf, config, brief)[0]);
}

/** `aida ci`'s own capture dir for one device: `captureDirFor`'s layout under `<id>/ci/`. */
export function ciCaptureDirFor(buildDir: string, id: string, device: Device): string {
  return device === "desktop" ? join(buildDir, id, "ci", "capture") : join(buildDir, id, "ci", device, "capture");
}

/** `wf.steps` restricted to the ones that run on `device` — a step with no `devices` runs on
 * every device; one that names `devices` runs only on the ones it lists. */
export function stepsFor(wf: Pick<Walkthrough, "steps">, device: Device): Step[] {
  return wf.steps.filter((s) => !s.devices || s.devices.includes(device));
}
