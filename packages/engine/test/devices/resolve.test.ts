import { describe, expect, it } from "vitest";
import { captureDirFor, ciCaptureDirFor, deviceSettings, devicesFor, primaryCaptureDir, stepsFor } from "../../src/devices/resolve.js";
import type { ParsedBrief } from "../../src/brief/format.js";
import type { Step, Walkthrough } from "../../src/walkthrough/types.js";
import type { ResolvedConfig } from "../../src/config/types.js";

function wf(overrides: Partial<Pick<Walkthrough, "devices" | "for" | "start">> = {}): Pick<Walkthrough, "devices" | "for" | "start"> {
  return { for: "office-staff", ...overrides };
}

function cfg(devices?: Pick<ResolvedConfig, "devices">["devices"]): Pick<ResolvedConfig, "devices"> {
  return { devices };
}

function brief(readers: unknown): ParsedBrief {
  return { frontmatter: { readers }, preamble: "", sections: [] };
}

describe("devicesFor", () => {
  it("the walkthrough's own devices wins over everything else", () => {
    const b = brief([{ role: "office-staff", name: "Alex", job: "runs the desk", devices: ["phone"] }]);
    expect(devicesFor(wf({ devices: ["desktop"] }), cfg(["phone"]), b)).toEqual(["desktop"]);
  });

  it("config devices wins over the brief when the walkthrough sets none", () => {
    const b = brief([{ role: "office-staff", name: "Alex", job: "runs the desk", devices: ["phone"] }]);
    expect(devicesFor(wf(), cfg(["desktop", "phone"]), b)).toEqual(["desktop", "phone"]);
  });

  it("with no walkthrough/config devices and no brief, defaults to desktop only", () => {
    expect(devicesFor(wf(), cfg(undefined))).toEqual(["desktop"]);
  });

  it("brief readers who use only a phone (no desktop/tablet) make phone the primary device", () => {
    const b = brief([{ role: "office-staff", name: "Alex", job: "runs the desk", devices: ["phone"] }]);
    expect(devicesFor(wf(), cfg(undefined), b)).toEqual(["phone", "desktop"]);
  });

  it("a reader who uses both phone and desktop makes desktop primary, phone secondary", () => {
    const b = brief([{ role: "office-staff", name: "Alex", job: "runs the desk", devices: ["phone", "desktop"] }]);
    expect(devicesFor(wf(), cfg(undefined), b)).toEqual(["desktop", "phone"]);
  });

  it("readers who never mention phone leave desktop-only", () => {
    const b = brief([{ role: "office-staff", name: "Alex", job: "runs the desk", devices: ["desktop"] }]);
    expect(devicesFor(wf(), cfg(undefined), b)).toEqual(["desktop"]);
  });

  it("tablet-only readers count as desktop (no phone), not phone-only", () => {
    const b = brief([{ role: "office-staff", name: "Alex", job: "runs the desk", devices: ["tablet"] }]);
    expect(devicesFor(wf(), cfg(undefined), b)).toEqual(["desktop"]);
  });

  it("falls back to every brief reader when none match the walkthrough's role", () => {
    const b = brief([{ role: "judges", name: "Sam", job: "scores races", devices: ["phone"] }]);
    expect(devicesFor(wf({ for: "office-staff" }), cfg(undefined), b)).toEqual(["phone", "desktop"]);
  });

  it("matches readers by the walkthrough's role over its reader-facing `for`", () => {
    const b = brief([
      { role: "office-staff", name: "Alex", job: "runs the desk", devices: ["desktop"] },
      { role: "judges", name: "Sam", job: "scores races", devices: ["phone"] },
    ]);
    expect(devicesFor({ for: "office-staff", start: { persona: { role: "judges" } } }, cfg(undefined), b)).toEqual(["phone", "desktop"]);
  });

  it("an empty brief (no readers) defaults to desktop only", () => {
    expect(devicesFor(wf(), cfg(undefined), brief([]))).toEqual(["desktop"]);
  });
});

describe("deviceSettings", () => {
  it("desktop keeps today's resolution order: walkthrough start, then config, then the built-in default", () => {
    expect(deviceSettings("desktop", {}, {})).toEqual({
      viewport: { width: 1440, height: 810 },
      deviceScaleFactor: 2,
      isMobile: false,
      hasTouch: false,
    });
    expect(deviceSettings("desktop", {}, { viewport: { width: 1024, height: 768 }, deviceScaleFactor: 1 })).toEqual({
      viewport: { width: 1024, height: 768 },
      deviceScaleFactor: 1,
      isMobile: false,
      hasTouch: false,
    });
    expect(
      deviceSettings(
        "desktop",
        { start: { viewport: { width: 800, height: 600 }, deviceScaleFactor: 3 } },
        { viewport: { width: 1024, height: 768 }, deviceScaleFactor: 1 },
      ),
    ).toEqual({ viewport: { width: 800, height: 600 }, deviceScaleFactor: 3, isMobile: false, hasTouch: false });
  });

  it("phone ignores the walkthrough's start.viewport — one profile for every walkthrough, from config.phone", () => {
    const settings = deviceSettings("phone", { start: { viewport: { width: 999, height: 999 } } }, {});
    expect(settings.isMobile).toBe(true);
    expect(settings.hasTouch).toBe(true);
    expect(settings.viewport).not.toEqual({ width: 999, height: 999 });
    expect(settings.userAgent).toMatch(/Android/);
  });

  it("phone settings come from config.phone when set", () => {
    const settings = deviceSettings("phone", {}, { phone: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, userAgent: "custom-ua" } });
    expect(settings).toEqual({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true, userAgent: "custom-ua" });
  });
});

describe("captureDirFor", () => {
  it("desktop keeps today's plain capture dir", () => {
    expect(captureDirFor("/build", "add-competitor", "desktop")).toBe("/build/add-competitor/capture");
  });
  it("phone gets its own subdir", () => {
    expect(captureDirFor("/build", "add-competitor", "phone")).toBe("/build/add-competitor/phone/capture");
  });
});

describe("stepsFor", () => {
  const steps: Step[] = [
    { actions: [] },
    { devices: ["phone"], actions: [] },
    { devices: ["desktop"], actions: [] },
  ];
  it("a step with no devices runs on every device", () => {
    expect(stepsFor({ steps }, "desktop")).toEqual([steps[0], steps[2]]);
    expect(stepsFor({ steps }, "phone")).toEqual([steps[0], steps[1]]);
  });
});

describe("primaryCaptureDir / ciCaptureDirFor", () => {
  it("is the primary device's own dir — <id>/phone/capture for a phone-primary walkthrough — so readers and writers agree", () => {
    expect(primaryCaptureDir({ buildDir: "/build" }, { walkthrough: "scan" })).toBe("/build/scan/capture");
    expect(primaryCaptureDir({ buildDir: "/build", devices: ["phone", "desktop"] }, { walkthrough: "scan" })).toBe("/build/scan/phone/capture");
    expect(primaryCaptureDir({ buildDir: "/build" }, { walkthrough: "scan", for: "office-staff" }, brief([{ role: "office-staff", name: "Alex", job: "runs the desk", devices: ["phone"] }]))).toBe(
      "/build/scan/phone/capture",
    );
    expect(ciCaptureDirFor("/build", "scan", "desktop")).toBe("/build/scan/ci/capture");
    expect(ciCaptureDirFor("/build", "scan", "phone")).toBe("/build/scan/ci/phone/capture");
  });
});
