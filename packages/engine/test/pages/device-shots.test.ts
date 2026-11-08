// M43b (decision 40): a step shown on more than one device — the reader-facing device-only
// note, secondary-device screenshot naming (and why it's safe from the PDF's STEP_IMG/
// PATH_STEP_IMG regexes), and stripping a `<DeviceShots>` wrapper down to its primary image.
import { describe, expect, it } from "vitest";
import {
  deviceOnlyNote,
  deviceShotsAttr,
  secondaryPathScreenshotFile,
  secondaryScreenshotFile,
  stripDeviceShots,
} from "../../src/pages/device-shots.js";

describe("deviceOnlyNote", () => {
  it("a phone-only step on a desktop+phone walkthrough", () => {
    expect(deviceOnlyNote(["phone"], ["desktop", "phone"])).toBe("On a phone only.");
  });

  it("a desktop-only step on a desktop+phone walkthrough", () => {
    expect(deviceOnlyNote(["desktop"], ["desktop", "phone"])).toBe("On a computer only.");
  });

  it("no note when the step has no devices restriction", () => {
    expect(deviceOnlyNote(undefined, ["desktop", "phone"])).toBeUndefined();
  });

  it("no note when the step names every device the walkthrough shows", () => {
    expect(deviceOnlyNote(["desktop", "phone"], ["desktop", "phone"])).toBeUndefined();
  });

  it("no note on a desktop-only walkthrough (nothing to contrast with)", () => {
    expect(deviceOnlyNote(["desktop"], ["desktop"])).toBeUndefined();
  });

  it("no note when the step names a device the walkthrough doesn't show at all", () => {
    expect(deviceOnlyNote(["tablet" as never], ["desktop", "phone"])).toBeUndefined();
  });
});

describe("secondaryScreenshotFile", () => {
  it("never matches the PDF's STEP_IMG regex (requires a literal slash right before step-)", () => {
    const STEP_IMG = /\/step-(\d+)\.png$/;
    expect(STEP_IMG.test(secondaryScreenshotFile("phone", 3))).toBe(false);
    expect(secondaryScreenshotFile("phone", 3)).toBe("screenshots/phone-step-03.png");
  });
});

describe("secondaryPathScreenshotFile", () => {
  it("never matches the PDF's PATH_STEP_IMG regex (requires /paths/<id>-step-NN.png, no further slash)", () => {
    const PATH_STEP_IMG = /\/paths\/([a-z0-9-]+)-step-(\d+)\.png$/;
    const file = secondaryPathScreenshotFile("phone", "add-competitor", 2);
    expect(file).toBe("screenshots/paths/phone/add-competitor-step-02.png");
    expect(PATH_STEP_IMG.test(file)).toBe(false);
  });
});

describe("deviceShotsAttr", () => {
  it("joins devices primary-first, comma separated", () => {
    expect(deviceShotsAttr(["desktop", "phone"])).toBe("desktop,phone");
    expect(deviceShotsAttr(["phone", "desktop"])).toBe("phone,desktop");
  });
});

describe("stripDeviceShots", () => {
  it("drops a <DeviceShots> wrapper down to its primary image", () => {
    const md = [
      "#### 1. Open Payments",
      "",
      "Click **Payments**.",
      "",
      '<DeviceShots devices="desktop,phone">',
      "",
      "![Screenshot of Payments](screenshots/step-01.png)",
      "",
      "![Phone screenshot of Payments](screenshots/phone-step-01.png)",
      "",
      "</DeviceShots>",
      "",
      "#### 2. Next step",
    ].join("\n");
    const stripped = stripDeviceShots(md);
    expect(stripped).toContain("![Screenshot of Payments](screenshots/step-01.png)");
    expect(stripped).not.toContain("phone-step-01.png");
    expect(stripped).not.toContain("DeviceShots");
  });

  it("leaves ordinary markdown (no wrapper) alone", () => {
    const md = "#### 1. Step\n\n![alt](screenshots/step-01.png)\n";
    expect(stripDeviceShots(md)).toBe(md);
  });

  it("removes a device-only step's lone secondary image (no primary, no wrapper)", () => {
    const md = ["#### 2. Open the menu", "", "*On a phone only.*", "", "![Phone screenshot of Menu](screenshots/phone-step-02.png)", "", "#### 3. Next"].join(
      "\n",
    );
    const stripped = stripDeviceShots(md);
    expect(stripped).not.toContain("phone-step-02.png");
    expect(stripped).toContain("*On a phone only.*");
    expect(stripped).toContain("#### 3. Next");
  });

  it("strips more than one wrapper in the same page", () => {
    const one = '<DeviceShots devices="desktop,phone">\n\n![a](screenshots/step-01.png)\n\n![b](screenshots/phone-step-01.png)\n\n</DeviceShots>\n';
    const two = '<DeviceShots devices="desktop,phone">\n\n![c](screenshots/step-02.png)\n\n![d](screenshots/phone-step-02.png)\n\n</DeviceShots>\n';
    const stripped = stripDeviceShots(`${one}\n${two}`);
    expect(stripped).toContain("![a](screenshots/step-01.png)");
    expect(stripped).toContain("![c](screenshots/step-02.png)");
    expect(stripped).not.toContain("phone-step");
  });
});
