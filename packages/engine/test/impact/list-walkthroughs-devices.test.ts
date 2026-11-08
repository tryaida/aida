// listWalkthroughs reads each walkthrough's capture from its primary device's dir (decision 40):
// a phone-primary walkthrough's own capture is `<id>/phone/capture`, where `aida build` writes it.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { listWalkthroughs } from "../../src/impact/walkthroughs.js";

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe("listWalkthroughs (primary device)", () => {
  it("reads a phone-primary walkthrough's manifest from <id>/phone/capture", () => {
    const root = mkdtempSync(join(tmpdir(), "aida-list-devices-"));
    dirs.push(root);
    const walkthroughsDir = join(root, "walkthroughs");
    const buildDir = join(root, ".build");
    mkdirSync(walkthroughsDir, { recursive: true });
    writeFileSync(join(walkthroughsDir, "scan.yaml"), ["walkthrough: scan", "title: Scan", "devices: [phone, desktop]", "steps:", "  - id: one", '    title: "One"'].join("\n"));
    for (const [dir, label] of [
      [join(buildDir, "scan", "capture"), "desktop"],
      [join(buildDir, "scan", "phone", "capture"), "phone"],
    ]) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "manifest.json"), JSON.stringify({ workflow: label, steps: [] }));
    }

    const [entry] = listWalkthroughs(walkthroughsDir, buildDir, { configDir: root });
    expect(entry.manifest?.workflow).toBe("phone");
  });
});
