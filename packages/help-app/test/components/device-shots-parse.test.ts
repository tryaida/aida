import { describe, expect, it } from "vitest";
import { activeDeviceIndex, parseDeviceList } from "../../components/device-shots-parse";

describe("parseDeviceList", () => {
  it("splits the engine's comma-separated attribute, primary first", () => {
    expect(parseDeviceList("desktop,phone")).toEqual(["desktop", "phone"]);
  });

  it("trims stray whitespace", () => {
    expect(parseDeviceList("desktop, phone")).toEqual(["desktop", "phone"]);
  });

  it("drops anything that isn't a known device", () => {
    expect(parseDeviceList("desktop,tablet,phone")).toEqual(["desktop", "phone"]);
  });

  it("a phone-primary walkthrough lists phone first", () => {
    expect(parseDeviceList("phone,desktop")).toEqual(["phone", "desktop"]);
  });
});

describe("activeDeviceIndex", () => {
  it("finds the chosen device's position", () => {
    expect(activeDeviceIndex(["desktop", "phone"], "phone")).toBe(1);
    expect(activeDeviceIndex(["desktop", "phone"], "desktop")).toBe(0);
  });

  it("falls back to the primary (0) when the chosen device isn't in this page's list", () => {
    expect(activeDeviceIndex(["desktop"], "phone")).toBe(0);
  });
});
